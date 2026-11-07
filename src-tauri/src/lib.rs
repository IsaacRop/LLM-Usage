mod providers;
mod settings;

use providers::{ClaudeProvider, CodexProvider, GeminiProvider, ProviderUsage, UsageProvider};
use settings::{AppSettings, DisplayMode, DockEdge, SettingsStore};
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    State, Window,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone)]
struct Store(Arc<SettingsStore>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshResult {
    providers: Vec<ProviderUsage>,
    fetched_at: String,
}

const TOGGLE_SHORTCUT: &str = "CTRL+ALT+L";

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(true) {
            let _ = window.hide();
        } else {
            show_window(app);
        }
    }
}

#[tauri::command]
fn get_usage(store: State<'_, Store>) -> RefreshResult {
    let enabled = store.0.load().visible_providers;
    let is_enabled = |provider: &str| enabled.iter().any(|item| item == provider);
    let codex = is_enabled("codex").then(|| std::thread::spawn(|| CodexProvider.get_usage()));
    let claude = is_enabled("claude").then(|| std::thread::spawn(|| ClaudeProvider.get_usage()));
    let gemini = is_enabled("gemini").then(|| std::thread::spawn(|| GeminiProvider.get_usage()));
    let mut providers = Vec::new();
    if let Some(codex) = codex {
        providers.push(
            codex
                .join()
                .unwrap_or_else(|_| CodexProvider.unavailable("collector crashed"))
                .into_usage(),
        );
    }
    if let Some(claude) = claude {
        providers.push(
            claude
                .join()
                .unwrap_or_else(|_| ClaudeProvider.unavailable("collector crashed"))
                .into_usage(),
        );
    }
    if let Some(gemini) = gemini {
        providers.push(
            gemini
                .join()
                .unwrap_or_else(|_| GeminiProvider.unavailable("collector crashed"))
                .into_usage(),
        );
    }
    RefreshResult {
        providers,
        fetched_at: providers::now_iso(),
    }
}

#[tauri::command]
fn load_settings(store: State<'_, Store>) -> AppSettings {
    store.0.load()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    store: State<'_, Store>,
    settings: AppSettings,
) -> Result<(), String> {
    store.0.save(&settings)?;
    apply_window_preferences(&app, &settings);
    Ok(())
}

#[tauri::command]
fn save_window_position(store: State<'_, Store>, x: i32, y: i32) -> Result<(), String> {
    store.0.update_position(x, y)
}

