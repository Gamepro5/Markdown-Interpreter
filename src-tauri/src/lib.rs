mod updater;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_cli::CliExt;

// ── Settings ─────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub window_width: u32,
    pub window_height: u32,
    pub theme: String,
    pub full_width: bool,
    // Defaulted so a settings.json written before these existed still loads,
    // rather than failing to parse and resetting everything.
    #[serde(default = "default_true")]
    pub check_updates: bool,
    #[serde(default)]
    pub auto_update: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            window_width: 900,
            window_height: 700,
            theme: "dark".to_string(),
            full_width: false,
            check_updates: true,
            auto_update: false,
        }
    }
}

fn settings_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("markdown-interpreter");
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

fn load_settings() -> Settings {
    let path = settings_path();
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Settings::default()
    }
}

fn save_settings_to_disk(settings: &Settings) {
    let path = settings_path();
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(path, json);
    }
}

// ── App state ────────────────────────────────────────────────────────────────

struct AppState {
    current_file: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    cli_file: Mutex<Option<String>>,
    settings: Mutex<Settings>,
    /// The newer release the last check found.
    update: Mutex<Option<updater::Available>>,
    /// A verified installer to run silently once the app has closed.
    install_on_exit: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Serialize)]
struct FilePayload {
    content: String,
    path: String,
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(path: String, content: String, state: State<AppState>) -> Result<(), String> {
    {
        let mut watcher = state.watcher.lock().unwrap();
        *watcher = None;
    }
    fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_file(path: String, state: State<AppState>, app: AppHandle) -> Result<FilePayload, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let canon = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let path_str = canon.to_string_lossy().to_string();

    {
        let mut current = state.current_file.lock().unwrap();
        *current = Some(canon.clone());
    }

    if let Some(window) = app.get_webview_window("main") {
        let name = canon
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let _ = window.set_title(&format!("{} — Markdown Interpreter", name));
    }

    Ok(FilePayload {
        content,
        path: path_str,
    })
}

/// Open a file in a second, independent copy of the app, leaving this window
/// as it is. Each window owns its own current file and watcher, so a separate
/// process is simpler than sharing that state between windows.
#[tauri::command]
fn open_in_new_window(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("file not found: {}", path));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_cli_file(state: State<AppState>) -> Option<String> {
    state.cli_file.lock().unwrap().take()
}

#[tauri::command]
fn watch_current_file(state: State<AppState>, app: AppHandle) {
    let current_file = state.current_file.lock().unwrap().clone();

    if let Some(file_path) = current_file {
        let watch_path = file_path.clone();
        let app_handle = app.clone();
        let mut watcher_lock = state.watcher.lock().unwrap();

        let watcher = notify::recommended_watcher(move |res: Result<Event, _>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Modify(_)) {
                    if let Ok(content) = fs::read_to_string(&watch_path) {
                        let _ = app_handle.emit("file-changed", content);
                    }
                }
            }
        });

        if let Ok(mut w) = watcher {
            let _ = w.watch(file_path.as_path(), RecursiveMode::NonRecursive);
            *watcher_lock = Some(w);
        }
    }
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(settings: Settings, state: State<AppState>, app: AppHandle) -> Result<(), String> {
    // Resize the window to match new settings
    if let Some(window) = app.get_webview_window("main") {
        let size = tauri::PhysicalSize::new(settings.window_width, settings.window_height);
        let _ = window.set_size(tauri::Size::Physical(size));
    }

    save_settings_to_disk(&settings);
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

// ── Updates ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<Option<updater::UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let query = current.clone();
    let found = tauri::async_runtime::spawn_blocking(move || updater::check(&query))
        .await
        .map_err(|e| e.to_string())??;
    let info = found.as_ref().map(|a| a.info(&current));
    *app.state::<AppState>().update.lock().unwrap() = found;
    Ok(info)
}

/// Download, verify and apply the update the last check found.
///
/// `now` runs the Windows installer straight away and closes the app, which
/// the installer then relaunches. Otherwise the installer waits for the app to
/// be closed and runs silently. Returns `"restarting"`, `"on-exit"` or
/// `"replaced"` (AppImage: the next launch is the new version).
#[tauri::command]
async fn install_update(now: bool, app: AppHandle) -> Result<String, String> {
    let available = app
        .state::<AppState>()
        .update
        .lock()
        .unwrap()
        .clone()
        .ok_or("no update has been found to install")?;
    let prepared = tauri::async_runtime::spawn_blocking(move || updater::prepare(&available))
        .await
        .map_err(|e| e.to_string())??;

    match prepared {
        updater::Prepared::Replaced => Ok("replaced".into()),
        updater::Prepared::Installer(path) if now => {
            updater::run_installer(&path, true)?;
            // The installer closes a running copy itself, but leaving first is
            // tidier than being killed.
            app.exit(0);
            Ok("restarting".into())
        }
        updater::Prepared::Installer(path) => {
            *app.state::<AppState>().install_on_exit.lock().unwrap() = Some(path);
            Ok("on-exit".into())
        }
    }
}

