#!/usr/bin/env node
// Unit tests for the Customer Line (lib/customerLine.mjs + customerLineData.mjs
// + its door in api/agent-hub.mjs). Pure: the store is an in-memory stand-in,
// so this runs with no Supabase project and no network.
//
//   node scripts/test-customer-line.mjs
import {
  normJobNumber, jobSearchFragment, matchingJobs, zip5, last4, factorsMatch, cityLevel, firstName,
  jobBalance, customerSnapshot, deliverySummary, validateChange, callbackPhone, teamMessage, MAX_FAILED_PER_CALL, MAX_FAILED_PER_JOB,
} from "../lib/customerLineData.mjs";
import { runCustomerLineTool } from "../lib/customerLine.mjs";
import { customerLine } from "../api/agent-hub.mjs";

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`✗ ${name}\n   esperado: ${JSON.stringify(want)}\n   obtenido: ${JSON.stringify(got)}`); }
  else console.log(`✓ ${name}`);
};
const ok = (name, cond) => eq(name, !!cond, true);

const NOW = new Date("2026-10-04T15:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

// ── Identity ─────────────────────────────────────────────────────────────────
eq("número dictado: se queda con letras y dígitos", normJobNumber("#nb-1201"), "NB1201");
eq("'Job 1201' es el job 1201", normJobNumber("Job 1201"), "1201");
eq("'job number 1201' es el job 1201", normJobNumber("job number 1201"), "1201");
eq("busca por los últimos dígitos (el guardado puede tener guiones)", jobSearchFragment("ATL 2024 1201"), "1201");
eq("demasiado corto para buscar", jobSearchFragment("12"), null);
eq("ZIP de 4 dígitos perdió el 0", zip5("7102"), "07102");
eq("ZIP+4", zip5("07102-1234"), "07102");
eq("ZIP inválido", zip5("123"), null);
eq("últimos 4 del teléfono", last4("(973) 555-0142"), "0142");

const ROWS = [
  { id: 11, job_number: "ATL-2024-1201", customer: "Doe, Jane", created_at: "2026-09-01", delivery_zip: "07102", pickup_zip: "33101", client_phone: "+1 (973) 555-0142" },
  { id: 12, job_number: "ATL-2024-1201", customer: "Doe, Jane", created_at: "2026-09-02", delivery_zip: null, pickup_zip: null, client_phone: null },
  { id: 13, job_number: "ATL-2024-1201", customer: "Doe, Jane", created_at: "2026-09-03", deleted_at: "2026-09-04" },
  { id: 14, job_number: "1201", customer: "Otro", created_at: "2026-09-01", delivery_zip: "90210" },
];
{
  const g = matchingJobs(ROWS, "atl 2024 1201");
  eq("agrupa las filas del job lógico, sin las borradas, la más nueva primero", g.map((x) => x.rows.map((r) => r.id)), [[12, 11]]);
  eq("no confunde 1201 con ATL-2024-1201", matchingJobs(ROWS, "1201").map((x) => x.rows.map((r) => r.id)), [[14]]);
  const rows = g[0].rows;
  eq("verifica por ZIP de entrega (en cualquier fila del job)", factorsMatch(rows, { zip: "07102" }), { ok: true, factor: "zip" });
  eq("verifica por ZIP de pickup", factorsMatch(rows, { zip: "33101" }).ok, true);
  eq("verifica por últimos 4 del teléfono", factorsMatch(rows, { phone_last4: "0142" }), { ok: true, factor: "phone_last4" });
  eq("ZIP equivocado no verifica", factorsMatch(rows, { zip: "10001" }), { ok: false, reason: "mismatch" });
  eq("sin segundo factor no verifica", factorsMatch(rows, {}), { ok: false, reason: "no_factor" });
  eq("job sin nada contra qué verificar", factorsMatch([{ id: 1 }], { zip: "07102" }), { ok: false, reason: "nothing_on_file" });
}

// ── What the customer may hear ───────────────────────────────────────────────
eq("ubicación: 'X mi NE of' → ciudad", cityLevel("5 mi NE of Plymouth, IN"), "Plymouth, IN");
eq("ubicación: dirección completa → ciudad", cityLevel("123 Main St, Richmond, VA 23220, USA"), "Richmond, VA");
eq("ubicación: estado escrito entero", cityLevel("Ocala, Florida, United States"), "Ocala, FL");
eq("ubicación: St. Louis es una ciudad", cityLevel("St. Louis, MO"), "St. Louis, MO");
eq("ubicación: una calle nunca se lee", cityLevel("Main St, Washington"), null);
eq("ubicación: sin ciudad reconocible, nada", cityLevel("123 Main St"), null);
eq("nombre de pila de 'Apellido, Nombre'", firstName("Doe, Jane"), "Jane");
eq("nombre de pila de 'Jane & John Doe'", firstName("Jane & John Doe"), "Jane");

// The CRM's jobOutstanding (src/App.jsx:6533), case by case.
{
  const rep = { status: "picked_up", pickup_balance: 1000, delivery_balance: 2000, bol_balance: 0, bol_collected: 0 };
  const payments = [
    { concept: "job", amount: 600, discount: 100, received: true },  // net 500
    { concept: "job", amount: 300, received: false },                // not received: doesn't count
    { concept: "job", amount: 999, received: true, deleted_at: "x" }, // deleted: doesn't count
    { concept: "extra", amount: 50, received: true },
    { concept: "on_account", amount: 400, received: true },          // the CRM doesn't count it either
  ];
  const extras = [{ amount: 200 }, { amount: 100, active: false }, { amount: 70, deleted_at: "x" }];
  eq("saldo = (balances − cobrado) + extras abiertos", jobBalance({ rep, payments, extras }),
    { total_due: 2650, due_at_pickup: 0, due_at_delivery: 2650, paid_so_far: 550 });
  eq("bol_collected manda cuando es mayor que los pagos (no se suman: están sincronizados)",
    jobBalance({ rep: { ...rep, bol_collected: 800 }, payments, extras }).total_due, 2350);
  eq("job scheduled: lo que queda del pickup balance se paga en el pickup",
    jobBalance({ rep: { ...rep, status: "scheduled" }, payments, extras }),
    { total_due: 2650, due_at_pickup: 500, due_at_delivery: 2150, paid_so_far: 550 });
  eq("pagado de más no da saldo negativo",
    jobBalance({ rep, payments: [{ concept: "job", amount: 5000, received: true }] }).total_due, 0);
}

// The whitelist: nothing private ever leaves the server.
{
  const row = {
    id: 21, job_number: "NB-7001", customer: "Doe, Jane", created_at: "2026-09-01", status: "picked_up",
    client_phone: "973-555-0142", client_email: "jane@example.com", pickup_address: "1 Secret Ln", delivery_address: "2 Hidden Ave",
    pickup_zip: "33101", delivery_zip: "07102", delivery_city: "Newark", delivery_state: "NJ", notes: "gate code 4455",
    carrier_notes: "dog bites", broker_id: 3, driver: "Carlos", price_per_cf: 4.5, estimate: 9000, deposit: 1500,
    fadd: "2026-10-08", delivery_date: null, trip_id: 5, pickup_balance: 0, delivery_balance: 2340, bol_balance: 0,
  };
  const snap = customerSnapshot({
    rows: [row], now: NOW,
    trips: [{ id: 5, status: "in_transit", truck_id: 9 }],
    trucks: [{ id: 9, last_location: "1200 Broad St, Richmond, VA 23219", last_location_at: hoursAgo(3) }],
  });
  const json = JSON.stringify(snap);
  for (const secret of ["jane@example.com", "555-0142", "Secret Ln", "Hidden Ave", "07102", "33101", "gate code", "dog bites", "Carlos", "Broad St", "9000", "1500"]) {
    ok(`no sale "${secret}"`, !json.includes(secret));
  }
  eq("solo campos de la lista blanca", Object.keys(snap), [
    "job_number", "customer_first_name", "status", "status_meaning", "pickup", "first_available_delivery_date",
    "scheduled_delivery_date", "delivered_on", "delivery_summary", "delivery_to", "truck_last_seen", "balance", "storage",
  ]);
  eq("FADD sin fecha agendada: la frase dice que no está agendada y que no es una promesa", snap.delivery_summary,
    "Delivery is not scheduled yet. 2026-10-08 is the first available delivery date (FADD): the earliest day we could deliver, not a booked day.");
  eq("camión en viaje con posición fresca: ciudad y hace cuánto", snap.truck_last_seen, { near: "Richmond, VA", hours_ago: 3 });
  eq("fecha no agendada viaja como null (el agente no inventa)", snap.scheduled_delivery_date, null);
  eq("destino: ciudad y estado", snap.delivery_to, "Newark, NJ");

  const stale = customerSnapshot({ rows: [row], now: NOW, trips: [{ id: 5, status: "in_transit", truck_id: 9 }], trucks: [{ id: 9, last_location: "Richmond, VA", last_location_at: hoursAgo(48) }] });
  eq("posición vieja no se dice", stale.truck_last_seen, null);
  const loading = customerSnapshot({ rows: [row], now: NOW, trips: [{ id: 5, status: "loading", truck_id: 9 }], trucks: [{ id: 9, last_location: "Richmond, VA", last_location_at: hoursAgo(1) }] });
  eq("trip que no salió: no hay ubicación", loading.truck_last_seen, null);

  const split = customerSnapshot({ rows: [row, { ...row, id: 22, status: "delivered" }], now: NOW });
  eq("job partido en estados distintos", [split.status, split.portions.map((p) => p.status)], ["split", ["picked_up", "delivered"]]);

  const stored = customerSnapshot({
    rows: [{ ...row, status: "in_storage", trip_id: null, warehouse: "Indiana", date_in: "2026-09-10", billing_active: true, client_monthly_rate: 250 }],
    billing: [{ status: "pending", amount: 250, billing_period_end: "2026-09-30" }, { status: "pending", amount: 250, billing_period_end: "2026-10-31" }],
    now: NOW,
  });
  eq("storage: dónde, desde cuándo, cuánto y qué está vencido", stored.storage,
    { location: "our Indiana warehouse", stored_since: "2026-09-10", monthly_rate: 250, first_month_free: false, rent_pending: 500, rent_overdue: 250 });
}

eq("entrega agendada", deliverySummary({ scheduled: "2026-10-10", fadd: "2026-10-08" }), "Delivery is scheduled for 2026-10-10.");
eq("entregado", deliverySummary({ delivered: true, deliveredOn: "2026-09-30" }), "Delivered on 2026-09-30.");
eq("sin FADD ni fecha", deliverySummary({}), "Delivery is not scheduled yet, and there is no first available delivery date on file.");
eq("cambio: kind inválido", validateChange({ kind: "teleport", details: "x" }).ok, false);
eq("cambio: sin detalle", validateChange({ kind: "delivery_date" }).ok, false);
eq("teléfono de callback: 10 dígitos", callbackPhone("+1 (305) 555-0100"), "3055550100");
eq("teléfono de callback: incompleto no sirve", callbackPhone("555-0100", null), null);

// ── The tools, end to end against an in-memory store ─────────────────────────
function memoryStore(jobRows, ledger = {}) {
  const s = { sessions: new Map(), events: [], requests: [], nextId: 100 };
  s.api = {
    async jobRows(fragment) { return jobRows.filter((r) => String(r.job_number).toUpperCase().includes(fragment) || normJobNumber(r.job_number).includes(fragment)); },
    async ledger() { return { payments: [], extras: [], billing: [], trips: [], trucks: [], ...ledger }; },
    async getSession(cid) { return s.sessions.get(cid) || null; },
    async saveSession(cid, patch) { s.sessions.set(cid, { ...(s.sessions.get(cid) || { conversation_id: cid, failed_attempts: 0 }), ...patch }); },
    async recentJobFailures(ref, since) { return s.events.filter((e) => e.job_ref === ref && e.outcome === "verify_failed" && (e.created_at || NOW.toISOString()) >= since).length; },
    async logEvent(e) { s.events.push(e); },
    async insertRequest(r) { const row = { id: s.nextId++, status: "open", created_at: NOW.toISOString(), ...r }; s.requests.push(row); return row; },
    async claimStaged(cid, stagedAt, claimedAt) {
      const x = s.sessions.get(cid);
      if (!x || x.staged_at !== stagedAt) return false;
      s.sessions.set(cid, { ...x, staged_at: null, last_request_id: null, last_request_at: claimedAt });
      return true;
    },
    async findRecentChange(cid, since) { return s.requests.filter((r) => r.conversation_id === cid && r.kind === "change" && r.created_at >= since).at(-1) || null; },
    async findOpenCallback(cid, topic) { return s.requests.find((r) => r.conversation_id === cid && r.kind === "callback" && r.topic === topic) || null; },
  };
  return s;
}
const JOB = [{ id: 31, job_number: "7001", customer: "Jane Doe", created_at: "2026-09-01", status: "out_for_delivery", delivery_zip: "07102", client_phone: "9735550142", delivery_city: "Newark", delivery_state: "NJ", delivery_balance: 2340 }];
const call = (s, tool, input, extra = {}) => runCustomerLineTool({
  tool, input, conversationId: extra.cid || "conv_1", callerId: extra.callerId || null,
  deps: { store: s.api, notify: extra.notify || (async () => true), now: extra.now || NOW, sleep: extra.sleep || (async () => {}) },
});

{
  const s = memoryStore(JOB);
  const r = await call(s, "verify_and_get_job", { job_number: "7001", zip: "7102" });
  eq("verifica y devuelve el job", [r.ok, r.verified, r.job.job_number, r.job.balance.total_due], [true, true, "7001", 2340]);
  eq("la sesión queda verificada en el servidor", s.sessions.get("conv_1").job_number, "7001");
  eq("auditado", s.events.at(-1).outcome, "verified");
}

{
  const s = memoryStore(JOB);
  const wrongZip = await call(s, "verify_and_get_job", { job_number: "7001", zip: "10001" });
  const s2 = memoryStore(JOB);
  const noJob = await call(s2, "verify_and_get_job", { job_number: "9999", zip: "07102" });
  eq("job inexistente y ZIP equivocado se contestan igual (no hay oráculo)", wrongZip, noJob);
  eq("quedan intentos", wrongZip.attempts_left, MAX_FAILED_PER_CALL - 1);
  await call(s, "verify_and_get_job", { job_number: "7001", zip: "10002" });
  const third = await call(s, "verify_and_get_job", { job_number: "7001", zip: "10003" });
  eq(`al ${MAX_FAILED_PER_CALL}º fallo se bloquea la llamada`, third.error, "locked");
  const after = await call(s, "verify_and_get_job", { job_number: "7001", zip: "07102" });
  eq("bloqueada, ni con el ZIP correcto", [after.ok, after.error, "job" in after], [false, "locked", false]);
}

{
  const s = memoryStore(JOB);
  for (let i = 0; i < MAX_FAILED_PER_JOB; i++) s.events.push({ job_ref: "7001", outcome: "verify_failed", created_at: hoursAgo(1) });
  const r = await call(s, "verify_and_get_job", { job_number: "7001", zip: "07102" }, { cid: "conv_new" });
  eq("muchos fallos sobre un job en 24h (en llamadas distintas) lo bloquean", [r.ok, r.error], [false, "locked"]);
  const s2 = memoryStore(JOB);
  s2.events.push(...s.events);
  const fake = await call(s2, "verify_and_get_job", { job_number: "7001", zip: "07102" }, { cid: "conv_other" });
  eq("el bloqueo por job no revela si existe (cuenta lo que se dictó)", fake.error, "locked");
}

{
  const s = memoryStore(JOB);
  eq("bad input no cuenta como intento", (await call(s, "verify_and_get_job", { job_number: "7001" })).error, "missing_factor");
  eq("…y no suma fallos", s.sessions.get("conv_1"), undefined);
}

{
  const s = memoryStore(JOB);
  eq("pedido de cambio sin verificar: no", (await call(s, "request_change", { kind: "delivery_date", details: "move it" })).error, "not_verified");
  await call(s, "verify_and_get_job", { job_number: "7001", phone_last4: "0142" });
  eq("confirmar sin read-back: no", (await call(s, "request_change", { confirmed: true, kind: "delivery_date", details: "x" })).error, "nothing_staged");

  const staged = await call(s, "request_change", { kind: "delivery_date", details: "Move delivery to Oct 14, mornings", preferred_date: "2026-10-14" });
  ok("el read-back nombra el job y el pedido", staged.staged && staged.readback.includes("7001") && staged.readback.includes("Oct 14"));
  eq("stagear no escribe nada", s.requests.length, 0);

  const pings = [];
  const done = await call(s, "request_change", { confirmed: "true", kind: "delivery_address", details: "something else entirely", job_number: "9999" },
    { notify: async (t) => { pings.push(t); return true; } });
  eq("confirmar escribe EXACTAMENTE lo leído (no los args nuevos, ni otro job)",
    [s.requests.length, s.requests[0].topic, s.requests[0].details, s.requests[0].job_number, s.requests[0].verified],
    [1, "delivery_date", "Move delivery to Oct 14, mornings", "7001", true]);
  eq("referencia", done.reference, `CR-${s.requests[0].id}`);
  ok("dispatch recibe el aviso con la referencia", pings[0]?.includes(done.reference) && pings[0].includes("Nothing on the job has changed"));

  const again = await call(s, "request_change", { confirmed: true });
  eq("doble 'sí' no duplica el pedido", [again.already_submitted, again.reference, s.requests.length], [true, done.reference, 1]);
}

{
  const s = memoryStore(JOB);
  await call(s, "verify_and_get_job", { job_number: "7001", zip: "07102" });
  await call(s, "request_change", { kind: "other", details: "x" });
  const late = await call(s, "request_change", { confirmed: true }, { now: new Date(NOW.getTime() + 20 * 60000) });
  eq("un read-back vencido no se confirma", late.error, "nothing_staged");
}

{
  // A confirmation slow enough for the platform to time out, and the model's
  // retry arriving while the first one is still filing (seen live: a 10 s tool
  // timeout, then "let me try that once more").
  const s = memoryStore(JOB);
  await call(s, "verify_and_get_job", { job_number: "7001", zip: "07102" });
  await call(s, "request_change", { kind: "delivery_date", details: "Move it to Oct 14", preferred_date: "2026-10-14" });
  let release;
  const gate = new Promise((r) => { release = r; });
  setTimeout(() => release(), 50);  // so code that never waits fails the check instead of hanging
  const insert = s.api.insertRequest;
  s.api.insertRequest = async (r) => { await gate; return insert(r); };
  const first = call(s, "request_change", { confirmed: true });
  const retry = call(s, "request_change", { confirmed: true }, { sleep: async () => { release(); await new Promise((r) => setTimeout(r, 0)); } });
  const [a, b] = await Promise.all([first, retry]);
  eq("un reintento mientras el primero sigue guardando no duplica el pedido",
    [s.requests.length, a.submitted, b.reference, b.already_submitted], [1, true, a.reference, true]);
}

{
  const s = memoryStore(JOB);
  await call(s, "verify_and_get_job", { job_number: "7001", zip: "07102" });
  await call(s, "request_change", { kind: "delivery_date", details: "Move it to Oct 14" });
  const s2claim = await s.api.claimStaged("conv_1", s.sessions.get("conv_1").staged_at, NOW.toISOString());
  const waiting = await call(s, "request_change", { confirmed: true });
  eq("si el otro sigue guardando sin terminar, pide esperar y no vuelve a stagear", [s2claim, waiting.error, s.requests.length], [true, "submitting", 0]);
}

{
  const s = memoryStore(JOB);
  await call(s, "verify_and_get_job", { job_number: "7001", zip: "07102" });
  await call(s, "request_change", { kind: "delivery_date", details: "Move it to Oct 14" });
  const insert = s.api.insertRequest;
  let fail = true;
  s.api.insertRequest = async (r) => { if (fail) { fail = false; throw new Error("db down"); } return insert(r); };
  let threw = false;
  try { await call(s, "request_change", { confirmed: true }); } catch { threw = true; }
  const retry = await call(s, "request_change", { confirmed: true });
  eq("si el guardado falla, el mismo sí se reintenta sin otro read-back",
    [threw, retry.submitted, retry.already_submitted, s.requests.length], [true, true, undefined, 1]);
}

{
  const s = memoryStore(JOB);
  eq("callback de alguien no verificado sin teléfono: lo pide", (await call(s, "request_callback", { topic: "quote", reason: "Wants a quote" })).error, "need_phone");
  const r = await call(s, "request_callback", { topic: "quote", reason: "Wants a quote Miami → Boston", caller_name: "Bob", job_number: "7001" }, { callerId: "+13055550100" });
  eq("…con caller ID alcanza; el job que dice NO queda como verificado",
    [r.ok, s.requests[0].callback_phone, s.requests[0].job_number, s.requests[0].claimed_job_number, s.requests[0].verified],
    [true, "3055550100", null, "7001", false]);
  const dup = await call(s, "request_callback", { topic: "quote", reason: "again" }, { callerId: "+13055550100" });
  eq("mismo tema en la misma llamada no duplica", [dup.already_submitted, s.requests.length], [true, 1]);
}

{
  const s = memoryStore(JOB);
  await call(s, "verify_and_get_job", { job_number: "7001", zip: "07102" });
  const r = await call(s, "request_callback", { topic: "refund", reason: "Wants a refund for the delay", urgency: "urgent" }, { notify: async () => false });
  eq("verificado: el callback lleva el job; Telegram caído no pierde el pedido",
    [r.ok, r.team_notified, s.requests[0].job_number, s.requests[0].verified, s.requests[0].urgency], [true, false, "7001", true, "urgent"]);
  ok("el aviso del callback marca la urgencia", teamMessage(s.requests[0]).includes("URGENT"));
}

// ── The door (api/agent-hub.mjs) ─────────────────────────────────────────────
const SECRET = "linea-de-prueba";
const fakeRes = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } });
const withEnv = async (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  try { return await fn(); } finally { process.env = saved; }
};
const door = async (headers, body) => {
  const res = fakeRes();
  await customerLine({ headers, body, query: {} }, res, { store: memoryStore(JOB).api, notify: async () => true, now: NOW });
  return res;
};
const BODY = { tool: "verify_and_get_job", conversation_id: "conv_x", job_number: "7001", zip: "07102" };