#[tauri::command]
fn set_always_on_top(window: Window, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_window_size(window: Window, width: u32, height: u32) -> Result<(), String> {
    window
        .set_size(Size::Logical(LogicalSize::new(width as f64, height as f64)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_window_drag(window: Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_display_mode(store: State<'_, Store>, mode: DisplayMode) -> Result<(), String> {
    store.0.update_mode(mode)
}

/// Sizes the window (logical px) and places it flush against the center of
/// the chosen work-area edge of the monitor the window currently lives on.
#[tauri::command]
fn dock_window(window: Window, edge: DockEdge, width: f64, height: f64) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor available".to_string())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let w = (width * scale).round().max(1.0) as i32;
    let h = (height * scale).round().max(1.0) as i32;
    let (ax, ay) = (area.position.x, area.position.y);
    let (aw, ah) = (area.size.width as i32, area.size.height as i32);
    let (x, y) = match edge {
        DockEdge::Right => (ax + aw - w, ay + (ah - h) / 2),
        DockEdge::Left => (ax, ay + (ah - h) / 2),
        DockEdge::Top => (ax + (aw - w) / 2, ay),
        DockEdge::Bottom => (ax + (aw - w) / 2, ay + ah - h),
    };
    window
        .set_size(Size::Physical(PhysicalSize::new(w as u32, h as u32)))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition { x, y }))
        .map_err(|error| error.to_string())
}

/// Global cursor position relative to the window origin, in logical px.
/// Used for hover detection while the window is click-through.
#[tauri::command]
fn cursor_in_window(window: Window) -> Result<(f64, f64), String> {
    let cursor = window.cursor_position().map_err(|error| error.to_string())?;
    let origin = window.inner_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    Ok((
        (cursor.x - origin.x as f64) / scale,
        (cursor.y - origin.y as f64) / scale,
    ))
}

#[tauri::command]
fn set_click_through(window: Window, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn apply_window_preferences(app: &AppHandle, settings: &AppSettings) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(settings.always_on_top);
        // Docked windows are positioned by `dock_window`; never pull them
        // back to the saved free-floating position.
        if settings.mode == DisplayMode::Docked {
            return;
        }
        if let (Some(x), Some(y)) = (settings.position_x, settings.position_y) {
            let size = window.outer_size().unwrap_or(PhysicalSize {
                width: 280,
                height: 440,
            });
            let width = size.width;
            let height = size.height;
            let monitor = window
                .available_monitors()
                .ok()
                .and_then(|monitors| {
                    monitors.into_iter().find(|monitor| {
                        let area = monitor.work_area();
                        x >= area.position.x
                            && x < area.position.x + area.size.width as i32
                            && y >= area.position.y
                            && y < area.position.y + area.size.height as i32
                    })
                })
                .or_else(|| window.current_monitor().ok().flatten());
            let (min_x, min_y, max_x, max_y) = monitor
                .map(|monitor| {
                    let area = monitor.work_area();
                    (
                        area.position.x,
                        area.position.y,
                        area.position.x + area.size.width as i32 - width as i32,
                        area.position.y + area.size.height as i32 - height as i32,
                    )
                })
                .unwrap_or((0, 0, 0, 0));
            let _ = window.set_position(Position::Physical(PhysicalPosition {
                x: x.clamp(min_x, max_x.max(min_x)),
                y: y.clamp(min_y, max_y.max(min_y)),
            }));
        } else if let Ok(Some(monitor)) = window.current_monitor() {
            let area = monitor.work_area();
            let size = window.outer_size().unwrap_or(PhysicalSize {
                width: 280,
                height: 440,
            });
            let x = area.position.x + area.size.width as i32 - size.width as i32 - 18;
            let y = area.position.y + area.size.height as i32 - size.height as i32 - 18;
            let _ = window.set_position(Position::Physical(PhysicalPosition { x, y }));
        }
    }
}

fn tray_icon() -> tauri::image::Image<'static> {
    let size = 32u32;
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let first_bar = (7..12).contains(&x) && (16..26).contains(&y);
            let second_bar = (14..19).contains(&x) && (7..26).contains(&y);
            let third_bar = (21..26).contains(&x) && (12..26).contains(&y);
            if first_bar || second_bar || third_bar {
                let index = ((y * size + x) * 4) as usize;
                pixels[index] = 245;
                pixels[index + 1] = 245;
                pixels[index + 2] = 247;
                pixels[index + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(pixels, size, size)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let store = Arc::new(SettingsStore::new(
                app.path()
                    .app_config_dir()
                    .map_err(|error| error.to_string())?,
            ));
            let current = store.load();
            app.manage(Store(store));
            apply_window_preferences(app.handle(), &current);

            let toggle = MenuItemBuilder::with_id(
                "toggle",
                format!("Show / hide widget  {TOGGLE_SHORTCUT}"),
            )
            .build(app)?;
            let refresh = MenuItemBuilder::with_id("refresh", "Refresh now").build(app)?;
            let normal = MenuItemBuilder::with_id("mode-normal", "Normal mode").build(app)?;
            let mini = MenuItemBuilder::with_id("mode-mini", "Mini mode").build(app)?;
            let collapsed =
                MenuItemBuilder::with_id("mode-collapsed", "Collapsed mode").build(app)?;
            let docked = MenuItemBuilder::with_id("mode-docked", "Dock to screen edge").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&toggle, &refresh, &normal, &mini, &collapsed, &docked, &quit])
                .build()?;

            let _tray = TrayIconBuilder::with_id("llm-usage-tray")
                .icon(tray_icon())
                .tooltip("LLM Usage")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => toggle_window(app),
                    "refresh" => {
                        let _ = app.emit("tray-refresh", ());
                    }
                    "mode-normal" => {
                        let _ = app.emit("tray-mode", "normal");
                        show_window(app);
                    }
                    "mode-mini" => {
                        let _ = app.emit("tray-mode", "mini");
                        show_window(app);
                    }
                    "mode-collapsed" => {
                        let _ = app.emit("tray-mode", "collapsed");
                        show_window(app);
                    }
                    "mode-docked" => {
                        let _ = app.emit("tray-mode", "docked");
                        show_window(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            if let Err(error) = app.global_shortcut().register(TOGGLE_SHORTCUT) {
                eprintln!("Could not register global shortcut {TOGGLE_SHORTCUT}: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_usage,
            load_settings,
            save_settings,
            save_window_position,
            set_always_on_top,
            set_window_size,
            start_window_drag,
            set_display_mode,
            dock_window,
            cursor_in_window,
            set_click_through,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running LLM Usage");
}