// ── Menu ─────────────────────────────────────────────────────────────────────

fn build_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .item(
            &SubmenuBuilder::new(app, "File")
                .item(&MenuItemBuilder::with_id("open", "Open...").accelerator("CmdOrCtrl+O").build(app)?)
                .item(&MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("settings", "Settings").accelerator("CmdOrCtrl+,").build(app)?)
                .separator()
                .quit()
                .build()?,
        )
        .item(
            &SubmenuBuilder::new(app, "Edit")
                .item(&MenuItemBuilder::with_id("toggle-edit", "Toggle Edit Mode").accelerator("CmdOrCtrl+E").build(app)?)
                .separator()
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?,
        )
        .item(
            &SubmenuBuilder::new(app, "View")
                .item(&MenuItemBuilder::with_id("zoom-in", "Zoom In").accelerator("CmdOrCtrl+=").build(app)?)
                .item(&MenuItemBuilder::with_id("zoom-out", "Zoom Out").accelerator("CmdOrCtrl+-").build(app)?)
                .item(&MenuItemBuilder::with_id("zoom-reset", "Reset Zoom").accelerator("CmdOrCtrl+0").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("fullscreen", "Toggle Fullscreen").accelerator("F11").build(app)?)
                .build()?,
        )
        .item(
            &SubmenuBuilder::new(app, "About")
                .item(&MenuItemBuilder::with_id("about-hotkeys", "Keyboard Shortcuts").build(app)?)
                .item(&MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?)
                .item(&MenuItemBuilder::with_id("about-app", "About Markdown Interpreter").build(app)?)
                .build()?,
        )
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

// ── Run ──────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMABUF renderer crashes on many Wayland compositors
    // ("Error 71 (Protocol error) dispatching to Wayland display"). Disable it
    // before any GTK/WebKit code initializes.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    // Installers from an earlier update have finished with their files.
    updater::cleanup();

    let initial_settings = load_settings();
    let win_w = initial_settings.window_width;
    let win_h = initial_settings.window_height;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            current_file: Mutex::new(None),
            watcher: Mutex::new(None),
            cli_file: Mutex::new(None),
            settings: Mutex::new(initial_settings),
            update: Mutex::new(None),
            install_on_exit: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            save_file,
            open_file,
            open_in_new_window,
            watch_current_file,
            get_cli_file,
            get_settings,
            save_settings,
            check_for_update,
            install_update,
        ])
        .setup(move |app| {
            // Build native menu
            let _ = build_menu(app.handle());

            // Apply saved window size
            if let Some(window) = app.get_webview_window("main") {
                let size = tauri::PhysicalSize::new(win_w, win_h);
                let _ = window.set_size(tauri::Size::Physical(size));
            }

            // Store CLI file path
            if let Ok(matches) = app.cli().matches() {
                if let Some(args) = matches.args.get("file") {
                    if let serde_json::Value::String(path) = &args.value {
                        if !path.is_empty() && std::path::Path::new(path).exists() {
                            let state = app.state::<AppState>();
                            *state.cli_file.lock().unwrap() = Some(path.to_string());
                        }
                    }
                }
            }

            // Handle menu events
            app.on_menu_event(|app_handle, event| {
                match event.id().as_ref() {
                    "open" => { let _ = app_handle.emit("menu-open", ()); }
                    "save" => { let _ = app_handle.emit("menu-save", ()); }
                    "settings" => { let _ = app_handle.emit("menu-settings", ()); }
                    "toggle-edit" => { let _ = app_handle.emit("menu-toggle-edit", ()); }
                    "zoom-in" => { let _ = app_handle.emit("menu-zoom-in", ()); }
                    "zoom-out" => { let _ = app_handle.emit("menu-zoom-out", ()); }
                    "zoom-reset" => { let _ = app_handle.emit("menu-zoom-reset", ()); }
                    "fullscreen" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let is_full = window.is_fullscreen().unwrap_or(false);
                            let _ = window.set_fullscreen(!is_full);
                        }
                    }
                    "about-hotkeys" => { let _ = app_handle.emit("menu-about-hotkeys", ()); }
                    "check-updates" => { let _ = app_handle.emit("menu-check-updates", ()); }
                    "about-app" => { let _ = app_handle.emit("menu-about-app", ()); }
                    _ => {}
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // An automatic update waits for the app to close, so it never
            // interrupts anyone mid-edit.
            if let RunEvent::Exit = event {
                if let Some(path) = app.state::<AppState>().install_on_exit.lock().unwrap().take() {
                    let _ = updater::run_installer(&path, false);
                }
            }
        });
}
