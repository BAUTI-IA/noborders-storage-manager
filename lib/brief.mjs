// Daily operations brief: deterministic Supabase queries gather the money- and
// ops-critical numbers, then Claude writes the Spanish Telegram message posted
// to the team group by api/daily-brief.mjs (Vercel Cron).
//
// Collections use the CRM's own "what does the client actually owe" formula
// (jobOutstanding in src/App.jsx:5447 + paymentAlloc.js, simplified): raw
// balances MINUS received payments, plus active extras minus extra payments.
// That splits the headline into deuda_real (collectable now) vs
// balances_sin_depurar (raw balances that look already collected but were
// never cleared in the CRM — a data-hygiene pile, not receivables).
import { admin, client } from "./agent.mjs";

const TZ = "America/New_York";
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v) => "$" + num(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// Logical-job key — same rule as src/analyticsData.js:14 (split rows share it).
const jobKeyOf = (j) => (j.job_number && j.job_number.trim() ? "n:" + j.job_number.trim().toLowerCase() : "id:" + j.id);

export async function collectBriefData() {
  const today = todayISO();
  const in2days = new Date(Date.now() + 2 * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
  const sel = "id, job_number, customer, status, date_out, billing_active, client_monthly_rate, pickup_date, pickup_date_from, delivery_date, fadd, delivery_balance, pickup_balance, bol_balance, bol_collected, delivery_city, client_phone";

  const [jobsRes, payRes, extrasRes, billingRes, claimsRes] = await Promise.all([
    admin.from("storage_jobs").select(sel).limit(10000),
    admin.from("payments").select("job_id, amount, discount, concept, received").eq("received", true).limit(20000),
    admin.from("job_extras").select("job_id, amount, active").limit(20000),
    admin.from("storage_billing").select("id, amount, status, billing_period_end").eq("status", "pending").lt("billing_period_end", today),
    admin.from("claims").select("id, status, claimed_amount").in("status", ["open", "investigating"]),
  ]);
  if (jobsRes.error) throw jobsRes.error;
  const allRows = jobsRes.data || [];
  const payments = payRes.data || [];
  const extras = extrasRes.data || [];
  const overdueBilling = billingRes.data || [];
  const claims = claimsRes.data || [];

  // row id → jobKey (payments/extras link by row id; jobs split across rows)
  const keyByRowId = new Map(allRows.map((j) => [j.id, jobKeyOf(j)]));
  // representative row per jobKey = first seen (same rule as App.jsx:5240)
  const jobByKey = new Map();
  for (const j of allRows) if (!jobByKey.has(jobKeyOf(j))) jobByKey.set(jobKeyOf(j), j);

  // Received money per jobKey. Simplification vs paymentAlloc.js: 'job' and
  // 'on_account' count against the job's balances; 'extra' against extras.
  const paidJob = new Map(), paidExtra = new Map();
  for (const p of payments) {
    const k = keyByRowId.get(p.job_id);
    if (!k) continue;
    const net = num(p.amount) - num(p.discount);
    if (p.concept === "extra") paidExtra.set(k, (paidExtra.get(k) || 0) + net);
    else paidJob.set(k, (paidJob.get(k) || 0) + net);
  }
  const extrasOwed = new Map();
  for (const e of extras) {
    if (e.active === false) continue;
    const k = keyByRowId.get(e.job_id);
    if (!k) continue;
    extrasOwed.set(k, (extrasOwed.get(k) || 0) + num(e.amount));
  }

  // Outstanding per job (CRM formula): max(0, balances − collected) + extras pending
  const debtors = [];
  let totalReal = 0, totalRaw = 0;
  for (const [k, j] of jobByKey) {
    if (j.status === "cancelled") continue;
    const toCollect = num(j.pickup_balance) + num(j.delivery_balance) + num(j.bol_balance);
    if (toCollect <= 0 && !(extrasOwed.get(k) > 0)) continue;
    const collected = Math.max(num(j.bol_collected), paidJob.get(k) || 0);
    const extrasOut = Math.max(0, (extrasOwed.get(k) || 0) - (paidExtra.get(k) || 0));
    const outstanding = Math.max(0, toCollect - collected) + extrasOut;
    totalRaw += toCollect + Math.max(0, extrasOwed.get(k) || 0);
    if (outstanding <= 0) continue;
    totalReal += outstanding;
    debtors.push({ job: j.job_number || "s/n", cliente: j.customer || "sin nombre", monto: Math.round(outstanding), status: j.status || "scheduled", entregado: !!j.date_out || j.status === "delivered", telefono: j.client_phone || null, fecha_entrega: j.delivery_date || null });
  }
  debtors.sort((a, b) => b.monto - a.monto);
  const balancesSinDepurar = Math.max(0, Math.round(totalRaw - totalReal));

  const jobs = [...jobByKey.values()];
  const notDone = (j) => j.status !== "delivered" && j.status !== "cancelled" && !j.date_out;
  const inStorage = (j) => !j.date_out && !["out_for_delivery", "delivered", "cancelled"].includes(j.status || "scheduled");

  // Today's schedule
  const pickupsToday = jobs.filter((j) => (j.pickup_date_from || j.pickup_date) === today && (j.status || "scheduled") === "scheduled");
  const deliveriesToday = jobs.filter((j) => j.delivery_date === today && notDone(j));

  // Storage billing leaks
  const leaks = jobs.filter((j) => inStorage(j) && !j.billing_active);
  const ratesKnown = leaks.filter((j) => num(j.client_monthly_rate) > 0);
  const avgRate = ratesKnown.length ? ratesKnown.reduce((s, j) => s + num(j.client_monthly_rate), 0) / ratesKnown.length : 150;
  const leakMonthly = leaks.reduce((s, j) => s + (num(j.client_monthly_rate) || avgRate), 0);

  // FADD — dashboard criteria (App.jsx:5106: !date_out, fadd < today) minus cancelled
  const faddOverdue = jobs.filter((j) => j.fadd && j.fadd < today && !j.date_out && j.status !== "cancelled" && j.status !== "delivered").sort((a, b) => (a.fadd < b.fadd ? -1 : 1));
  const faddSoon = jobs.filter((j) => j.fadd && j.fadd >= today && j.fadd <= in2days && !j.date_out && j.status !== "cancelled" && j.status !== "delivered");

  const slim = (j, extra = {}) => ({ job: j.job_number || "s/n", cliente: j.customer || "sin nombre", ...extra });
  return {
    fecha: today,
    agenda: {
      pickups_hoy: pickupsToday.slice(0, 10).map((j) => slim(j, { balance_pickup: num(j.pickup_balance) })),
      pickups_hoy_total: pickupsToday.length,
      entregas_hoy: deliveriesToday.slice(0, 10).map((j) => slim(j, { ciudad: j.delivery_city, balance_entrega: num(j.delivery_balance) })),
      entregas_hoy_total: deliveriesToday.length,
    },
    cobros: {
      deuda_real_total: Math.round(totalReal),
      balances_sin_depurar: balancesSinDepurar,
      top_deudores: debtors.slice(0, 8),
      deudores_total: debtors.length,
    },
    fugas_storage: {
      jobs_en_deposito_sin_billing: leaks.length,
      perdida_mensual_estimada: Math.round(leakMonthly),
      ejemplos: leaks.slice(0, 6).map((j) => slim(j, { rate: num(j.client_monthly_rate) || null })),
      billing_vencidos: overdueBilling.length,
      billing_vencidos_monto: overdueBilling.reduce((s, b) => s + num(b.amount), 0),
    },
    fadd: {
      vencidos_total: faddOverdue.length,
      vencidos_top: faddOverdue.slice(0, 5).map((j) => slim(j, { fadd: j.fadd, status: j.status })),
      vencen_48h: faddSoon.slice(0, 6).map((j) => slim(j, { fadd: j.fadd })),
    },
    claims_activos: { total: claims.length, monto_reclamado: Math.round(claims.reduce((s, c) => s + num(c.claimed_amount), 0)) },
  };
}

// Day-over-day comparison against the stored snapshot. Best-effort: if the
// brief_snapshots table doesn't exist yet, the brief just ships without deltas.
export async function snapshotAndDeltas(data) {
  try {
    const { data: prevRows } = await admin
      .from("brief_snapshots").select("*")
      .lt("snapshot_date", data.fecha)
      .order("snapshot_date", { ascending: false }).limit(1);
    const prev = prevRows?.[0] || null;
    const deltas = prev ? {
      vs_fecha: prev.snapshot_date,
      deuda_real: Math.round(num(data.cobros.deuda_real_total) - num(prev.deuda_real)),
      fadd_overdue: data.fadd.vencidos_total - (prev.fadd_overdue ?? data.fadd.vencidos_total),
      storage_leaks: data.fugas_storage.jobs_en_deposito_sin_billing - (prev.storage_leaks ?? data.fugas_storage.jobs_en_deposito_sin_billing),
      claims: data.claims_activos.total - (prev.claims_activos ?? data.claims_activos.total),
    } : null;
    return { deltas, prev };
  } catch (e) {
    console.error("snapshotAndDeltas read:", e);
    return { deltas: null, prev: null };
  }
}

export async function saveSnapshot(data) {
  try {
    await admin.from("brief_snapshots").upsert({
      snapshot_date: data.fecha,
      deuda_real: data.cobros.deuda_real_total,
      balances_sin_depurar: data.cobros.balances_sin_depurar,
      fadd_overdue: data.fadd.vencidos_total,
      storage_leaks: data.fugas_storage.jobs_en_deposito_sin_billing,
      storage_leak_monthly: data.fugas_storage.perdida_mensual_estimada,
      claims_activos: data.claims_activos.total,
      data,
    }, { onConflict: "snapshot_date" });
  } catch (e) {
    console.error("saveSnapshot:", e); // table may not exist yet — brief still ships
  }
}

// Deterministic fallback if the Claude call fails — terse but complete.
function fallbackBrief(d) {
  return [
    `📋 Brief diario — ${d.fecha}`,
    `🚚 Hoy: ${d.agenda.pickups_hoy_total} pickups, ${d.agenda.entregas_hoy_total} entregas`,
    `💰 Deuda real por cobrar: ${money(d.cobros.deuda_real_total)} (${d.cobros.deudores_total} jobs) · sin depurar: ${money(d.cobros.balances_sin_depurar)}`,
    `🏬 Storage sin facturar: ${d.fugas_storage.jobs_en_deposito_sin_billing} jobs (~${money(d.fugas_storage.perdida_mensual_estimada)}/mes) · ${d.fugas_storage.billing_vencidos} billing vencidos`,
    `⚠️ FADD vencidos: ${d.fadd.vencidos_total} · vencen en 48h: ${d.fadd.vencen_48h.length}`,
    `📎 Claims activos: ${d.claims_activos.total} (${money(d.claims_activos.monto_reclamado)})`,
  ].join("\n");
}

export async function composeBrief(data, deltas = null) {
  try {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 5000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [{
        role: "user",
        content: [
          "Write the daily morning brief for the ops team of \"No Borders Moving\" (US moving & storage company). It is posted in the team's Telegram group.",
          "",
          "Style: Spanish (Argentine, informal-professional), plain Telegram text (no Markdown), emojis as section markers, short lines. Under 3600 characters.",
          "Structure:",
          "1. Agenda de hoy: pickups/entregas con cliente y qué cobrar en cada una.",
          "2. 💰 COBROS — the star section. deuda_real_total is money genuinely collectable NOW (balances minus payments already recorded); balances_sin_depurar is old uncleared balances (data hygiene, one line only, do not mix into the debt). List top deudores with amounts, action tone.",
          "3. 🏬 Fugas de storage: jobs sin facturar y billing vencido, con la plata que se pierde.",
          "4. ⚠️ FADD críticos: vencidos más viejos + los que vencen ya.",
          "5. Claims en una línea.",
          "6. 📨 MENSAJES DE COBRO LISTOS: for the top 2-3 debtors that have entregado=true, write a short, courteous-but-firm collection message IN ENGLISH ready to forward to the client (\"Hi {first name}, this is No Borders Moving. Our records show an outstanding balance of $X for your move (job #...). ...\"), and show the client's telefono next to each so the team can send it. If none qualify, skip the section.",
          "7. Close with a one-line priority for the day.",
          deltas ? `DELTAS vs ${deltas.vs_fecha} (show them inline next to each metric: deuda \"↓ $X vs ayer ✅\" if negative / \"↑ $X vs ayer 🔺\" if positive / \"sin cambios\" if 0; same idea for FADD, fugas y claims): ${JSON.stringify(deltas)}` : "No previous snapshot — omit day-over-day comparisons.",
          "Rules: only use the data below, never invent; amounts as $1,234; dates DD/MM; if a section is empty, one short positive line; job numbers verbatim.",
          "",
          `DATA: ${JSON.stringify(data)}`,
        ].join("\n"),
      }],
    });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return text || fallbackBrief(data);
  } catch (e) {
    console.error("composeBrief:", e);
    return fallbackBrief(data);
  }
}
