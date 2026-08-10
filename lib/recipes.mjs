// Domain recipes: the operations that carry real business rules, replicating
// exactly what the CRM's own UI does. Anything simpler (plain CRUD on brokers,
// drivers, trucks, claims, …) goes through the generic table path in
// lib/agentWrite.mjs instead — these exist so the agent can't produce data the
// app would never produce.
//
// Each recipe declares:
//   perms:    [[table, op], …]  permissions the caller needs
//   describe: (args) => human-readable line for the confirmation message
//   validate: async (args, ctx) => string[]   (empty = ok)
//   run:      async (args, ctx) => { entries, summary }   entries = audit rows
import { admin } from "./clients.mjs";
import { execInsert, execUpdate, tableColumns } from "./agentWrite.mjs";
import { buildJobCharges, proposeAllocation } from "./paymentAlloc.mjs";

const TZ = "America/New_York";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? 0 : Number(v));
const PHYSICAL_METHODS = ["cash", "check", "money_order"];
const isDigitalMethod = (m) => !!m && !PHYSICAL_METHODS.includes(m);

// A logical job spans several storage_jobs rows sharing job_number.
async function jobRows(jobNumber) {
  const { data, error } = await admin.from("storage_jobs")
    .select("*").eq("job_number", String(jobNumber).trim()).is("deleted_at", null);
  if (error) throw new Error(`buscando el job ${jobNumber}: ${error.message}`);
  return data || [];
}
const rowIds = (rows) => rows.map((r) => r.id);
const repRow = (rows) => rows.slice().sort((a, b) => a.id - b.id)[0]; // representative row (min id), same as the app