await withEnv({ CUSTOMER_LINE_SECRET: undefined }, async () => {
  eq("sin CUSTOMER_LINE_SECRET no entra nadie", (await door({ "x-customer-line-secret": "x" }, BODY)).statusCode, 503);
});
await withEnv({ CUSTOMER_LINE_SECRET: SECRET, VOICE_AGENT_SECRET: "otro" }, async () => {
  eq("secret equivocado: 401", (await door({ "x-customer-line-secret": "nope" }, BODY)).statusCode, 401);
  eq("el secret del agente interno no abre esta puerta", (await door({ "x-agent-secret": "otro" }, BODY)).statusCode, 401);
  const unknown = await door({ "x-customer-line-secret": SECRET }, { ...BODY, tool: "crm_lookup" });
  eq("tool desconocida: 400 con la lista", [unknown.statusCode, unknown.body.valid_tools], [400, ["verify_and_get_job", "request_change", "request_callback"]]);
  eq("sin conversation_id: 400", (await door({ "x-customer-line-secret": SECRET }, { ...BODY, conversation_id: "" })).statusCode, 400);
  const good = await door({ "x-customer-line-secret": SECRET }, BODY);
  eq("secret correcto: 200 y verifica", [good.statusCode, good.body.verified], [200, true]);
  const nested = await door({ "x-customer-line-secret": SECRET }, { tool: "verify_and_get_job", conversation_id: "conv_y", input: { job_number: "7001", zip: "07102" } });
  eq("acepta los parámetros anidados en input", nested.body.verified, true);
  const res = fakeRes();
  await customerLine({ headers: { "x-customer-line-secret": SECRET }, body: BODY, query: {} }, res,
    { store: { ...memoryStore(JOB).api, getSession: async () => { throw new Error("db down"); } }, notify: async () => true, now: NOW });
  eq("si la base falla, igual hay algo para decir", [res.statusCode, res.body.error], [200, "system_error"]);
});

if (failed) { console.error(`\n✗ ${failed} test(s) fallaron`); process.exit(1); }
console.log("\n✓ Customer Line: todo OK");
