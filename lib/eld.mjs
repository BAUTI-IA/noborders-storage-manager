// Shared ELD/telematics plumbing, used by both providers the CRM talks to:
// lib/verizon.mjs (Verizon Connect Reveal) and lib/motive.mjs (Motive, ex
// KeepTruckin).
//
// Only the transport and the field names differ between them. Everything below
// is the part that must NOT differ: how a duty-status stream turns into hours
// per day, how a local day is bounded across DST, and how positions land in
// truck_pings. Two copies of this arithmetic would drift, and the day it drifts
// is the day payroll and the ELD stop agreeing for reasons nobody can explain.
import { admin } from "./clients.mjs";

// ── Field reading ────────────────────────────────────────────────────────────
// Neither provider's payload is documented well enough to bet on one spelling:
// Reveal is PascalCase and varies by tenant, Motive is snake_case and varies by
// endpoint version. Read the first key that is actually present.

export const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj == null ? null : obj[k];
    if (v != null && v !== "") return v;
  }
  return null;
};

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alreadyMentions = (haystack, part) =>
  new RegExp(`(^|[^a-z0-9])${escapeRe(part)}([^a-z0-9]|$)`, "i").test(haystack);

// An address object → one line. Providers often put the whole address in the
// street field, so blindly appending city and state gives "…Plymouth, IN 46563,
// USA, Plymouth, IN". Match on whole words: a plain substring test would find
// the state "IN" inside "Springfield" and drop it.
export function formatAddress(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  const parts = [
    pick(a, "AddressLine1", "addressLine1", "Line1", "StreetAddress", "street", "address"),
    pick(a, "Locality", "locality", "City", "city"),
    pick(a, "AdministrativeArea", "administrativeArea", "State", "state"),
  ].filter(Boolean).map(String);
  const out = [];
  for (const part of parts) {
    if (!alreadyMentions(out.join(", "), part)) out.push(part);
  }
  return out.length ? out.join(", ") : null;
}

export function isoOrNow(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ── Hours of Service ─────────────────────────────────────────────────────────
// Both providers serve the logbook as a stream of duty-status changes, not as a
// daily total: each event says "from this instant, the driver is DRIVING / ON /
// OFF / SB". Real hours come from walking consecutive events, which is also what
// turns into clock-in and clock-out.

// The fleet's home timezone decides where one work day ends and the next starts.
// VERIZON_TZ is still read so an existing deployment keeps its setting.
export const TZ = process.env.FLEET_TZ || process.env.VERIZON_TZ || "America/New_York";

// ELD statuses arrive spelled a dozen ways across exports, providers and API
// versions. Motive sends lowercase snake_case ("on_duty", "sleeper"), Reveal
// sends short codes and title case.
export function dutyCode(raw) {
  const v = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!v) return null;
  if (v === "D" || v.startsWith("DRIV")) return "D";
  if (v === "SB" || v.includes("SLEEP")) return "SB";
  if (v === "OFF" || v.startsWith("OFF")) return "OFF";
  if (v === "ON" || v.startsWith("ON_DUTY") || v.startsWith("ONDUTY") || v.includes("NOT_DRIVING")) return "ON";
  return null;
}

// Minutes between the wall clock in `tz` and the real instant.
function tzOffsetMs(ms, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
}

export const localDay = (ms, tz = TZ) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));

// The instant the local day containing `ms` ends. The offset is re-read at the
// estimate so the two DST days a year land on the right hour instead of an hour off.
function endOfLocalDay(ms, tz = TZ) {
  const day = localDay(ms, tz);
  const midnightWall = Date.parse(`${day}T00:00:00Z`) + 24 * 3600e3;
  let guess = midnightWall - tzOffsetMs(ms, tz);
  guess = midnightWall - tzOffsetMs(guess, tz);
  return guess;
}

// Duty events → one row per driver per local day. Segments that run past midnight
// are split, so an overnight run counts its hours on the day it actually drove
// them instead of dumping all of them on the day it started.
export function summarizeDutyDays(events, { tz = TZ, now = Date.now() } = {}) {
  const byDriver = new Map();
  for (const e of events || []) {
    if (!e || e.at == null || !e.driver) continue;
    if (!byDriver.has(e.driver)) byDriver.set(e.driver, []);
    byDriver.get(e.driver).push(e);
  }

  const rows = [];
  for (const [driver, list] of byDriver) {
    list.sort((a, b) => a.at - b.at);
    const days = new Map();
    const dayOf = (d) => {
      if (!days.has(d)) days.set(d, { driver, date: d, drivingMs: 0, onDutyMs: 0, firstOn: null, lastOff: null });
      return days.get(d);
    };

    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      const code = dutyCode(ev.status);
      if (!code) continue;
      // The last event runs to the end of its own day or to now, whichever is
      // sooner: an open shift must not bill hours that have not happened yet.
      const next = list[i + 1]?.at ?? Math.min(now, endOfLocalDay(ev.at, tz));
      if (next <= ev.at) continue;

      if (code === "D" || code === "ON") {
        const d0 = dayOf(localDay(ev.at, tz));
        if (d0.firstOn == null || ev.at < d0.firstOn) d0.firstOn = ev.at;
      } else {
        const d0 = dayOf(localDay(ev.at, tz));
        if (d0.lastOff == null || ev.at > d0.lastOff) d0.lastOff = ev.at;
      }
      if (code === "OFF" || code === "SB") continue;   // no hours to bank

      let cursor = ev.at;
      while (cursor < next) {
        const boundary = Math.min(endOfLocalDay(cursor, tz), next);
        const slice = boundary - cursor;
        const bucket = dayOf(localDay(cursor, tz));
        bucket.onDutyMs += slice;
        if (code === "D") bucket.drivingMs += slice;
        cursor = boundary;
      }
    }

    for (const d of days.values()) {
      const hrs = (ms) => Math.round((ms / 3600e3) * 100) / 100;
      rows.push({
        driver: d.driver,
        date: d.date,
        hours: hrs(d.onDutyMs),
        drivingHours: hrs(d.drivingMs),
        // Clock in / clock out as the operation reads them: first minute on duty,
        // last minute before going off.
        clockIn: d.firstOn == null ? null : new Date(d.firstOn).toISOString(),
        clockOut: d.lastOff == null ? null : new Date(d.lastOff).toISOString(),
      });
    }
  }
  return rows.filter(r => r.hours > 0 || r.clockIn).sort((a, b) => a.date.localeCompare(b.date) || String(a.driver).localeCompare(String(b.driver)));
}

// ── Position history ─────────────────────────────────────────────────────────

// Two timestamps for the same instant, whatever shape Postgres handed back.
export const sameInstant = (a, b) => {
  if (!a || !b) return false;
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  return !isNaN(x) && !isNaN(y) && x === y;
};

// One row per distinct fix. Both providers repeat the last known position between
// updates, so writing every poll would store the same parked truck 288 times a
// day and drown the real movement in it.
export async function recordPings(rows) {
  if (!rows.length) return { written: 0 };
  try {
    // Ignores rows that collide with (truck_id, at) — a re-sync of a fix we have.
    const { error } = await admin.from("truck_pings")
      .upsert(rows, { onConflict: "truck_id,at", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { written: rows.length };
  } catch (e) {
    // A live sync must not fail over history, but the caller has to know nothing
    // was stored — counting attempts as writes sends people off to debug the
    // wrong half of the system.
    console.error("truck_pings:", e?.message || e);
    return { written: 0, error: e?.message || String(e) };
  }
}
