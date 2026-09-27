//! Keeping Markdown Interpreter up to date.
//!
//! Modelled on Modifile's self-update:
//!
//! - **Nothing runs in the background.** One request to GitHub when the app
//!   starts, or when you ask from the About menu.
//! - **The download is verified before it is used.** GitHub publishes a SHA-256
//!   for every release asset, and each release carries a `SHA256SUMS.txt` too.
//!   Both are checked, and a release offering neither is refused.
//! - **Nothing is replaced without consent**, unless automatic installs are
//!   turned on in Settings.
//!
//! How an update is applied depends on how the app was installed:
//!
//! - **Windows**: the release's NSIS installer is run. It installs per-user, so
//!   no admin prompt, and it also turns a loose copy of the exe into a proper
//!   install with a Start menu entry and an uninstaller.
//! - **Linux AppImage**: the new AppImage is written beside the old one and
//!   renamed over it.
//! - **.deb / .rpm**: those belong to the package manager, so the release page
//!   is opened instead.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "Gamepro5/Markdown-Interpreter";

// ── GitHub API ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    /// `sha256:<hex>`. Older releases predate GitHub publishing this.
    #[serde(default)]
    pub digest: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .user_agent(concat!("markdown-interpreter/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

// ── Checking ─────────────────────────────────────────────────────────────────

/// How this copy of the app can be updated.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    WindowsInstaller,
    AppImage,
    /// Only a link to the release page.
    Manual,
}

fn method() -> Method {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Method::WindowsInstaller
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64"))
        && std::env::var_os("APPIMAGE").is_some()
    {
        Method::AppImage
    } else {
        Method::Manual
    }
}

fn wanted_asset(name: &str, method: Method) -> bool {
    let lower = name.to_ascii_lowercase();
    match method {
        Method::WindowsInstaller => lower.ends_with("-x86_64-setup.exe"),
        Method::AppImage => lower.ends_with("-x86_64.appimage"),
        Method::Manual => false,
    }
}

/// A release newer than the one running.
#[derive(Clone)]
pub struct Available {
    pub version: String,
    pub web_url: String,
    /// `None` when there is nothing this copy can install by itself.
    pub asset: Option<Asset>,
    pub checksums: Option<Asset>,
}

/// What the frontend is told about an update.
#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub web_url: String,
    pub can_install: bool,
    pub size: u64,
    /// Installing on Windows closes the app, so the UI words it differently.
    pub restarts: bool,
}

impl Available {
    pub fn info(&self, current: &str) -> UpdateInfo {
        UpdateInfo {
            version: self.version.clone(),
            current: current.to_string(),
            web_url: self.web_url.clone(),
            can_install: self.asset.is_some(),
            size: self.asset.as_ref().map_or(0, |a| a.size),
            restarts: method() == Method::WindowsInstaller,
        }
    }
}

/// Ask GitHub whether there is a newer release than `current`.
///
/// `releases/latest` skips drafts and prereleases, which is what the release
/// workflow relies on: it publishes drafts, so nothing is offered to anyone
/// until it has been looked at and published by hand.
pub fn check(current: &str) -> Result<Option<Available>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let mut resp = agent()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| match e {
            // No release published yet.
            ureq::Error::StatusCode(404) => "no releases have been published yet".to_string(),
            other => format!("could not reach GitHub: {other}"),
        })?;
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("reading GitHub's reply: {e}"))?;
    let release: Release =
        serde_json::from_str(&text).map_err(|e| format!("unexpected reply from GitHub: {e}"))?;

    if release.draft || release.prerelease || !is_newer(&release.tag_name, current) {
        return Ok(None);
    }

    let method = method();
    Ok(Some(Available {
        version: display_version(&release.tag_name),
        web_url: release.html_url,
        asset: release
            .assets
            .iter()
            .find(|a| wanted_asset(&a.name, method))
            .cloned(),
        checksums: release
            .assets
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case("SHA256SUMS.txt"))
            .cloned(),
    }))
}

