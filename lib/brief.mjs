// Daily operations brief: deterministic Supabase queries gather the money- and
// ops-critical numbers (collections, storage-billing leaks, FADD, today's
// schedule), then Claude writes the Spanish Telegram message. Sent to the team
// group by api/daily-brief.mjs on a Vercel Cron.
import { admin, client } from "./agent.mjs";

const TZ = "America/New_York";
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v) => "$" + num(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// One row per job_number (jobs can span multiple rows, one per location).
function dedupeByJob(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = r.job_number || `id:${r.id}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

export async function collectBriefData() {
  const today = todayISO();
  const in2days = new Date(Date.now() + 2 * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
  const sel = "id, job_number, customer, status, date_out, billing_active, client_monthly_rate, pickup_date, pickup_date_from, delivery_date, fadd, delivery_balance, pickup_balance, delivery_city, client_phone";

  const [jobsRes, billingRes, claimsRes] = await Promise.all([
    admin.from("storage_jobs").select(sel).limit(5000),
    admin.from("storage_billing").select("id, job_id, amount, status, billing_period_end").eq("status", "pending").lt("billing_period_end", today),
    admin.from("claims").select("id, job_number, client_name, status, claimed_amount").in("status", ["open", "investigating"]),
  ]);
  if (jobsRes.error) throw jobsRes.error;
  const jobs = dedupeByJob(jobsRes.data || []);
  const overdueBilling = billingRes.data || [];
  const claims = claimsRes.data || [];

  const notDelivered = (j) => j.status !== "delivered";
  const inStorage = (j) => !j.date_out && !["out_for_delivery", "delivered"].includes(j.status || "scheduled");

  // Today's schedule
  const pickupsToday = jobs.filter((j) => (j.pickup_date_from || j.pickup_date) === today && (j.status || "scheduled") === "scheduled");
  const deliveriesToday = jobs.filter((j) => j.delivery_date === today && notDelivered(j));

  // Collections: delivery balances on delivered/out jobs (oldest first-ish), pickup balances due today
  const collectDelivery = jobs
    .filter((j) => num(j.delivery_balance) > 0 && ["delivered", "out_for_delivery"].includes(j.status))
    .sort((a, b) => num(b.delivery_balance) - num(a.delivery_balance));
  const collectPickupToday = pickupsToday.filter((j) => num(j.pickup_balance) > 0);
  const totalDeliveryPending = collectDelivery.reduce((s, j) => s + num(j.delivery_balance), 0);
  const totalPickupPending = jobs.filter((j) => num(j.pickup_balance) > 0 && (j.status || "scheduled") === "scheduled").reduce((s, j) => s + num(j.pickup_balance), 0);

  // Storage billing leaks: physically in storage but not billing
  const leaks = jobs.filter((j) => inStorage(j) && !j.billing_active);
  const ratesKnown = leaks.filter((j) => num(j.client_monthly_rate) > 0);
  const avgRate = ratesKnown.length ? ratesKnown.reduce((s, j) => s + num(j.client_monthly_rate), 0) / ratesKnown.length : 150;
  const leakMonthly = leaks.reduce((s, j) => s + (num(j.client_monthly_rate) || avgRate), 0);

  // FADD
  const faddOverdue = jobs.filter((j) => j.fadd && j.fadd < today && notDelivered(j)).sort((a, b) => (a.fadd < b.fadd ? -1 : 1));
  const faddSoon = jobs.filter((j) => j.fadd && j.fadd >= today && j.fadd <= in2days && notDelivered(j));

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
      total_delivery_pendiente: totalDeliveryPending,
      total_pickup_pendiente: totalPickupPending,
      top_por_cobrar: collectDelivery.slice(0, 8).map((j) => slim(j, { monto: num(j.delivery_balance), status: j.status })),
      cobrar_en_pickups_de_hoy: collectPickupToday.map((j) => slim(j, { monto: num(j.pickup_balance) })),
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
    claims_activos: { total: claims.length, monto_reclamado: claims.reduce((s, c) => s + num(c.claimed_amount), 0) },
  };
}

// Deterministic fallback if the Claude call fails — terse but complete.
function fallbackBrief(d) {
  return [
    `📋 Brief diario — ${d.fecha}`,
    `🚚 Hoy: ${d.agenda.pickups_hoy_total} pickups, ${d.agenda.entregas_hoy_total} entregas`,
    `💰 Por cobrar: ${money(d.cobros.total_delivery_pendiente)} (delivery) + ${money(d.cobros.total_pickup_pendiente)} (pickup)`,
    `🏬 Storage sin facturar: ${d.fugas_storage.jobs_en_deposito_sin_billing} jobs (~${money(d.fugas_storage.perdida_mensual_estimada)}/mes) · ${d.fugas_storage.billing_vencidos} billing vencidos (${money(d.fugas_storage.billing_vencidos_monto)})`,
    `⚠️ FADD vencidos: ${d.fadd.vencidos_total} · vencen en 48h: ${d.fadd.vencen_48h.length}`,
    `📎 Claims activos: ${d.claims_activos.total} (${money(d.claims_activos.monto_reclamado)})`,
  ].join("\n");
}

export async function composeBrief(data) {
  try {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [{
        role: "user",
        content: [
          "Write the daily morning brief for the ops team of \"No Borders Moving\" (US moving & storage company). It is posted in the team's Telegram group.",
          "",
          "Style: Spanish (Argentine, informal-professional), plain Telegram text (no Markdown), emojis as section markers, short lines. Under 3200 characters.",
          "Structure: (1) agenda de hoy (pickups/entregas con cliente y qué cobrar en cada una), (2) 💰 COBROS — the star section: totals + top deudores con montos, tono de acción (\"hoy salir a cobrar...\"), (3) 🏬 fugas de storage (jobs sin facturar y billing vencido, con la plata que se pierde), (4) ⚠️ FADD críticos (vencidos más viejos + los que vencen ya), (5) claims en una línea. Close with a one-line priority for the day.",
          "Rules: only use the data below, never invent; amounts as $1,234; dates DD/MM; if a section is empty, one positive short line (\"✅ Sin FADD por vencer\"); job numbers verbatim.",
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