async function nextTripNumber() {
  const { data } = await admin.from("trips").select("trip_number").is("deleted_at", null);
  let max = 0;
  for (const t of data || []) {
    const m = String(t.trip_number || "").match(/(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "TRIP-" + String(max + 1).padStart(3, "0");
}

// Jobs are attached to a trip by storage_jobs.trip_id + trip_stop_order — never
// by trip_stops rows (those are non-job stops: fuel, scale, maintenance…).
async function attachJobs({ tripId, jobNumbers, purpose, ctx }) {
  const { data: trip } = await admin.from("trips").select("id, status, trip_number").eq("id", tripId).maybeSingle();
  if (!trip) throw new Error(`el trip ${tripId} no existe`);
  const { data: current } = await admin.from("storage_jobs").select("trip_stop_order").eq("trip_id", tripId).is("deleted_at", null);
  let order = Math.max(0, ...(current || []).map((r) => num(r.trip_stop_order)));

  const entries = [];
  const attached = [];
  for (const jn of jobNumbers) {
    const rows = await jobRows(jn);
    if (!rows.length) throw new Error(`no encuentro el job ${jn}`);
    order += 1;
    const patch = { trip_id: tripId, trip_stop_order: order, trip_purpose: purpose === "relocation" ? "relocation" : "delivery" };
    // Loading trip → the job keeps its status. In-transit trip → it's going on
    // the truck now (App.jsx tripAddExistingJob / splitJob rule).
    if (trip.status === "in_transit") {
      const r = repRow(rows);
      if (!r.date_out) patch.status = purpose === "relocation" ? "picked_up" : "out_for_delivery";
    }
    entries.push(...(await execUpdate("storage_jobs", rowIds(rows), patch, ctx)));
    attached.push(jn);
    if (trip.status === "in_transit") {
      entries.push(...(await execInsert("trip_events", {
        trip_id: tripId, event_type: "job_added", job_id: repRow(rows).id,
        notes: `Agregado por el agente`,
      }, ctx)));
    }
  }
  return { entries, attached, trip };
}

export const RECIPES = {
  create_trip: {
    perms: [["trips", "insert"], ["storage_jobs", "update"]],
    doc: "{ trip_number?, truck_id?, driver_id?, departure_date?, notes?, job_numbers?: [], purpose?: 'delivery'|'relocation' } — crea el trip en estado loading y engancha los jobs en orden",
    describe: (a) => `Crear trip ${a.trip_number || "(número automático)"}${a.truck_id ? ` · camión #${a.truck_id}` : ""}${a.driver_id ? ` · driver #${a.driver_id}` : ""}${a.departure_date ? ` · sale ${a.departure_date}` : ""}${a.job_numbers?.length ? ` con ${a.job_numbers.length} job(s): ${a.job_numbers.join(", ")}` : " sin jobs"}`,
    validate: async (a) => {
      const errs = [];
      for (const jn of a.job_numbers || []) {
        const rows = await jobRows(jn);
        if (!rows.length) { errs.push(`no encuentro el job ${jn}`); continue; }
        const busy = rows.find((r) => r.trip_id);
        if (busy) errs.push(`el job ${jn} ya está en el trip #${busy.trip_id}`);
      }
      return errs;
    },
    run: async (a, ctx) => {
      const entries = await execInsert("trips", {
        trip_number: a.trip_number || (await nextTripNumber()),
        truck_id: a.truck_id ?? null, driver_id: a.driver_id ?? null,
        departure_date: a.departure_date || null, notes: a.notes || null, status: "loading",
      }, ctx);
      const tripId = entries[0].after.id;
      const res = await attachJobs({ tripId, jobNumbers: a.job_numbers || [], purpose: a.purpose, ctx });
      return {
        entries: [...entries, ...res.entries],
        summary: `Trip ${entries[0].after.trip_number} creado con ${res.attached.length} job(s)`,
      };
    },
  },

  assign_jobs_to_trip: {
    perms: [["storage_jobs", "update"]],
    doc: "{ trip_id, job_numbers: [], purpose?: 'delivery'|'relocation' }",
    describe: (a) => `Agregar al trip #${a.trip_id} los jobs: ${(a.job_numbers || []).join(", ")}`,
    validate: async (a) => {
      const errs = [];
      const { data: trip } = await admin.from("trips").select("id, status").eq("id", a.trip_id).is("deleted_at", null).maybeSingle();
      if (!trip) errs.push(`el trip #${a.trip_id} no existe`);
      else if (!["loading", "in_transit"].includes(trip.status)) errs.push(`el trip #${a.trip_id} está ${trip.status}: no admite jobs`);
      for (const jn of a.job_numbers || []) if (!(await jobRows(jn)).length) errs.push(`no encuentro el job ${jn}`);
      return errs;
    },
    run: async (a, ctx) => {
      const res = await attachJobs({ tripId: a.trip_id, jobNumbers: a.job_numbers || [], purpose: a.purpose, ctx });
      return { entries: res.entries, summary: `${res.attached.length} job(s) agregados al trip ${res.trip.trip_number || a.trip_id}` };
    },
  },

  remove_jobs_from_trip: {
    perms: [["storage_jobs", "update"]],
    doc: "{ job_numbers: [] }",
    describe: (a) => `Sacar del trip los jobs: ${(a.job_numbers || []).join(", ")}`,
    run: async (a, ctx) => {
      const entries = [];
      for (const jn of a.job_numbers || []) {
        const rows = await jobRows(jn);
        if (!rows.length) throw new Error(`no encuentro el job ${jn}`);
        entries.push(...(await execUpdate("storage_jobs", rowIds(rows), { trip_id: null, trip_stop_order: null, trip_purpose: null }, ctx)));
      }
      return { entries, summary: `${(a.job_numbers || []).length} job(s) desasignados del trip` };
    },
  },

  set_trip_status: {
    perms: [["trips", "update"]],
    doc: "{ trip_id, status: 'loading'|'in_transit'|'completed'|'cancelled' }",
    describe: (a) => `Cambiar el trip #${a.trip_id} a estado "${a.status}"`,
    validate: async (a) => (["loading", "in_transit", "completed", "cancelled"].includes(a.status) ? [] : [`estado de trip inválido: "${a.status}"`]),
    run: async (a, ctx) => ({
      entries: await execUpdate("trips", [a.trip_id], { status: a.status }, ctx),
      summary: `Trip #${a.trip_id} → ${a.status}`,
    }),
  },

  // Records a payment following the app's payPayload contract + allocation
  // rules: job balance first, then extras oldest-first, remainder on account.
  record_payment: {
    perms: [["payments", "insert"], ["storage_jobs", "update"]],
    doc: "{ job_number, amount, method, payment_date?, method_id?, payment_stage?, notes?, received?, banked?, bank_account?, cash_with_whom?, cc_fee_enabled?, cc_fee_pct? } — reparte solo: primero el balance del job, después los extras más viejos, resto a cuenta",
    describe: (a) => `Imputar pago de $${num(a.amount).toLocaleString()} (${a.method || "método?"}) al job ${a.job_number}${a.payment_date ? ` con fecha ${a.payment_date}` : ""}`,
    validate: async (a) => {
      const errs = [];
      if (!(num(a.amount) > 0)) errs.push("el monto del pago debe ser mayor a 0");
      if (!(await jobRows(a.job_number)).length) errs.push(`no encuentro el job ${a.job_number}`);
      return errs;
    },
    run: async (a, ctx) => {
      const rows = await jobRows(a.job_number);
      const ids = rowIds(rows);
      const rep = repRow(rows);
      const expected = num(rep.pickup_balance) + num(rep.delivery_balance) + num(rep.bol_balance);
      const [{ data: extras }, { data: pays }] = await Promise.all([
        admin.from("job_extras").select("*").in("job_id", ids).is("deleted_at", null),
        admin.from("payments").select("*").in("job_id", ids).is("deleted_at", null),
      ]);
      const charges = buildJobCharges({ expected, extras: extras || [], payments: pays || [] });
      const total = num(a.amount);
      const { lines, unassigned } = proposeAllocation(total, charges);

      const digital = isDigitalMethod(a.method);
      const received = digital ? true : a.received !== false;
      const banked = digital ? true : !!a.banked;
      const date = a.payment_date || today();
      const splitGroup = lines.filter((l) => num(l.amount) > 0).length + (unassigned > 0 ? 1 : 0) > 1 ? crypto.randomUUID() : null;
      const base = {
        job_id: rep.id, payment_date: date, method: a.method || null, method_id: a.method_id || null,
        discount: 0, received, received_date: received ? date : null,
        banked, banked_date: banked ? date : null, bank_account: banked ? (a.bank_account || null) : null,
        cash_with_whom: (!digital && !banked) ? (a.cash_with_whom || rep.driver || null) : null,
        payment_stage: a.payment_stage || null, notes: a.notes || null, split_group: splitGroup,
      };

      const entries = [];
      let jobLineAmount = 0;
      for (const l of lines) {
        const amt = num(l.amount);
        if (amt <= 0) continue;
        if (l.kind === "job") jobLineAmount += amt;
        entries.push(...(await execInsert("payments", {
          ...base, amount: amt,
          concept: l.kind === "extra" ? "extra" : "job",
          job_extra_id: l.job_extra_id ?? null,
        }, ctx)));
      }
      if (unassigned > 0) {
        entries.push(...(await execInsert("payments", {
          ...base, amount: unassigned, concept: "on_account", notes: a.notes || "A cuenta — sin imputar",
        }, ctx)));
      }
      // Credit-card fee child row (the app inserts a separate cc_fee payment).
      if (a.method === "credit_card" && a.cc_fee_enabled) {
        const pct = num(a.cc_fee_pct) || 3;
        entries.push(...(await execInsert("payments", {
          ...base, amount: Math.round(total * pct) / 100, concept: "cc_fee", received: true, banked: true,
          banked_date: date, notes: `Fee ${pct}% tarjeta`,
        }, ctx)));
      }
      // Mirror the collected total onto every row of the job (the app keeps
      // bol_collected in sync with job-concept payments).
      if (jobLineAmount > 0) {
        const collected = (pays || []).filter((p) => p.received && p.concept === "job")
          .reduce((s, p) => s + num(p.amount) - num(p.discount), 0) + jobLineAmount;
        entries.push(...(await execUpdate("storage_jobs", ids, {
          bol_collected: collected, bol_payment_method: a.method || null, bol_collected_date: date,
        }, ctx)));
      }
      const parts = [`$${total.toLocaleString()} imputado al job ${a.job_number}`];
      if (unassigned > 0) parts.push(`$${unassigned.toLocaleString()} quedaron a cuenta`);
      return { entries, summary: parts.join("; ") };
    },
  },

  record_expense: {
    perms: [["expenses", "insert"]],
    doc: "{ amount, category?, expense_date?, vendor?, driver_id?, truck_id?, trip_id?, job_number?, paid_from?, bank_account?, status?, gallons?, odometer?, fuel_state?, notes? }",
    describe: (a) => `Cargar gasto ${a.category || ""} de $${num(a.amount).toLocaleString()}${a.vendor ? ` (${a.vendor})` : ""}${a.trip_id ? ` · trip #${a.trip_id}` : ""}${a.job_number ? ` · job ${a.job_number}` : ""}`,
    validate: async (a) => {
      const errs = [];
      if (!(num(a.amount) > 0)) errs.push("el monto del gasto debe ser mayor a 0");
      if (a.paid_from === "driver_cash" && !a.driver_id) errs.push("un gasto pagado con efectivo del driver necesita driver_id");
      if (a.job_number && !(await jobRows(a.job_number)).length) errs.push(`no encuentro el job ${a.job_number}`);
      return errs;
    },
    run: async (a, ctx) => {
      const rows = a.job_number ? await jobRows(a.job_number) : [];
      const entries = await execInsert("expenses", {
        expense_date: a.expense_date || today(), category: a.category || "other", amount: num(a.amount),
        vendor: a.vendor || null, driver_id: a.driver_id ?? null, truck_id: a.truck_id ?? null,
        trip_id: a.trip_id ?? null, job_id: rows.length ? repRow(rows).id : null,
        job_number: a.job_number || null, paid_from: a.paid_from || "bank",
        bank_account: (a.paid_from || "bank") === "bank" ? (a.bank_account || null) : null,
        status: a.status || "pending", gallons: a.gallons ?? null, odometer: a.odometer ?? null,
        fuel_state: a.category === "fuel" ? (a.fuel_state || null) : null, notes: a.notes || null,
      }, ctx);
      return { entries, summary: `Gasto de $${num(a.amount).toLocaleString()} cargado` };
    },
  },

  mark_billing_paid: {
    perms: [["storage_billing", "update"]],
    doc: "{ billing_ids: [], paid_date? }",
    describe: (a) => `Marcar como pagada(s) ${(a.billing_ids || []).length} factura(s) de storage (#${(a.billing_ids || []).join(", #")})`,
    validate: async (a) => ((a.billing_ids || []).length ? [] : ["faltan los ids de las facturas"]),
    run: async (a, ctx) => ({
      entries: await execUpdate("storage_billing", a.billing_ids, { status: "paid", paid_date: a.paid_date || today() }, ctx),
      summary: `${a.billing_ids.length} factura(s) de storage marcadas como pagadas`,
    }),
  },

  log_job_event: {
    perms: [["job_events", "insert"]],
    doc: "{ job_number, event_type: 'picked_up'|'loaded_to_truck'|'dropped_at_storage'|'loaded_from_storage'|'delivered'|'on_hold'|'attempted_delivery'|'redispatched'|'driver_handoff'|'other', notes?, storage_id? }",
    describe: (a) => `Registrar evento "${a.event_type}" en el job ${a.job_number}${a.notes ? `: ${a.notes}` : ""}`,
    validate: async (a) => ((await jobRows(a.job_number)).length ? [] : [`no encuentro el job ${a.job_number}`]),
    run: async (a, ctx) => {
      const rows = await jobRows(a.job_number);
      const entries = await execInsert("job_events", {
        job_id: repRow(rows).id, event_type: a.event_type, notes: a.notes || null,
        storage_id: a.storage_id ?? null,
      }, ctx);
      return { entries, summary: `Evento "${a.event_type}" registrado en el job ${a.job_number}` };
    },
  },

  assign_driver_to_job: {
    perms: [["storage_jobs", "update"]],
    doc: "{ job_number, driver_id }",
    describe: (a) => `Asignar el driver #${a.driver_id} al job ${a.job_number}`,
    validate: async (a) => {
      const errs = [];
      const { data: d } = await admin.from("drivers").select("id").eq("id", a.driver_id).is("deleted_at", null).maybeSingle();
      if (!d) errs.push(`no encuentro el driver #${a.driver_id}`);
      if (!(await jobRows(a.job_number)).length) errs.push(`no encuentro el job ${a.job_number}`);
      return errs;
    },
    run: async (a, ctx) => {
      const rows = await jobRows(a.job_number);
      const rep = repRow(rows);
      const cur = Array.isArray(rep.driver_ids) ? rep.driver_ids.filter((x) => Number(x) !== Number(a.driver_id)) : [];
      const ids = [Number(a.driver_id), ...cur];
      const { data: drivers } = await admin.from("drivers").select("id, name").in("id", ids);
      const names = ids.map((id) => (drivers || []).find((d) => d.id === id)?.name).filter(Boolean);
      const cols = await tableColumns("storage_jobs");
      const patch = { driver_ids: ids };
      if (cols?.has("driver")) patch.driver = names.join(", ");
      return {
        entries: await execUpdate("storage_jobs", rowIds(rows), patch, ctx),
        summary: `Driver asignado al job ${a.job_number}: ${names[0] || a.driver_id}`,
      };
    },
  },
};
