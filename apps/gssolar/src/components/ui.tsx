import type { ReactNode } from "react";

// Shared primitives. Dense, bordered, no shadows — the visual language is a
// portfolio-management tool, not a consumer dashboard.

export type Tone = "neutral" | "brand" | "pos" | "warn" | "neg" | "muted";

const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-ink/5 text-ink",
  brand: "bg-brand/10 text-brand",
  pos: "bg-pos/15 text-[#4d7409]",
  warn: "bg-warn/20 text-[#8a5b0d]",
  neg: "bg-neg/12 text-neg",
  muted: "bg-ink/5 text-muted",
};

export const TONE_HEX: Record<Tone, string> = {
  neutral: "var(--ink)",
  brand: "var(--brand)",
  pos: "var(--green)",
  warn: "var(--amber)",
  neg: "var(--red)",
  muted: "var(--muted)",
};

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold tracking-wide ${TONE_CHIP[tone]}`}>
      {children}
    </span>
  );
}

export function Card({
  title, actions, children, className = "", pad = true,
}: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rounded border border-line bg-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-2xs font-bold uppercase tracking-[0.07em] text-muted">{title}</h2>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function KpiCard({
  label, value, sub, subTone = "muted", progress, progressTone = "brand",
}: {
  label: string; value: string; sub?: ReactNode; subTone?: Tone;
  progress?: number; progressTone?: Tone;
}) {
  return (
    <div className="rounded border border-line bg-card px-4 py-3">
      <div className="text-2xs font-bold uppercase tracking-[0.07em] text-muted">{label}</div>
      <div className="mt-1.5 text-3xl font-semibold leading-none tracking-tight">{value}</div>
      {sub && <div className={`mt-1.5 text-xs ${subTone === "muted" ? "text-muted" : ""}`} style={subTone !== "muted" ? { color: TONE_HEX[subTone] } : undefined}>{sub}</div>}
      {progress !== undefined && (
        <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-ink/8">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(2, progress * 100))}%`, background: TONE_HEX[progressTone] }} />
        </div>
      )}
    </div>
  );
}

export function Btn({
  children, onClick, variant = "default", disabled,
}: { children: ReactNode; onClick?: () => void; variant?: "default" | "primary" | "ghost"; disabled?: boolean }) {
  const base = "inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-40";
  const styles =
    variant === "primary" ? "border-brand bg-brand text-white hover:bg-brand-dark"
    : variant === "ghost" ? "border-transparent text-muted hover:bg-ink/5"
    : "border-line bg-card text-ink hover:bg-canvas";
  return <button className={`${base} ${styles}`} onClick={onClick} disabled={disabled}>{children}</button>;
}

/**
 * Segmented control. Every scenario assumption in the product is one of these,
 * which is what makes "what if" a click rather than a duplicated spreadsheet tab.
 */
export function ToggleGroup<T extends string | number>({
  label, value, options, onChange, format,
}: {
  label?: string; value: T; options: readonly T[]; onChange: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <div>
      {label && <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-muted">{label}</div>}
      <div className="inline-flex overflow-hidden rounded border border-line">
        {options.map((o, i) => (
          <button
            key={String(o)}
            onClick={() => onChange(o)}
            className={`px-2 py-1 text-xs font-medium tabular-nums transition-colors ${i > 0 ? "border-l border-line" : ""} ${
              o === value ? "bg-brand text-white" : "bg-card text-muted hover:bg-canvas"
            }`}
          >
            {format ? format(o) : String(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function FilterChips<T extends string>({
  value, options, onChange, counts,
}: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; counts?: Record<string, number> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
            o.id === value ? "border-brand bg-brand/10 text-brand" : "border-line bg-card text-muted hover:bg-canvas"
          }`}
        >
          {o.label}
          {counts?.[o.id] !== undefined && <span className="ml-1 tabular-nums opacity-60">{counts[o.id]}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Numeric columns are right-aligned with tabular figures. */
  num?: boolean;
  width?: string;
  cell: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns, rows, keyOf, onRowClick, empty = "Nothing here.",
}: {
  columns: Column<T>[]; rows: T[]; keyOf: (row: T) => string;
  onRowClick?: (row: T) => void; empty?: string;
}) {
  if (rows.length === 0) {
    return <div className="px-4 py-8 text-center text-xs text-muted">{empty}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={`whitespace-nowrap px-2.5 py-2 text-2xs font-bold uppercase tracking-[0.06em] text-muted ${c.num ? "text-right" : "text-left"}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={keyOf(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-line/70 last:border-0 ${onRowClick ? "cursor-pointer hover:bg-canvas" : ""}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-2.5 py-2.5 align-middle ${c.num ? "num" : ""}`}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Budget-vs-actual bar. Colour carries the verdict; the number carries the size. */
export function BudgetBar({ value, max, tone }: { value: number; max: number; tone: Tone }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-sm bg-ink/6">
      <div className="h-full rounded-sm" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: TONE_HEX[tone] }} />
    </div>
  );
}

export function Row({ label, value, strong, tone }: { label: ReactNode; value: ReactNode; strong?: boolean; tone?: Tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5 last:border-0">
      <span className={`text-xs ${strong ? "font-semibold text-ink" : "text-muted"}`}>{label}</span>
      <span
        className={`num text-xs ${strong ? "text-base font-bold" : "font-semibold"}`}
        style={tone ? { color: TONE_HEX[tone] } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/** A value with the person who owns it and when they last confirmed it. */
export function OwnedValue({
  label, value, owner, meta, tone, flag,
}: { label: string; value: ReactNode; owner?: string; meta?: string; tone?: Tone; flag?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 py-2 last:border-0">
      <div className="min-w-0">
        <div className="text-xs font-medium text-ink">{label}</div>
        {(owner || meta) && (
          <div className="truncate text-2xs text-muted">{[owner, meta].filter(Boolean).join(" · ")}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {flag}
        <span className="num text-xs font-semibold" style={tone ? { color: TONE_HEX[tone] } : undefined}>{value}</span>
      </div>
    </div>
  );
}
