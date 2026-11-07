import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { severity } from "./components/PixelBar";
import { ProviderCard } from "./components/ProviderCard";
import {
  cursorInWindow,
  dockWindow,
  loadSettings,
  quitApplication,
  refreshUsage,
  saveSettings,
  saveWindowPosition,
  setAlwaysOnTop,
  setClickThrough,
  setDisplayMode,
  setWindowSize,
  startWindowDrag
} from "./services";
import type { AppSettings, DisplayMode, DockEdge, ProviderName, ProviderStatus, ProviderUsage, RefreshResult } from "./types";

const DEFAULT_SETTINGS: AppSettings = {
  mode: "normal",
  dockEdge: "right",
  opacity: 1,
  refreshIntervalSeconds: 60,
  alwaysOnTop: true,
  launchOnStartup: false,
  visibleProviders: ["codex", "claude", "gemini"],
  normalWidth: 280,
  normalHeight: 440
};

type Slot = { lastGood?: ProviderUsage; latest?: ProviderUsage; issue?: string; refreshing: boolean };
type Slots = Record<ProviderName, Slot>;
type Rect = { left: number; top: number; right: number; bottom: number };

const PROVIDERS: ProviderName[] = ["codex", "claude", "gemini"];
const DOCK_EDGES: DockEdge[] = ["top", "right", "bottom", "left"];
const PROVIDER_MARK: Record<ProviderName, string> = { codex: "C", claude: "A", gemini: "G" };
const PROVIDER_LABEL: Record<ProviderName, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini" };
const EDGE_LABEL: Record<DockEdge, string> = { top: "Top", right: "Right", bottom: "Bottom", left: "Left" };
const initialSlots: Slots = {
  codex: { refreshing: false },
  claude: { refreshing: false },
  gemini: { refreshing: false }
};

/** Transparent breathing room around the docked panel (room for shadow + spring overshoot). */
const DOCK_MARGIN = 12;
/** Length of the collapsed pill along the screen edge. */
const PILL_LONG = 92;
/** Hover slack around the pill so it is easy to hit. */
const PILL_SLACK = 10;
/** Delays (ms) that give hover a bit of intent and avoid flicker. */
const EXPAND_DELAY = 70;
const COLLAPSE_DELAY = 420;
const noop = () => undefined;

const pillThickness = (providerCount: number) => Math.max(24, 8 * Math.max(1, providerCount) + 8);

function dockGeometry(edge: DockEdge, panelWidth: number, panelHeight: number, providerCount: number) {
  const winW = panelWidth + DOCK_MARGIN * 2;
  const winH = panelHeight + DOCK_MARGIN * 2;
  const vertical = edge === "left" || edge === "right";
  const thick = pillThickness(providerCount);
  const pillW = vertical ? thick : PILL_LONG;
  const pillH = vertical ? PILL_LONG : thick;
  const cx = winW / 2;
  const cy = winH / 2;
  const s = PILL_SLACK;
  const span = DOCK_MARGIN + s;
  // Pill hit zones extend all the way to the screen edge so "slamming" the
  // cursor into the edge always opens the widget.
  const pill: Record<DockEdge, Rect> = {
    right: { left: winW - span - pillW, right: winW, top: cy - pillH / 2 - s, bottom: cy + pillH / 2 + s },
    left: { left: 0, right: span + pillW, top: cy - pillH / 2 - s, bottom: cy + pillH / 2 + s },
    top: { left: cx - pillW / 2 - s, right: cx + pillW / 2 + s, top: 0, bottom: span + pillH },
    bottom: { left: cx - pillW / 2 - s, right: cx + pillW / 2 + s, top: winH - span - pillH, bottom: winH }
  };
  return { winW, winH, pillW, pillH, pillHit: pill[edge], panelHit: { left: 0, top: 0, right: winW, bottom: winH } };
}

