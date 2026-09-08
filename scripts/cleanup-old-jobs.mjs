#!/usr/bin/env node
// Limpieza de jobs viejos: marca como ENTREGADO todo job que quedó "activo" en
// el CRM (sin date_out, status distinto de delivered/cancelled) pero cuyas
// fechas son de antes del corte (por default 2026-06-01 → mayo para atrás).
//
// Por qué: la app mobile y el CRM consideran "activo" a cualquier job sin
// date_out. Cientos de jobs históricos nunca fueron cerrados, así que figuran
// como activos, ocupan storage, siguen generando storage billing y suman en
// "a cobrar". Esto los cierra en bloque, de forma reversible.
//
// Qué cambia en cada job elegido (todas sus filas en storage_jobs):
//   status     → 'delivered'
//   date_out   → la fecha más reciente que tenga el job (delivery_date, fadd,
//                pickup_date_to, pickup_date, date_in). Se usa esa y no "hoy"
//                para que analytics no muestre 800 entregas en el mes actual.
//   updated_by → 'cleanup-old-jobs', updated_at → ahora
// Con --void-billing, además las filas de storage_billing pending/overdue de
// esos jobs pasan a status 'void' (dejan de contar en "a cobrar").
//
// Es DRY-RUN por default: sólo lista qué haría. Con --apply escribe, y ANTES
// guarda un backup JSON de las filas originales. Con --restore <archivo>
// vuelve todo atrás desde ese backup.
//
// Usa la service_role key contra PostgREST (igual que backup-json.mjs), así
// que saltea RLS. NO la pongas en el repo ni en Vercel: es sólo para correr
// esto desde tu máquina.
//
// Uso (Node 18+):
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/cleanup-old-jobs.mjs                # dry-run
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/cleanup-old-jobs.mjs --apply        # aplica
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/cleanup-old-jobs.mjs --apply --void-billing
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/cleanup-old-jobs.mjs --cutoff 2026-07-01
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/cleanup-old-jobs.mjs --restore backup/cleanup-old-jobs-2026-09-07T12-00-00.json
//
// Variables de entorno:
//   SUPABASE_URL               (default: proyecto noborders-storages)
//   SUPABASE_SERVICE_ROLE_KEY  (obligatoria)
//   BACKUP_DIR                 (default: ./backup)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://szkmktxziojzgfjkomua.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BACKUP_DIR = process.env.BACKUP_DIR || "backup";
const PAGE = 1000;
const CHUNK = 200; // ids por request de update (PostgREST arma la URL con el filtro in.(...))
const ACTOR = "cleanup-old-jobs";

// ── args ──
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APPLY = flag("--apply");
const VOID_BILLING = flag("--void-billing");
const CUTOFF = opt("--cutoff", "2026-06-01"); // exclusivo: fechas < cutoff
const RESTORE = opt("--restore", null);

