#!/usr/bin/env node
// Precarga public.geo_cache con las direcciones de los jobs, para que el mapa de
// Trips / Live Load dibuje los pins al instante en vez de ir geocodificando de a
// una mientras alguien mira la pantalla.
//
// Por qué existe: storage_jobs guarda las direcciones como texto y nada más, así
// que cada pin necesita un geocode. Nominatim permite 1 request por segundo, o
// sea que con la cache fría el mapa tarda minutos en llenarse la primera vez.
// Esto paga ese costo una sola vez, offline. Después la app casi nunca falla.
//
// Con GOOGLE_MAPS_API_KEY seteada usa Google (sin throttle, mucho más rápido);
// si no, cae a Nominatim con la pausa de 1,1 s que exige su política de uso.
//
// Es DRY-RUN por default: sólo cuenta cuántas direcciones distintas hay y
// cuántas faltan. Con --apply escribe.
//
// Uso (Node 18+):
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/backfill-geo-cache.mjs
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/backfill-geo-cache.mjs --apply
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/backfill-geo-cache.mjs --apply --days 60
//
// Variables de entorno:
//   SUPABASE_URL               (default: proyecto noborders-storages)
//   SUPABASE_SERVICE_ROLE_KEY  (obligatoria)
//   GOOGLE_MAPS_API_KEY        (opcional: geocoder más rápido)

const SUPABASE_URL = process.env.SUPABASE_URL || "https://szkmktxziojzgfjkomua.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GKEY = process.env.GOOGLE_MAPS_API_KEY || "";
const UA = "NoBordersMovingCRM/1.0 (live-load map geocoding)";
const PAGE = 1000;
const READ_CHUNK = 200;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APPLY = flag("--apply");
const DAYS = parseInt(opt("--days", "60"), 10);

