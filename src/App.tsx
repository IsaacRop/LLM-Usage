import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { PixelBar } from "./components/PixelBar";
import { ProviderCard } from "./components/ProviderCard";
import { loadSettings, quitApplication, refreshUsage, saveSettings, saveWindowPosition, setAlwaysOnTop, setDisplayMode, setWindowSize, startWindowDrag } from "./services";
import type { AppSettings, DisplayMode, ProviderName, ProviderStatus, ProviderUsage, RefreshResult } from "./types";

const DEFAULT_SETTINGS: AppSettings = {
  mode: "normal",
  opacity: 1,
  refreshIntervalSeconds: 60,
  alwaysOnTop: true,
  launchOnStartup: false,
  normalWidth: 280,
  normalHeight: 440
};

type Slot = { lastGood?: ProviderUsage; latest?: ProviderUsage; issue?: string; refreshing: boolean };
type Slots = Record<ProviderName, Slot>;

const initialSlots: Slots = { codex: { refreshing: false }, claude: { refreshing: false } };

function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function relativeTime(updatedAt: string | undefined, now: number) {
  if (!updatedAt) return "—";
  const seconds = Math.max(0, Math.floor((now - new Date(updatedAt).getTime()) / 1000));
  if (seconds < 10) return "JUST NOW";
  if (seconds < 60) return `${seconds}s AGO`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m AGO`;
  return `${Math.floor(minutes / 60)}h AGO`;
}

function normalizeProvider(result: RefreshResult, provider: ProviderName) {
  return result.providers.find((item) => item.provider === provider);
}

function nextReset(slots: Slots) {
  const values = Object.values(slots)
    .map((slot) => slot.lastGood?.windows[0]?.resetsAt)
    .filter((value): value is string => Boolean(value));
  return values.sort()[0];
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [slots, setSlots] = useState<Slots>(initialSlots);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const now = useClock();
  const resetRefreshRef = useRef<string | undefined>(undefined);
  const currentWindow = useMemo(() => getCurrentWindow(), []);

  const resizeForMode = useCallback(async (mode: DisplayMode, normalWidth = 280, normalHeight = 440) => {
    const sizes: Record<DisplayMode, [number, number]> = { normal: [normalWidth, normalHeight], mini: [248, 78], collapsed: [210, 42] };
    const [width, height] = sizes[mode];
    try {
      await setWindowSize(width, height);
    } catch {
      // The CSS mode remains useful if native resizing is not available in a preview environment.
    }
  }, []);

  const applyMode = useCallback(async (mode: DisplayMode) => {
    setSettings((previous) => ({ ...previous, mode }));
    await setDisplayMode(mode).catch(() => undefined);
    // Keep the settings panel usable while a new mode is selected. The
    // compact native size is applied when the panel is closed.
    if (settingsOpen) {
      await setWindowSize(settings.normalWidth, settings.normalHeight).catch(() => undefined);
    } else {
      await resizeForMode(mode, settings.normalWidth, settings.normalHeight);
    }
  }, [resizeForMode, settings.normalHeight, settings.normalWidth, settingsOpen]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setSlots((previous) => ({ codex: { ...previous.codex, refreshing: true }, claude: { ...previous.claude, refreshing: true } }));
    try {
      const result = await refreshUsage();
      setSlots((previous) => {
        const updated = { ...previous };
        (['codex', 'claude'] as ProviderName[]).forEach((provider) => {
          const usage = normalizeProvider(result, provider);
          const hasData = Boolean(usage && usage.windows.length > 0 && (usage.status === "available" || usage.status === "partial"));
          updated[provider] = {
            latest: usage,
            lastGood: hasData ? usage : previous[provider].lastGood,
            issue: hasData ? undefined : usage?.message ?? usage?.status,
            refreshing: false
          };
        });
        return updated;
      });
    } catch (error) {
      const issue = error instanceof Error ? error.message : "Refresh failed";
      setSlots((previous) => ({
        codex: { ...previous.codex, issue, refreshing: false },
        claude: { ...previous.claude, issue, refreshing: false }
      }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSettings().then((loaded) => {
      const merged = { ...DEFAULT_SETTINGS, ...loaded };
      setSettings(merged);
      setReady(true);
      void resizeForMode(merged.mode, merged.normalWidth, merged.normalHeight);
      void refresh();
    }).catch(() => {
      setReady(true);
      void refresh();
    });
  }, [refresh, resizeForMode]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => void refresh(), Math.max(30, settings.refreshIntervalSeconds) * 1000);
    return () => window.clearInterval(timer);
  }, [ready, refresh, settings.refreshIntervalSeconds]);

  useEffect(() => {
    const resetAt = nextReset(slots);
    if (!resetAt || resetRefreshRef.current === resetAt) return;
    const delay = new Date(resetAt).getTime() - Date.now() + 750;
    if (delay <= 0) {
      resetRefreshRef.current = resetAt;
      void refresh();
      return;
    }
    const timer = window.setTimeout(() => {
      resetRefreshRef.current = resetAt;
      void refresh();
    }, Math.min(delay, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [slots, refresh]);

  useEffect(() => {
    let unlistenMove: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenMode: (() => void) | undefined;
    let positionTimer: number | undefined;
    void currentWindow.onMoved(({ payload }) => {
      const position = payload as { x: number; y: number };
      window.clearTimeout(positionTimer);
      positionTimer = window.setTimeout(() => void saveWindowPosition(position.x, position.y), 250);
    }).then((unlisten) => { unlistenMove = unlisten; });
    void listen("tray-refresh", () => void refresh()).then((unlisten) => { unlistenRefresh = unlisten; });
    void listen<DisplayMode>("tray-mode", (event) => void applyMode(event.payload)).then((unlisten) => { unlistenMode = unlisten; });
    return () => {
      unlistenMove?.();
      window.clearTimeout(positionTimer);
      unlistenRefresh?.();
      unlistenMode?.();
    };
  }, [applyMode, currentWindow, refresh]);

  useEffect(() => {
    let unlistenResize: (() => void) | undefined;
    let resizeTimer: number | undefined;
    void currentWindow.onResized(({ payload }) => {
      if (settings.mode !== "normal") return;
      const size = payload as { width: number; height: number };
      if (size.width < 240 || size.height < 260) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const next = { ...settings, normalWidth: Math.round(size.width), normalHeight: Math.round(size.height) };
        setSettings(next);
        void saveSettings(next).catch(() => undefined);
      }, 300);
    }).then((unlisten) => { unlistenResize = unlisten; });
    return () => {
      unlistenResize?.();
      window.clearTimeout(resizeTimer);
    };
  }, [currentWindow, settings]);

  const setPreference = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    await saveSettings(next).catch(() => undefined);
  };

  const resizeNormal = async (width: number, height: number) => {
    const next = { ...settings, normalWidth: width, normalHeight: height, mode: "normal" as DisplayMode };
    setSettings(next);
    await saveSettings(next).catch(() => undefined);
    await setDisplayMode("normal").catch(() => undefined);
    await setWindowSize(width, height).catch(() => undefined);
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    // Mini and collapsed windows are intentionally too short for the panel.
    // Temporarily give the panel the normal working area while preserving the
    // selected display mode; closing it restores the compact size.
    if (settings.mode !== "normal") {
      await setWindowSize(settings.normalWidth, settings.normalHeight).catch(() => undefined);
    }
  };

  const closeSettings = async () => {
    setSettingsOpen(false);
    await resizeForMode(settings.mode, settings.normalWidth, settings.normalHeight);
  };

  const beginDrag = (event: React.MouseEvent) => {
    if (event.button === 0) void startWindowDrag().catch(() => undefined);
  };

  const togglePin = async () => {
    const next = !settings.alwaysOnTop;
    setSettings((previous) => ({ ...previous, alwaysOnTop: next }));
    await setAlwaysOnTop(next).catch(() => undefined);
    await saveSettings({ ...settings, alwaysOnTop: next }).catch(() => undefined);
  };

  const currentStatus = (provider: ProviderName): ProviderStatus | "stale" | "refreshing" => {
    const slot = slots[provider];
    if (slot.refreshing && slot.lastGood) return "refreshing";
    if (slot.lastGood && slot.issue) return "stale";
    return slot.latest?.status ?? "unavailable";
  };

  const displayUsage = (provider: ProviderName) => slots[provider].lastGood ?? slots[provider].latest;
  const updatedAt = slots.codex.lastGood?.updatedAt ?? slots.claude.lastGood?.updatedAt;
  const footerStatus = refreshing ? "REFRESHING" : slots.codex.issue || slots.claude.issue ? "STALE / CHECK" : "LIVE";

  return (
    <div className={`app-shell mode-${settings.mode}`} style={{ opacity: settings.opacity }}>
      <header className="topbar" data-tauri-drag-region onMouseDown={beginDrag} onDoubleClick={() => void applyMode(settings.mode === "normal" ? "mini" : "normal")}>
        <div className="brand"><span className="brand-mark">+</span><span>AI LIMITS</span><small>LOCAL MONITOR</small></div>
        <div className="top-actions" data-tauri-drag-region="false" onMouseDown={(event) => event.stopPropagation()}>
          <button className={`icon-button ${refreshing ? "is-spinning" : ""}`} onClick={() => void refresh()} title="Refresh now" aria-label="Refresh now">↻</button>
          <button className="icon-button" onClick={() => void (settingsOpen ? closeSettings() : openSettings())} title="Settings" aria-label="Settings">⚙</button>
        </div>
      </header>

      {settings.mode === "collapsed" ? (
        <div className="collapsed-content" onMouseDown={beginDrag}>
          <div className="collapsed-provider provider--codex"><b>C</b><span>{displayUsage("codex")?.windows[0]?.usedPercent ?? "—"}%</span></div>
          <span className="collapsed-divider">◆</span>
          <div className="collapsed-provider provider--claude"><b>A</b><span>{displayUsage("claude")?.windows[0]?.usedPercent ?? "—"}%</span></div>
          <button className="collapsed-settings" data-tauri-drag-region="false" onMouseDown={(event) => event.stopPropagation()} onClick={() => void (settingsOpen ? closeSettings() : openSettings())} title="Settings" aria-label="Settings">⚙</button>
        </div>
      ) : settings.mode === "mini" ? (
        <main className="mini-content">
          <ProviderCard provider="codex" usage={displayUsage("codex")} status={currentStatus("codex")} message={slots.codex.issue} compact />
          <ProviderCard provider="claude" usage={displayUsage("claude")} status={currentStatus("claude")} message={slots.claude.issue} compact />
        </main>
      ) : (
        <main className="normal-content">
          <ProviderCard provider="codex" usage={displayUsage("codex")} status={currentStatus("codex")} message={slots.codex.issue} />
          <div className="section-rule" />
          <ProviderCard provider="claude" usage={displayUsage("claude")} status={currentStatus("claude")} message={slots.claude.issue} />
        </main>
      )}

      {settings.mode !== "collapsed" && (
        <footer className="statusbar">
          <span className={`status-live ${footerStatus === "LIVE" ? "status-live--ok" : "status-live--warn"}`}><i />{footerStatus}</span>
          <span className="updated">{relativeTime(updatedAt, now)}</span>
          <button className="mode-button" onClick={() => void applyMode(settings.mode === "normal" ? "mini" : "normal")} title="Toggle display mode">{settings.mode === "normal" ? "MINI" : "NORMAL"}</button>
        </footer>
      )}

      {settingsOpen && (
        <aside className="settings-panel">
          <div className="settings-heading"><span>CONTROL PANEL</span><button onClick={() => void closeSettings()} aria-label="Close settings">×</button></div>
          <label className="setting-row"><span>MODE</span><select value={settings.mode} onChange={(event) => void applyMode(event.target.value as DisplayMode)}><option value="normal">NORMAL</option><option value="mini">MINI</option><option value="collapsed">COLLAPSED</option></select></label>
          <label className="setting-row"><span>OPACITY <b>{Math.round(settings.opacity * 100)}%</b></span><input type="range" min="0.72" max="1" step="0.01" value={settings.opacity} onChange={(event) => void setPreference("opacity", Number(event.target.value))} /></label>
          <label className="setting-row"><span>REFRESH <b>{settings.refreshIntervalSeconds}s</b></span><input type="range" min="30" max="300" step="30" value={settings.refreshIntervalSeconds} onChange={(event) => void setPreference("refreshIntervalSeconds", Number(event.target.value))} /></label>
          <div className="setting-row"><span>TOGGLE WIDGET</span><b>CTRL+ALT+L</b></div>
          <div className="setting-row setting-row--sizes"><span>NORMAL SIZE</span><div className="size-presets"><button onClick={() => void resizeNormal(260, 360)}>COMPACT</button><button onClick={() => void resizeNormal(280, 440)}>STANDARD</button><button onClick={() => void resizeNormal(320, 520)}>TALL</button></div></div>
          <button className="setting-toggle" onClick={() => void togglePin()}><span className={`toggle-light ${settings.alwaysOnTop ? "is-on" : ""}`} />ALWAYS ON TOP <b>{settings.alwaysOnTop ? "ON" : "OFF"}</b></button>
          <label className="setting-toggle"><span className={`toggle-light ${settings.launchOnStartup ? "is-on" : ""}`} /><input type="checkbox" checked={settings.launchOnStartup} onChange={(event) => void setPreference("launchOnStartup", event.target.checked)} />LAUNCH ON WINDOWS <b>{settings.launchOnStartup ? "ON" : "OFF"}</b></label>
          <button className="quit-button" onClick={() => void quitApplication()}>QUIT MONITOR</button>
        </aside>
      )}
    </div>
  );
}
