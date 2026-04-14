use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_cli::CliExt;

// ── Settings ─────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub window_width: u32,
    pub window_height: u32,
    pub theme: String,
    pub full_width: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            window_width: 900,
            window_height: 700,
            theme: "dark".to_string(),
            full_width: false,
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
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            save_file,
            open_file,
            watch_current_file,
            get_cli_file,
            get_settings,
            save_settings,
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
                    "about-app" => { let _ = app_handle.emit("menu-about-app", ()); }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