const inside = (x: number, y: number, r: Rect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

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
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function RefreshIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.1" /><path d="M19 13.5v-3l-2-.7a6 6 0 0 0-.55-1.32l.92-1.9-2.12-2.12-1.9.92A6 6 0 0 0 12 4.83l-.7-2h-3l-.7 2a6 6 0 0 0-1.32.55l-1.9-.92L2.26 6.58l.92 1.9A6 6 0 0 0 2.63 9.8l-2 .7v3l2 .7c.13.47.31.91.55 1.33l-.92 1.89 2.12 2.12 1.9-.92c.42.24.86.42 1.32.55l.7 2h3l.7-2a6 6 0 0 0 1.33-.55l1.89.92 2.12-2.12-.92-1.9c.24-.41.42-.85.55-1.32l2-.7Z" /></svg>;
}

function DockIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3.5" /><path d="M15.5 9v6" /></svg>;
}

function normalizeProvider(result: RefreshResult, provider: ProviderName) {
  return result.providers.find((item) => item.provider === provider);
}

function nextReset(slots: Slots, providers: ProviderName[]) {
  const values = providers
    .map((provider) => slots[provider].lastGood?.windows[0]?.resetsAt)
    .filter((value): value is string => Boolean(value));
  return values.sort()[0];
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [slots, setSlots] = useState<Slots>(initialSlots);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dockExpanded, setDockExpanded] = useState(false);
  const [ready, setReady] = useState(false);
  const now = useClock();
  const resetRefreshRef = useRef<string | undefined>(undefined);
  // Refs mirror state for async window callbacks so they never act on stale values.
  const settingsRef = useRef(settings);
  const settingsOpenRef = useRef(settingsOpen);
  const expandedRef = useRef(dockExpanded);
  settingsRef.current = settings;
  settingsOpenRef.current = settingsOpen;

  const currentWindow = useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return undefined;
    }
  }, []);
  const visibleProviders = useMemo(
    () => PROVIDERS.filter((provider) => settings.visibleProviders.includes(provider)),
    [settings.visibleProviders]
  );

  const commit = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const setExpanded = useCallback((value: boolean) => {
    if (expandedRef.current === value) return;
    expandedRef.current = value;
    setDockExpanded(value);
    // While collapsed the (transparent) window lets clicks fall through to
    // whatever is behind it; hover is detected by polling the cursor instead.
    void setClickThrough(!value).catch(noop);
  }, []);

  const resizeFor = useCallback(async (s: AppSettings) => {
    const count = Math.max(1, PROVIDERS.filter((p) => s.visibleProviders.includes(p)).length);
    if (s.mode === "docked") {
      await dockWindow(s.dockEdge, s.normalWidth + DOCK_MARGIN * 2, s.normalHeight + DOCK_MARGIN * 2).catch(noop);
      return;
    }
    const sizes: Record<Exclude<DisplayMode, "docked">, [number, number]> = {
      normal: [s.normalWidth, s.normalHeight],
      mini: [264, 50 + count * 34],
      collapsed: [150 + Math.max(0, count - 1) * 72, 46]
    };
    const [width, height] = sizes[s.mode];
    // The CSS mode remains useful if native resizing is not available in a preview environment.
    await setWindowSize(width, height).catch(noop);
  }, []);

  const applyMode = useCallback(async (mode: DisplayMode, edge?: DockEdge) => {
    const previous = settingsRef.current;
    const next: AppSettings = { ...previous, mode, dockEdge: edge ?? previous.dockEdge };
    commit(next);

    if (mode === "docked") {
      // Start collapsed unless the user is working in the settings panel.
      expandedRef.current = !settingsOpenRef.current;
      setExpanded(settingsOpenRef.current);
      await saveSettings(next).catch(noop);
      await resizeFor(next);
      return;
    }

    expandedRef.current = false;
    setDockExpanded(false);
    await setClickThrough(false).catch(noop);
    // Keep the settings panel usable while a new mode is selected. The
    // compact native size is applied when the panel is closed.
    if (settingsOpenRef.current) {
      await setWindowSize(next.normalWidth, next.normalHeight).catch(noop);
    } else {
      await resizeFor(next);
    }
    if (previous.mode === "docked") {
      // Saving with a free-floating mode restores the last undocked position.
      await saveSettings(next).catch(noop);
    } else {
      await setDisplayMode(mode).catch(noop);
    }
  }, [commit, resizeFor, setExpanded]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setSlots((previous) => PROVIDERS.reduce<Slots>((updated, provider) => {
      updated[provider] = { ...previous[provider], refreshing: true };
      return updated;
    }, { ...previous }));
    try {
      const result = await refreshUsage();
      setSlots((previous) => {
        const updated = { ...previous };
        PROVIDERS.forEach((provider) => {
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
      setSlots((previous) => PROVIDERS.reduce<Slots>((updated, provider) => {
        updated[provider] = { ...previous[provider], issue, refreshing: false };
        return updated;
      }, { ...previous }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSettings().then((loaded) => {
      const restoredProviders = Array.isArray(loaded.visibleProviders)
        ? PROVIDERS.filter((provider) => loaded.visibleProviders.includes(provider))
        : DEFAULT_SETTINGS.visibleProviders;
      const merged: AppSettings = {
        ...DEFAULT_SETTINGS,
        ...loaded,
        visibleProviders: restoredProviders.length > 0 ? restoredProviders : DEFAULT_SETTINGS.visibleProviders
      };
      commit(merged);
      if (merged.mode === "docked") {
        expandedRef.current = false;
        void setClickThrough(true).catch(noop);
      }
      setReady(true);
      void resizeFor(merged);
      void refresh();
    }).catch(() => {
      setReady(true);
      void refresh();
    });
  }, [commit, refresh, resizeFor]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => void refresh(), Math.max(30, settings.refreshIntervalSeconds) * 1000);
    return () => window.clearInterval(timer);
  }, [ready, refresh, settings.refreshIntervalSeconds]);

  useEffect(() => {
    const resetAt = nextReset(slots, visibleProviders);
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
  }, [slots, refresh, visibleProviders]);

  useEffect(() => {
    if (!currentWindow) return;
    let unlistenMove: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenMode: (() => void) | undefined;
    let positionTimer: number | undefined;
    void currentWindow.onMoved(({ payload }) => {
      // Docked placement is computed, never persisted as the floating position.
      if (settingsRef.current.mode === "docked") return;
      const position = payload as { x: number; y: number };
      window.clearTimeout(positionTimer);
      positionTimer = window.setTimeout(() => {
        if (settingsRef.current.mode === "docked") return;
        settingsRef.current = { ...settingsRef.current, positionX: position.x, positionY: position.y };
        setSettings(settingsRef.current);
        void saveWindowPosition(position.x, position.y);
      }, 250);
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
    if (!currentWindow) return;
    let unlistenResize: (() => void) | undefined;
    let resizeTimer: number | undefined;
    void currentWindow.onResized(({ payload }) => {
      if (settingsRef.current.mode !== "normal" || settingsOpenRef.current) return;
      void currentWindow.scaleFactor().then((scale) => {
        const size = payload as { width: number; height: number };
        const width = Math.round(size.width / scale);
        const height = Math.round(size.height / scale);
        if (width < 240 || height < 260) return;
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          const current = settingsRef.current;
          if (current.mode !== "normal" || (current.normalWidth === width && current.normalHeight === height)) return;
          const next = { ...current, normalWidth: width, normalHeight: height };
          commit(next);
          void saveSettings(next).catch(noop);
        }, 300);
      });
    }).then((unlisten) => { unlistenResize = unlisten; });
    return () => {
      unlistenResize?.();
      window.clearTimeout(resizeTimer);
    };
  }, [commit, currentWindow]);

  // Hover detection for the docked pill. The collapsed window is
  // click-through, so DOM hover events never fire; poll the global cursor.
  useEffect(() => {
    if (!ready || settings.mode !== "docked") return;
    const geometry = dockGeometry(settings.dockEdge, settings.normalWidth, settings.normalHeight, visibleProviders.length);
    let alive = true;
    let busy = false;
    let enteredAt = 0;
    let leftAt = 0;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      cursorInWindow().then(([x, y]) => {
        if (!alive) return;
        const t = performance.now();
        if (!expandedRef.current) {
          leftAt = 0;
          if (inside(x, y, geometry.pillHit)) {
            enteredAt ||= t;
            if (t - enteredAt >= EXPAND_DELAY) setExpanded(true);
          } else {
            enteredAt = 0;
          }
        } else {
          enteredAt = 0;
          if (inside(x, y, geometry.panelHit) || settingsOpenRef.current) {
            leftAt = 0;
          } else {
            leftAt ||= t;
            if (t - leftAt >= COLLAPSE_DELAY) setExpanded(false);
          }
        }
      }).catch(noop).finally(() => { busy = false; });
    }, 50);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ready, setExpanded, settings.dockEdge, settings.mode, settings.normalHeight, settings.normalWidth, visibleProviders.length]);

  const setPreference = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settingsRef.current, [key]: value };
    commit(next);
    await saveSettings(next).catch(noop);
  };

  const resizeNormal = async (width: number, height: number) => {
    const current = settingsRef.current;
    const docked = current.mode === "docked";
    const next: AppSettings = { ...current, normalWidth: width, normalHeight: height, mode: docked ? "docked" : "normal" };
    commit(next);
    if (docked) {
      await saveSettings(next).catch(noop);
      await resizeFor(next);
      return;
    }
    await setDisplayMode("normal").catch(noop);
    await setWindowSize(width, height).catch(noop);
    await saveSettings(next).catch(noop);
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    settingsOpenRef.current = true;
    // Mini and collapsed windows are intentionally too short for the panel.
    // Temporarily give the panel the normal working area while preserving the
    // selected display mode; closing it restores the compact size.
    const mode = settingsRef.current.mode;
    if (mode === "mini" || mode === "collapsed") {
      await setWindowSize(settingsRef.current.normalWidth, settingsRef.current.normalHeight).catch(noop);
    }
  };

  const closeSettings = async () => {
    setSettingsOpen(false);
    settingsOpenRef.current = false;
    if (settingsRef.current.mode !== "docked") await resizeFor(settingsRef.current);
  };

  const beginDrag = (event: ReactMouseEvent) => {
    if (settingsRef.current.mode === "docked") return;
    if (event.button === 0) void startWindowDrag().catch(noop);
  };

  const togglePin = async () => {
    const next = { ...settingsRef.current, alwaysOnTop: !settingsRef.current.alwaysOnTop };
    commit(next);
    await setAlwaysOnTop(next.alwaysOnTop).catch(noop);
    await saveSettings(next).catch(noop);
  };

  const toggleProvider = async (provider: ProviderName) => {
    const current = settingsRef.current;
    const currentlyVisible = current.visibleProviders.includes(provider);
    if (currentlyVisible && visibleProviders.length === 1) return;
    const nextVisible = PROVIDERS.filter((item) => (
      item === provider ? !currentlyVisible : current.visibleProviders.includes(item)
    ));
    const next = { ...current, visibleProviders: nextVisible };
    commit(next);
    await saveSettings(next).catch(noop);
    if (!settingsOpenRef.current && next.mode !== "docked") await resizeFor(next);
    if (!currentlyVisible) void refresh();
  };

  const currentStatus = (provider: ProviderName): ProviderStatus | "stale" | "refreshing" => {
    const slot = slots[provider];
    if (slot.refreshing && slot.lastGood) return "refreshing";
    if (slot.lastGood && slot.issue) return "stale";
    return slot.latest?.status ?? "unavailable";
  };

  const displayUsage = (provider: ProviderName) => slots[provider].lastGood ?? slots[provider].latest;
  const updatedAt = visibleProviders.map((provider) => slots[provider].lastGood?.updatedAt).find(Boolean);
  const footerStatus = refreshing ? "Refreshing" : visibleProviders.some((provider) => slots[provider].issue) ? "Check data" : "Live";
  const docked = settings.mode === "docked";
  const bodyMode: DisplayMode = docked ? "normal" : settings.mode;

  if (!ready) return null;

  const topbar = (
    <header
      className="topbar"
      data-tauri-drag-region={docked ? undefined : true}
      onMouseDown={beginDrag}
      onDoubleClick={() => { if (!docked) void applyMode(settings.mode === "normal" ? "mini" : "normal"); }}
    >
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span className="brand-copy"><strong>LLM Usage</strong></span>
      </div>
      <div className="top-actions" data-tauri-drag-region="false" onMouseDown={(event) => event.stopPropagation()}>
        <button className={`icon-button ${refreshing ? "is-spinning" : ""}`} onClick={() => void refresh()} title="Refresh now" aria-label="Refresh now"><RefreshIcon /></button>
        <button className={`icon-button ${docked ? "is-active" : ""}`} onClick={() => void applyMode(docked ? "normal" : "docked")} title={docked ? "Undock" : `Dock to ${EDGE_LABEL[settings.dockEdge].toLowerCase()} edge`} aria-label={docked ? "Undock" : "Dock to screen edge"}><DockIcon /></button>
        <button className={`icon-button ${settingsOpen ? "is-active" : ""}`} onClick={() => void (settingsOpen ? closeSettings() : openSettings())} title="Settings" aria-label="Settings"><SettingsIcon /></button>
      </div>
    </header>
  );

  const content = bodyMode === "collapsed" ? (
    <div className="collapsed-content" onMouseDown={beginDrag}>
      {visibleProviders.map((provider, index) => {
        const used = displayUsage(provider)?.windows[0]?.usedPercent;
        return (
          <Fragment key={provider}>
            {index > 0 && <span className="collapsed-divider" />}
            <div className={`collapsed-provider provider--${provider} level--${severity(used)}`}>
              <b>{PROVIDER_MARK[provider]}</b>
              <span className="collapsed-dot" />
              <span>{used ?? "—"}%</span>
            </div>
          </Fragment>
        );
      })}
      <button className="collapsed-settings" data-tauri-drag-region="false" onMouseDown={(event) => event.stopPropagation()} onClick={() => void (settingsOpen ? closeSettings() : openSettings())} title="Settings" aria-label="Settings"><SettingsIcon /></button>
    </div>
  ) : bodyMode === "mini" ? (
    <main className="mini-content">
      {visibleProviders.map((provider) => <ProviderCard key={provider} provider={provider} usage={displayUsage(provider)} status={currentStatus(provider)} message={slots[provider].issue} compact />)}
    </main>
  ) : (
    <main className="normal-content">
      {visibleProviders.map((provider, index) => (
        <div key={provider} className="card-enter" style={{ animationDelay: `${index * 60}ms` }}>
          <ProviderCard provider={provider} usage={displayUsage(provider)} status={currentStatus(provider)} message={slots[provider].issue} />
        </div>
      ))}
    </main>
  );

  const statusbar = bodyMode === "normal" && (
    <footer className="statusbar">
      <span className={`status-live ${footerStatus === "Live" ? "status-live--ok" : "status-live--warn"}`}><i />{footerStatus}</span>
      <span className="updated">{relativeTime(updatedAt, now)}</span>
      <button className="mode-button" onClick={() => void applyMode(docked ? "normal" : "mini")} title="Toggle display mode">{docked ? "Undock" : "Mini"}</button>
    </footer>
  );

  const settingsPanel = settingsOpen && (
    <aside className="settings-panel">
      <div className="settings-heading"><span>Settings</span><button onClick={() => void closeSettings()} aria-label="Close settings">×</button></div>

      <div className="settings-group">
        <label className="setting-row"><span>Display mode</span>
          <select value={settings.mode} onChange={(event) => void applyMode(event.target.value as DisplayMode)}>
            <option value="normal">Normal</option>
            <option value="mini">Mini</option>
            <option value="collapsed">Collapsed</option>
            <option value="docked">Docked</option>
          </select>
        </label>
        <div className="setting-row setting-row--dock">
          <span>Dock to edge<small>Shrinks to a pill, expands on hover</small></span>
          <div className="dock-picker" role="group" aria-label="Dock position">
            {DOCK_EDGES.map((edge) => (
              <button
                key={edge}
                className={`dock-picker__dot dock-picker__dot--${edge} ${docked && settings.dockEdge === edge ? "is-active" : ""}`}
                onClick={() => void applyMode("docked", edge)}
                title={`Dock ${EDGE_LABEL[edge].toLowerCase()}`}
                aria-label={`Dock ${EDGE_LABEL[edge].toLowerCase()}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <span className="settings-group__title">Providers</span>
        <div className="setting-providers__options">
          {PROVIDERS.map((provider) => {
            const checked = settings.visibleProviders.includes(provider);
            return (
              <label key={provider} className={`provider-choice ${checked ? "is-on" : ""}`}>
                <input type="checkbox" checked={checked} disabled={checked && visibleProviders.length === 1} onChange={() => void toggleProvider(provider)} />
                {PROVIDER_LABEL[provider]}
              </label>
            );
          })}
        </div>
      </div>

      <div className="settings-group">
        <label className="setting-row setting-row--range"><span>Opacity <b>{Math.round(settings.opacity * 100)}%</b></span><input type="range" min="0.72" max="1" step="0.01" value={settings.opacity} onChange={(event) => void setPreference("opacity", Number(event.target.value))} /></label>
        <label className="setting-row setting-row--range"><span>Refresh interval <b>{settings.refreshIntervalSeconds}s</b></span><input type="range" min="30" max="300" step="30" value={settings.refreshIntervalSeconds} onChange={(event) => void setPreference("refreshIntervalSeconds", Number(event.target.value))} /></label>
        <div className="setting-row"><span>Window size</span>
          <div className="segmented">
            {([["S", 260, 360], ["M", 280, 440], ["L", 320, 520]] as const).map(([label, w, h]) => (
              <button key={label} className={settings.normalWidth === w && settings.normalHeight === h ? "is-active" : ""} onClick={() => void resizeNormal(w, h)}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <button className="setting-toggle" onClick={() => void togglePin()}>Always on top<span className={`switch ${settings.alwaysOnTop ? "is-on" : ""}`} /></button>
        <label className="setting-toggle"><input type="checkbox" checked={settings.launchOnStartup} onChange={(event) => void setPreference("launchOnStartup", event.target.checked)} />Launch on Windows<span className={`switch ${settings.launchOnStartup ? "is-on" : ""}`} /></label>
        <div className="setting-row"><span>Toggle widget</span><kbd>Ctrl Alt L</kbd></div>
      </div>

      <button className="quit-button" onClick={() => void quitApplication()}>Quit LLM Usage</button>
    </aside>
  );

  if (docked) {
    const geometry = dockGeometry(settings.dockEdge, settings.normalWidth, settings.normalHeight, visibleProviders.length);
    const dockStyle = {
      "--panel-w": `${settings.normalWidth}px`,
      "--panel-h": `${settings.normalHeight}px`,
      "--pill-w": `${geometry.pillW}px`,
      "--pill-h": `${geometry.pillH}px`,
      "--dock-margin": `${DOCK_MARGIN}px`,
      opacity: settings.opacity
    } as CSSProperties;
    return (
      <div className={`dock-root dock--${settings.dockEdge} ${dockExpanded ? "is-expanded" : "is-collapsed"}`} style={dockStyle}>
        <div className="dock-surface">
          <div className="dock-pill" aria-hidden={dockExpanded}>
            {visibleProviders.map((provider) => {
              const used = displayUsage(provider)?.windows[0]?.usedPercent;
              const fill = used === undefined ? 0 : Math.max(0, Math.min(100, used));
              return (
                <span key={provider} className={`dock-pill__track provider--${provider} level--${severity(used)}`}>
                  <i style={{ "--fill": `${fill}%` } as CSSProperties} />
                </span>
              );
            })}
          </div>
          <div className="dock-panel" aria-hidden={!dockExpanded}>
            {topbar}
            {content}
            {statusbar}
            {settingsPanel}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell mode-${settings.mode}`} style={{ opacity: settings.opacity }}>
      {topbar}
      {content}
      {statusbar}
      {settingsPanel}
    </div>
  );
}
