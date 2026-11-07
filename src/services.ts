import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, DisplayMode, DockEdge, RefreshResult } from "./types";

export const refreshUsage = () => invoke<RefreshResult>("get_usage");
export const loadSettings = () => invoke<AppSettings>("load_settings");
export const saveSettings = (settings: AppSettings) => invoke("save_settings", { settings });
export const setAlwaysOnTop = (enabled: boolean) => invoke("set_always_on_top", { enabled });
export const saveWindowPosition = (x: number, y: number) =>
  invoke("save_window_position", { x, y });
export const quitApplication = () => invoke("quit_app");
export const setDisplayMode = (mode: DisplayMode) => invoke("set_display_mode", { mode });
export const setWindowSize = (width: number, height: number) => invoke("set_window_size", { width, height });
export const startWindowDrag = () => invoke("start_window_drag");
export const dockWindow = (edge: DockEdge, width: number, height: number) =>
  invoke("dock_window", { edge, width, height });
export const cursorInWindow = () => invoke<[number, number]>("cursor_in_window");
export const setClickThrough = (enabled: boolean) => invoke("set_click_through", { enabled });
