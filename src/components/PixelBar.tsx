import type { UsageWindow } from "../types";

export const WARNING_THRESHOLD = 70;
export const CRITICAL_THRESHOLD = 90;

export function severity(used: number | undefined) {
  if (used === undefined) return "unknown";
  if (used >= CRITICAL_THRESHOLD) return "critical";
  if (used >= WARNING_THRESHOLD) return "warning";
  return "normal";
}

export function PixelBar({ window, compact = false }: { window?: UsageWindow; compact?: boolean }) {
  const used = window?.usedPercent;
  const filled = used === undefined ? 0 : Math.max(0, Math.min(100, used));
  const level = severity(used);

  return (
    <div className={`pixel-bar pixel-bar--${level} ${compact ? "pixel-bar--compact" : ""}`} aria-label={used === undefined ? "Usage unavailable" : `${used}% used`}>
      <span className="pixel-bar__fill" style={{ width: `${filled}%` }}>
        <span className="pixel-bar__liquid" />
      </span>
    </div>
  );
}