if (!KEY) { console.error("Falta SUPABASE_SERVICE_ROLE_KEY. Copiala de Supabase → Settings → API Keys."); process.exit(1); }
if (!Number.isFinite(DAYS) || DAYS < 1) { console.error(`--days inválido: ${opt("--days", "")}`); process.exit(1); }

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path.split("?")[0]}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}
async function fetchAll(path) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = await rest(`${path}&order=id.asc&offset=${from}&limit=${PAGE}`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// Mismo criterio que fmtPlace/geoCandidates en src/App.jsx: los placeholders no
// son direcciones, y el código de estado de 2 letras se expande para que el
// geocoder no lea "OK" o "ID" como palabras.
const PLACEHOLDER = /^(tbd|t\.?b\.?d\.?|n\/?a|na|none|-+|\.+|\?+|unknown|pending|same|house)$/i;
const STATES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada","NH":"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia" };
const normQ = (q) => String(q || "").trim().toLowerCase().replace(/\s+/g, " ");

function candidates({ address, city, state, zip }) {
  const st = (state || "").trim();
  const stateName = STATES[st.toUpperCase()] || st;
  const addr = PLACEHOLDER.test((address || "").trim()) ? "" : (address || "").trim();
  const c = (city || "").trim(), z = (zip || "").trim();
  const out = [];
  const push = (parts) => { const q = parts.filter(Boolean).join(", "); if (q && !out.includes(q)) out.push(q); };
  push([addr, c, stateName, z]); push([c, stateName, z]); push([z, stateName]); push([c, stateName]); push([stateName]);
  return out;
}

async function geocode(q) {
  if (GKEY) {
    const r = await fetch("https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(q)
      + "&components=country:US|country:CA&key=" + encodeURIComponent(GKEY), { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Geocoder HTTP ${r.status}`);
    const d = await r.json();
    if (d.status === "ZERO_RESULTS") return null;
    if (d.status !== "OK" || !d.results?.length) throw new Error(`Geocoder: ${d.status}`);
    const h = d.results[0];
    return { lat: h.geometry.location.lat, lng: h.geometry.location.lng, label: h.formatted_address || q };
  }
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us,ca&q="
    + encodeURIComponent(q), { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Geocoder HTTP ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d) || !d.length) return null;
  return { lat: Number(d[0].lat), lng: Number(d[0].lon), label: d[0].display_name || q };
}

// ── 1. Qué direcciones importan ──
const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
const sel = "id,job_number,status,calendar_status,pickup_address,pickup_city,pickup_state,pickup_zip,"
  + "delivery_address,delivery_city,delivery_state,delivery_zip,pickup_date,pickup_date_from,pickup_date_to,delivery_date";
const jobs = await fetchAll(`storage_jobs?select=${sel}&deleted_at=is.null`);

// Sólo lo que el mapa puede llegar a pedir: jobs abiertos con alguna fecha reciente
// o futura. Geocodificar el archivo histórico entero sería pagar por pins que
// nadie va a mirar.
const live = jobs.filter((j) => {
  if (j.status === "delivered" || j.status === "cancelled" || j.calendar_status === "cancelled") return false;
  const d = [j.pickup_date_to, j.pickup_date_from, j.pickup_date, j.delivery_date].filter(Boolean).sort().pop();
  return !d || d >= since;
});

// Sólo el candidato MÁS específico de cada lado: los fallbacks (ciudad, zip,
// estado) se resuelven solos y son muchos menos, así que la app los absorbe.
const wanted = new Set();
for (const j of live) {
  for (const c of [
    candidates({ address: j.pickup_address, city: j.pickup_city, state: j.pickup_state, zip: j.pickup_zip })[0],
    candidates({ address: j.delivery_address, city: j.delivery_city, state: j.delivery_state, zip: j.delivery_zip })[0],
  ]) if (c) wanted.add(normQ(c));
}

// ── 2. Qué falta ──
const list = [...wanted];
const known = new Set();
for (let i = 0; i < list.length; i += READ_CHUNK) {
  const inList = list.slice(i, i + READ_CHUNK).map((q) => `"${q.replace(/"/g, '""')}"`).join(",");
  const rows = await rest(`geo_cache?select=q&q=in.(${encodeURIComponent(inList)})`);
  for (const r of rows) known.add(r.q);
}
const todo = list.filter((q) => !known.has(q));

console.log(`Jobs totales: ${jobs.length} · abiertos con fecha >= ${since}: ${live.length}`);
console.log(`Direcciones distintas a mapear: ${list.length} · ya en cache: ${known.size} · faltan: ${todo.length}`);
console.log(`Geocoder: ${GKEY ? "Google (sin throttle)" : "Nominatim (1,1 s por request)"}`);
if (!todo.length) { console.log("Nada que hacer."); process.exit(0); }
if (!APPLY) {
  const mins = GKEY ? Math.ceil(todo.length / 50 / 60) : Math.ceil((todo.length * 1.1) / 60);
  console.log(`\nDRY-RUN. Con --apply geocodifica ${todo.length} direcciones (~${mins} min).`);
  process.exit(0);
}

// ── 3. Geocodificar ──
let hits = 0, misses = 0, errors = 0;
for (let i = 0; i < todo.length; i++) {
  const q = todo[i];
  if (i && !GKEY) await sleep(1100);
  let row;
  try {
    const hit = await geocode(q);
    row = { q, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null, label: hit ? hit.label : null, fetched_at: new Date().toISOString() };
    if (hit) hits++; else misses++;
  } catch (e) {
    // Un fallo de red no es "esta dirección no existe": no se cachea.
    errors++;
    console.error(`  ! ${q}: ${e.message}`);
    continue;
  }
  await rest("geo_cache?on_conflict=q", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
  if ((i + 1) % 25 === 0 || i === todo.length - 1) console.log(`  ${i + 1}/${todo.length} · ${hits} ok · ${misses} sin resultado · ${errors} error`);
}
console.log(`\n✓ Listo: ${hits} geocodificadas, ${misses} sin resultado (cacheadas igual), ${errors} con error (se reintentan).`);
