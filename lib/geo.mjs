// Reverse geocoding: a fleet position (lat/lng) back into a US ZIP.
//
// The ELD reports where every truck is, but the cost model measures distance
// between ZIPs (api/distance, zip_distances). Without this bridge the Job
// Calculator can only measure empty miles from a fixed company base ZIP, which
// is wrong for a truck already out in the field — and the whole point of having
// live GPS is that we know it is out there.
//
// Lives in lib/ because api/ is at the Hobby plan's 12-function cap. It mirrors
// what api/geocode.mjs already does in the forward direction: Google when a key
// is configured, otherwise Nominatim, paced to its usage policy, and every
// answer cached in public.geo_cache so a position is only ever looked up once.
import { admin } from "./clients.mjs";

const UA = "NoBordersMovingCRM/1.0 (fleet reverse geocoding)";
const THROTTLE_MS = 1100;          // Nominatim's usage policy: one request/second
const googleKey = () => process.env.GOOGLE_MAPS_API_KEY || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two decimals is about a kilometre — finer than a ZIP, so the cache stays
// useful while a parked truck's GPS drifts.
const COORD_DP = 2;
const cacheKey = (lat, lng) => `rev:${lat.toFixed(COORD_DP)},${lng.toFixed(COORD_DP)}`;

// Warm lambdas share this so pacing holds across calls, not just within one.
let lastAt = 0;
async function pace() {
  const wait = THROTTLE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

/** First five digits of a US postcode, or "" when it is not one. */
export const zip5 = (v) => {
  const m = String(v || "").trim().match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
};

/**
 * Ask the geocoder. Returns the ZIP, "" for a real miss (the position resolved
 * but has no postcode — mid-ocean, a Canadian address), and THROWS when the
 * request itself failed, so a network blip is never cached as "no ZIP here".
 */
async function lookup(lat, lng) {
  const key = googleKey();
  if (key) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=postal_code&key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Reverse geocoder responded ${r.status}`);
    const d = await r.json();
    if (d.status === "ZERO_RESULTS") return "";
    // OVER_QUERY_LIMIT / REQUEST_DENIED are our problem, not the position's.
    if (d.status !== "OK" || !d.results?.length) throw new Error(`Reverse geocoder said ${d.status || "no status"}`);
    for (const res of d.results) {
      for (const c of res.address_components || []) {
        if ((c.types || []).includes("postal_code")) {
          const z = zip5(c.short_name || c.long_name);
          if (z) return z;
        }
      }
    }
    return "";
  }
  await pace();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Reverse geocoder responded ${r.status}`);
  const d = await r.json();
  if (d?.error) return "";
  return zip5(d?.address?.postcode);
}

/**
 * A fleet position as a US ZIP, cached forever in geo_cache. Returns "" when
 * the position has no ZIP, and null when the lookup could not be made at all —
 * the caller must tell those apart, because only the second is worth retrying.
 */
export async function reverseZip(lat, lng) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return "";
  if (!admin) return null;

  const q = cacheKey(la, ln);
  const { data: hit } = await admin.from("geo_cache").select("label").eq("q", q).maybeSingle();
  // A cached row is authoritative, including a cached miss (label ""): a
  // coordinate's ZIP does not change, so there is nothing to re-ask.
  if (hit) return zip5(hit.label);

  let z;
  try {
    z = await lookup(la, ln);
  } catch (e) {
    console.error("[geo] reverse lookup failed:", e?.message || e);
    return null; // transient — do not write it down as "no ZIP"
  }

  const { error } = await admin.from("geo_cache")
    .upsert({ q, lat: la, lng: ln, label: z }, { onConflict: "q" });
  if (error) console.error("[geo] caching reverse lookup:", error);
  return z;
}