// ── Versions ─────────────────────────────────────────────────────────────────

/// Is `candidate` newer than `current`? Tolerant of `v1.0`, `1.0.0` and
/// `1.2.3-beta.1`: missing components count as zero, and a release beats its
/// own prereleases.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (a_nums, a_pre) = split_version(candidate);
    let (b_nums, b_pre) = split_version(current);
    for i in 0..a_nums.len().max(b_nums.len()) {
        let left = a_nums.get(i).copied().unwrap_or(0);
        let right = b_nums.get(i).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    match (a_pre.is_empty(), b_pre.is_empty()) {
        (true, false) => true,
        (false, false) => a_pre > b_pre,
        _ => false,
    }
}

fn split_version(text: &str) -> (Vec<u64>, String) {
    let text = text.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match text.find(['-', '+']) {
        Some(at) => (&text[..at], text[at + 1..].to_string()),
        None => (text, String::new()),
    };
    let nums = core
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect();
    (nums, pre)
}

fn display_version(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).to_string()
}

// ── Downloading ──────────────────────────────────────────────────────────────

/// Where downloaded installers wait to be run. Cleared at startup.
pub fn staging_dir() -> PathBuf {
    std::env::temp_dir().join("markdown-interpreter-update")
}

/// Remove installers left from a previous update. Best effort.
///
/// Only old ones: every opened file is its own process, and another copy of the
/// app may be holding an installer it means to run when it closes.
pub fn cleanup() {
    let Ok(entries) = std::fs::read_dir(staging_dir()) else {
        return;
    };
    let day = Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > day);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Download `asset` to `dest` and check it against everything the release
/// publishes about it. A mismatching file is deleted, never returned.
fn download_verified(available: &Available, asset: &Asset, dest: &Path) -> Result<(), String> {
    let digest = asset
        .digest
        .as_deref()
        .map(|d| d.trim_start_matches("sha256:").to_ascii_lowercase());
    let listed = available
        .checksums
        .as_ref()
        .and_then(|c| fetch_text(&c.browser_download_url).ok())
        .and_then(|text| find_checksum(&text, &asset.name));

    if digest.is_none() && listed.is_none() {
        return Err(format!(
            "release {} publishes no checksum for {}, so the download cannot be verified. \
             Download it yourself from {} if you are sure.",
            available.version, asset.name, available.web_url
        ));
    }

    let actual = download_to(&asset.browser_download_url, dest)?;
    for expected in [digest, listed].into_iter().flatten() {
        if !expected.eq_ignore_ascii_case(&actual) {
            let _ = std::fs::remove_file(dest);
            return Err(format!(
                "{} did not match its published checksum (expected {expected}, got {actual}). \
                 Nothing was installed.",
                asset.name
            ));
        }
    }
    Ok(())
}

fn fetch_text(url: &str) -> Result<String, String> {
    agent()
        .get(url)
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())
}

/// Stream `url` into `dest`, returning the SHA-256 of what was written.
fn download_to(url: &str, dest: &Path) -> Result<String, String> {
    let resp = agent()
        .get(url)
        .call()
        .map_err(|e| format!("downloading the update: {e}"))?;
    let mut reader = resp.into_body().into_reader();
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("writing {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let result = (|| -> std::io::Result<()> {
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n])?;
        }
        file.flush()
    })();
    if let Err(e) = result {
        drop(file);
        let _ = std::fs::remove_file(dest);
        return Err(format!("downloading the update: {e}"));
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Pull one file's hash out of a `sha256sum` listing.
fn find_checksum(text: &str, file_name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (hash, name) = (parts.next()?, parts.next()?);
        // sha256sum writes " *name" in binary mode.
        name.trim_start_matches('*')
            .eq_ignore_ascii_case(file_name)
            .then(|| hash.to_ascii_lowercase())
    })
}