if (!/^\d{4}-\d{2}-\d{2}$/.test(CUTOFF)) { console.error(`--cutoff inválido: ${CUTOFF} (formato YYYY-MM-DD)`); process.exit(1); }
if (!KEY) { console.error("Falta SUPABASE_SERVICE_ROLE_KEY. Copiala de Supabase → Settings → API Keys."); process.exit(1); }

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path.split("?")[0]}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}
async function fetchAll(path) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await rest(`${path}${sep}limit=${PAGE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}
async function updateByIds(table, ids, patch) {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await rest(`${table}?id=in.(${chunk.join(",")})`, { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=minimal" } });
  }
}

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const jobKey = (j) => j.job_number && j.job_number.trim() ? `n:${j.job_number.trim().toLowerCase()}` : `id:${j.id}`;
const isoDate = (v) => (v ? String(v).slice(0, 10) : "");
// Fecha "de referencia" del job: la más reciente entre sus fechas de negocio.
// Si no tiene ninguna, cae en created_at (jobs cargados sin fechas).
function refDate(rows) {
  let best = "";
  for (const r of rows) for (const f of ["date_in", "pickup_date", "pickup_date_from", "pickup_date_to", "delivery_date", "fadd"]) {
    const d = isoDate(r[f]); if (d && d > best) best = d;
  }
  if (best) return { date: best, from: "dates" };
  for (const r of rows) { const d = isoDate(r.created_at); if (d && d > best) best = d; }
  return { date: best, from: "created_at" };
}

// ── restore ──
async function restore(file) {
  const bk = JSON.parse(await readFile(file, "utf8"));
  console.log(`Restaurando ${bk.jobs.length} filas de storage_jobs y ${bk.billing?.length || 0} de storage_billing desde ${file}…`);
  for (const r of bk.jobs) {
    await rest(`storage_jobs?id=eq.${r.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: r.status, date_out: r.date_out, updated_by: r.updated_by, updated_at: r.updated_at }) });
  }
  for (const b of bk.billing || []) {
    await rest(`storage_billing?id=eq.${b.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: b.status }) });
  }
  console.log("Listo. Todo volvió a como estaba.");
}

// ── main ──
async function main() {
  if (RESTORE) return restore(RESTORE);

  // Candidatas: filas activas (sin date_out, no entregadas ni canceladas, no borradas).
  const rows = await fetchAll(
    "storage_jobs?select=id,job_number,customer,status,date_in,date_out,pickup_date,pickup_date_from,pickup_date_to,delivery_date,fadd,created_at,updated_by,updated_at,billing_active,pickup_balance,delivery_balance,bol_balance,bol_collected,deleted_at"
    + "&deleted_at=is.null&date_out=is.null&or=(status.is.null,status.not.in.(delivered,cancelled))"
  );

  // Agrupo por job (un job puede tener varias filas: varias unidades / split).
  const groups = new Map();
  for (const r of rows) { const k = jobKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

  const chosen = [];
  let keptCount = 0;
  for (const [k, parts] of groups) {
    const ref = refDate(parts);
    if (ref.date && ref.date < CUTOFF) chosen.push({ key: k, parts, ref }); else keptCount++;
  }
  chosen.sort((a, b) => a.ref.date.localeCompare(b.ref.date));

  const chosenIds = chosen.flatMap(c => c.parts.map(p => p.id));
  const chosenIdSet = new Set(chosenIds);
  const billing = chosenIds.length
    ? (await fetchAll("storage_billing?select=id,job_id,status,amount,billing_period_start,billing_period_end&status=in.(pending,overdue)"))
        .filter(b => chosenIdSet.has(b.job_id))
    : [];

  // Resumen
  let outstanding = 0, withBalance = 0, billingActive = 0, noDates = 0;
  const byStatus = {};
  for (const c of chosen) {
    const rep = c.parts[0];
    byStatus[rep.status || "scheduled"] = (byStatus[rep.status || "scheduled"] || 0) + 1;
    const owed = Math.max(0, num(rep.pickup_balance) + num(rep.delivery_balance) + num(rep.bol_balance) - num(rep.bol_collected));
    if (owed > 0) { withBalance++; outstanding += owed; }
    if (c.parts.some(p => p.billing_active)) billingActive++;
    if (c.ref.from === "created_at") noDates++;
  }
  const billingTotal = billing.reduce((s, b) => s + num(b.amount), 0);

  console.log(`\nJobs activos hoy (sin date_out, no delivered/cancelled): ${groups.size} jobs / ${rows.length} filas`);
  console.log(`Corte: fechas < ${CUTOFF}`);
  console.log(`→ Se cierran ${chosen.length} jobs (${chosenIds.length} filas). Quedan activos ${keptCount}.`);
  console.log(`   por status: ${Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join(", ") || "—"}`);
  console.log(`   sin fechas (se usó created_at): ${noDates}`);
  console.log(`   con storage billing activo: ${billingActive}`);
  console.log(`   con saldo a cobrar en el job: ${withBalance} jobs, ${money(outstanding)} (NO se toca; ver nota al final)`);
  console.log(`   storage_billing pending/overdue de esos jobs: ${billing.length} filas, ${money(billingTotal)}${VOID_BILLING ? " → pasan a 'void'" : " (usá --void-billing para anularlas)"}`);

  console.log("\nDetalle (fecha de referencia · job # · cliente · status):");
  for (const c of chosen) {
    const r = c.parts[0];
    console.log(`  ${c.ref.date}${c.ref.from === "created_at" ? "*" : " "} ${String(r.job_number || "(sin #)").padEnd(14)} ${String(r.customer || "").slice(0, 28).padEnd(28)} ${r.status || "scheduled"}${c.parts.length > 1 ? ` (${c.parts.length} filas)` : ""}`);
  }
  if (noDates) console.log("  * = job sin fechas de negocio; se usó created_at como referencia.");

  if (!chosen.length) { console.log("\nNada para cerrar."); return; }
  if (!APPLY) { console.log("\nDRY-RUN: no se cambió nada. Volvé a correr con --apply para aplicar."); return; }

  // Backup de las filas originales antes de tocar nada.
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(BACKUP_DIR, `cleanup-old-jobs-${stamp}.json`);
  await writeFile(file, JSON.stringify({ cutoff: CUTOFF, appliedAt: new Date().toISOString(), jobs: chosen.flatMap(c => c.parts), billing: VOID_BILLING ? billing : [] }, null, 2));
  console.log(`\nBackup guardado en ${file} (para volver atrás: --restore ${file})`);

  // Aplico: agrupo por date_out para hacer pocos requests.
  const now = new Date().toISOString();
  const byOut = new Map();
  for (const c of chosen) { if (!byOut.has(c.ref.date)) byOut.set(c.ref.date, []); byOut.get(c.ref.date).push(...c.parts.map(p => p.id)); }
  let done = 0;
  for (const [dateOut, ids] of byOut) {
    await updateByIds("storage_jobs", ids, { status: "delivered", date_out: dateOut, updated_by: ACTOR, updated_at: now });
    done += ids.length;
  }
  console.log(`Cerradas ${done} filas de storage_jobs como delivered.`);

  if (VOID_BILLING && billing.length) {
    await updateByIds("storage_billing", billing.map(b => b.id), { status: "void", notes: `anulado por ${ACTOR} ${now.slice(0, 10)}` });
    console.log(`Anuladas ${billing.length} filas de storage_billing.`);
  }

  console.log("\nListo. Abrí el CRM / la app mobile y refrescá.");
  if (withBalance) console.log(`Nota: ${withBalance} de estos jobs siguen con saldo (${money(outstanding)}) en "a cobrar" porque el saldo es un dato aparte del status. Si esos saldos ya se cobraron o no se van a cobrar, hay que resolverlos aparte (registrar el pago o dar de baja el saldo).`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
