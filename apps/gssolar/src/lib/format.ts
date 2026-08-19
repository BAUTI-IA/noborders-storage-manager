// Display formatting. Every figure in the UI passes through here so that a
// dollar looks like a dollar on all five screens.

export const money = (n: number, dp = 0) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Compact money for KPI tiles: $4.12M, $684K. */
export function moneyC(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${Math.round(a / 1_000)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

export const perW = (n: number, dp = 2) => `$${n.toFixed(dp)}`;
export const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`;
export const pctSigned = (n: number, dp = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(dp)}%`;
export const mw = (kw: number, dp = 2) => `${(kw / 1000).toFixed(dp)}`;
export const num = (n: number, dp = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function longDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export const ASSET_LABEL: Record<string, string> = {
  rooftop: "Rooftop",
  ground_mount: "Ground-mount",
  carport: "Carport",
  community: "Community",
};
