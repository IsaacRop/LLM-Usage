export type ProviderName = "codex" | "claude" | "gemini";
export type ProviderStatus = "available" | "partial" | "unavailable" | "error";
export type DisplayMode = "normal" | "mini" | "collapsed";

export type UsageWindow = {
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  windowMinutes?: number;
  label: string;
};

export type ProviderUsage = {
  provider: ProviderName;
  status: ProviderStatus;
  windows: UsageWindow[];
  updatedAt: string;
  message?: string;
  source?: string;
};

export type RefreshResult = {
  providers: ProviderUsage[];
  fetchedAt: string;
};

export type AppSettings = {
  mode: DisplayMode;
  opacity: number;
  refreshIntervalSeconds: number;
  alwaysOnTop: boolean;
  launchOnStartup: boolean;
  visibleProviders: ProviderName[];
  normalWidth: number;
  normalHeight: number;
  positionX?: number;
  positionY?: number;
};
