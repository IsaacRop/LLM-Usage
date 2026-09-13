import type { ProviderName, ProviderStatus, ProviderUsage, UsageWindow } from "../types";
import { PixelBar } from "./PixelBar";

type Props = {
  provider: ProviderName;
  usage?: ProviderUsage;
  status: ProviderStatus | "stale" | "refreshing";
  message?: string;
  compact?: boolean;
};

const providerLabel: Record<ProviderName, string> = { codex: "CODEX", claude: "CLAUDE", gemini: "GEMINI" };
const providerMark: Record<ProviderName, string> = { codex: "C", claude: "A", gemini: "G" };

function windowLabel(window: UsageWindow, index: number) {
  if (window.label) return window.label;
  return index === 0 ? "CURRENT" : "SECONDARY";
}

function formatCountdown(resetAt?: string) {
  if (!resetAt) return "↻ —";
  const milliseconds = new Date(resetAt).getTime() - Date.now();
  if (milliseconds <= 0) return "↻ NOW";
  const totalMinutes = Math.ceil(milliseconds / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `↻ ${days}d ${hours}h`;
  if (hours > 0) return `↻ ${hours}h ${minutes}m`;
  return `↻ ${minutes}m`;
}

function statusText(status: Props["status"], message?: string) {
  if (status === "refreshing") return "REFRESHING";
  if (status === "stale") return "STALE DATA";
  if (status === "unavailable") return "UNAVAILABLE";
  if (status === "error") return "ERROR";
  return message ?? "LIVE";
}

function WindowRow({ window, index }: { window: UsageWindow; index: number }) {
  const used = window.usedPercent;
  const remaining = window.remainingPercent;
  return (
    <section className="usage-window">
      <div className="window-heading">
        <span>{windowLabel(window, index)}</span>
        <span className="window-value">{used === undefined ? "—" : `${used}%`} <small>USED</small></span>
      </div>
      <PixelBar window={window} />
      <div className="window-meta">
        <span>{remaining === undefined ? "REMAINING —" : `${remaining}% REMAINING`}</span>
        <span title={window.resetsAt ? new Date(window.resetsAt).toLocaleString() : undefined}>{formatCountdown(window.resetsAt)}</span>
      </div>
    </section>
  );
}

export function ProviderCard({ provider, usage, status, message, compact = false }: Props) {
  const windows = usage?.windows ?? [];
  const primary = windows[0];
  const displayStatus = statusText(status, message);

  if (compact) {
    return (
      <div className={`mini-provider provider--${provider}`} title={`${providerLabel[provider]} — ${displayStatus}`}>
        <span className="mini-mark">{providerMark[provider]}</span>
        <PixelBar window={primary} compact />
        <strong>{primary?.usedPercent === undefined ? "—" : `${primary.usedPercent}%`}</strong>
      </div>
    );
  }

  return (
    <article className={`provider-card provider--${provider} provider-status--${status}`}>
      <div className="provider-heading">
        <div className="provider-title"><span className="provider-square" />{providerLabel[provider]}</div>
        <span className="provider-state"><i />{displayStatus}</span>
      </div>
      {windows.length > 0 ? (
        windows.map((window, index) => <WindowRow key={`${provider}-${index}-${window.label}`} window={window} index={index} />)
      ) : (
        <div className="empty-provider">
          <span className="empty-glyph">□</span>
          <span>{message ?? displayStatus}</span>
        </div>
      )}
      {usage?.source && <div className="source-note">SOURCE · {usage.source}</div>}
    </article>
  );
}