// ── Installing ───────────────────────────────────────────────────────────────

/// What `prepare` left ready to go.
pub enum Prepared {
    /// A verified Windows installer, waiting to be run.
    Installer(PathBuf),
    /// The AppImage has already been replaced; the next launch is the new one.
    Replaced,
}

/// Download and verify the update, and on Linux put it in place.
pub fn prepare(available: &Available) -> Result<Prepared, String> {
    let asset = available.asset.as_ref().ok_or_else(|| {
        format!(
            "this copy cannot update itself. Download {} from {}",
            available.version, available.web_url
        )
    })?;

    match method() {
        Method::WindowsInstaller => {
            let dir = staging_dir();
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("creating {}: {e}", dir.display()))?;
            // Per process, so two open windows updating at once do not write
            // over each other's download.
            let dest = dir.join(format!("{}-{}", std::process::id(), asset.name));
            download_verified(available, asset, &dest)?;
            Ok(Prepared::Installer(dest))
        }
        Method::AppImage => {
            let target = PathBuf::from(
                std::env::var_os("APPIMAGE").ok_or("APPIMAGE is not set")?,
            );
            // Beside the target, so the final rename stays on one filesystem.
            let staged = target.with_extension("AppImage.new");
            download_verified(available, asset, &staged).map_err(|e| {
                if e.contains("writing") {
                    format!(
                        "{e}. The folder holding the AppImage has to be writable for it to \
                         update itself."
                    )
                } else {
                    e
                }
            })?;
            make_executable(&staged);
            // Linux lets a running file be replaced: the old inode lives on
            // until this process exits.
            std::fs::rename(&staged, &target).map_err(|e| {
                let _ = std::fs::remove_file(&staged);
                format!("replacing {}: {e}", target.display())
            })?;
            Ok(Prepared::Replaced)
        }
        Method::Manual => unreachable!("no asset is chosen for manual updates"),
    }
}

/// Start the Windows installer.
///
/// `interactive` shows its progress window and relaunches the app when done;
/// otherwise it runs silently, which is what an install-on-exit wants.
pub fn run_installer(path: &Path, interactive: bool) -> Result<(), String> {
    let args: &[&str] = if interactive { &["/P", "/R"] } else { &["/S"] };
    std::process::Command::new(path)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("starting the installer: {e}"))
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("v1.10.0", "1.9.0"));
        assert!(!is_newer("v1.0.0", "1.0.0"));
        assert!(!is_newer("1.0", "1.0.0"));
        assert!(!is_newer("0.9.9", "1.0.0"));
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer("1.0.0-beta.1", "1.0.0"));
    }

    #[test]
    fn checksums_are_read_from_a_sha256sum_listing() {
        let listing = "ABC123  Markdown-Interpreter-1.0.1-x86_64-setup.exe\n\
                       def456 *Markdown-Interpreter-1.0.1-x86_64.AppImage\n";
        assert_eq!(
            find_checksum(listing, "Markdown-Interpreter-1.0.1-x86_64-setup.exe").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            find_checksum(listing, "Markdown-Interpreter-1.0.1-x86_64.AppImage").as_deref(),
            Some("def456")
        );
        assert_eq!(find_checksum(listing, "other.deb"), None);
    }

    #[test]
    fn only_the_right_installer_is_picked() {
        let win = Method::WindowsInstaller;
        assert!(wanted_asset("Markdown-Interpreter-1.0.1-x86_64-setup.exe", win));
        assert!(!wanted_asset("Markdown-Interpreter-1.0.1-x86_64.deb", win));
        assert!(!wanted_asset("SHA256SUMS.txt", win));
        let app = Method::AppImage;
        assert!(wanted_asset("Markdown-Interpreter-1.0.1-x86_64.AppImage", app));
        assert!(!wanted_asset("Markdown-Interpreter-1.0.1-x86_64.rpm", app));
    }
}
