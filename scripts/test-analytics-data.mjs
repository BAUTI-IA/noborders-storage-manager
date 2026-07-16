// Sanity tests for src/analyticsData.js — run: node scripts/test-analytics-data.mjs
import {
  jobKey, dedupeJobs, buildFilterCtx, computeStoragePnl, computeMetrics,
  computeRevenueSplit, monthlyRevenueSeries, arAging, monthsBetween,
  rangeFromPreset, previousRange, shiftMonth, topN, occupancySeries,
  effCf, hasRealCf,
  attributeRevenueToDrivers, computeDriverPnl, driverCashReconciliation,
  materialShortages, fuelOutliers,
  payWeekStart, payWeekDays, addDaysISO, workDayPay,
} from "../src/analyticsData.js";

let failed = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); }
};

// ── months / ranges ──
eq("monthsBetween zero-fill", monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
eq("shiftMonth back over year", shiftMonth("2026-01", -2), "2025-11");
eq("rangeFromPreset 6m", rangeFromPreset("6m", "2026-07-03"), { fromMonth: "2026-02", toMonth: "2026-07" });
eq("rangeFromPreset ytd", rangeFromPreset("ytd", "2026-07-03"), { fromMonth: "2026-01", toMonth: "2026-07" });
eq("previousRange same length", previousRange({ fromMonth: "2026-02", toMonth: "2026-07" }), { fromMonth: "2025-08", toMonth: "2026-01" });
eq("previousRange todo", previousRange({ fromMonth: null, toMonth: "2026-07" }), null);

// ── fixtures ──
// Job A spans 2 units (same job_number), job B standalone, job C cancelled.
const jobs = [
  { id: 1, job_number: "A100", storage_id: 10, date_in: "2026-05-02", date_out: null, status: "in_storage", billing_active: true, client_monthly_rate: "1000", broker_id: 7, bol_collected: "5000", broker_job_share_pct: "10", volume: "1200 cf", customer: "Ana" },
  { id: 2, job_number: "A100", storage_id: 11, date_in: "2026-05-04", date_out: null, status: "in_storage", billing_active: true, client_monthly_rate: "1000", broker_id: 7, bol_collected: "5000", broker_job_share_pct: "10", volume: "1200 cf", customer: "Ana" },
  { id: 3, job_number: "B200", storage_id: 12, date_in: "2026-03-10", date_out: "2026-06-20", delivery_date: "2026-06-20", status: "delivered", broker_id: 8, pickup_balance: "1000", delivery_balance: "2000", broker_job_share_amount: "600", bol_balance: "900", bol_collected: "100", volume: "800", customer: "Beto" },
  { id: 4, job_number: "", storage_id: null, date_in: "2026-06-01", date_out: null, status: "cancelled" },
];
const records = [
  { id: 10, brand: "CubeSmart", unit: "1", state: "FL", monthly_cost: "300", situation: "Open", space_type: null, date_opened: "2026-01-05" },
  { id: 11, brand: "CubeSmart", unit: "2", state: "FL", monthly_cost: "250", situation: "Open", space_type: null, date_opened: "2026-02-01" },
  { id: 12, brand: "PublicStorage", unit: "9", state: "TX", monthly_cost: "400", situation: "Open", space_type: null, date_opened: "2026-01-15" }, // vacía hoy (job B salió)
  { id: 13, brand: "Depot", unit: "3", state: "TX", monthly_cost: null, situation: "Close", space_type: null, date_opened: "2025-12-01" },     // cerrada: fuera del P&L
  { id: 14, brand: "WH", unit: null, state: "FL", monthly_cost: "999", situation: "Open", space_type: "warehouse" },                            // warehouse: fuera del P&L
];
const sitFn = (r) => r.situation === "Close" ? "Close" : ([10, 11].includes(r.id) ? "Open" : "Empty");

// ── dedupeJobs ──
const groups = dedupeJobs(jobs);
eq("dedupe count", groups.size, 3);
const gA = groups.get(jobKey(jobs[0]));
eq("dedupe earliest date_in", gA.dateIn, "2026-05-02");
eq("dedupe allOut=false while active", gA.allOut, false);
eq("dedupe anyOut on delivered", groups.get("n:b200").anyOut, true);

// ── storage P&L: prorrateo y totales ──
const pnl = computeStoragePnl(records, jobs, sitFn);
eq("pnl rows (sin closed/warehouse)", pnl.rows.length, 3);
const row10 = pnl.rows.find(r => r.id === 10);
eq("pnl prorrateo 1000/2 unidades", row10.income, 500);
eq("pnl totals income == rate una vez", pnl.totals.pay + "|" + pnl.totals.income, "950|1000");
eq("pnl vacante sin income", pnl.rows.find(r => r.id === 12).income, 0);
eq("pnl missingCost", pnl.missingCost, 0);

// ── metrics (paridad con la fórmula vieja) ──
const met = computeMetrics(records, jobs, pnl);
eq("metrics activeJobs (dedupe, incluye cancelled sin date_out)", met.activeJobs, 2);
eq("metrics vacantCost = unidad 12", met.vacantCost, 400);
eq("metrics storageMargin", met.storageMargin, 1000 - 950);

// ── revenue split: seen-set broker|jobKey + share amount vs pct ──
const keyByRowId = {}; for (const j of jobs) keyByRowId[j.id] = jobKey(j);
const groupByKey = new Map([...groups.values()].map(g => [g.key, g]));
const split = computeRevenueSplit(jobs, [], keyByRowId, groupByKey, null);
// A100: collected 5000 una sola vez (no 2), share 10% = 500. B200: bol 5000? no — bol_collected 100 → fallback? numv(100)=100 truthy → collected=100, share explícito 600.
eq("split gross (A100 una vez + B200 bol_collected)", split.gross, 5000 + 100);
eq("split broker share (pct + amount explícito)", split.broker, 500 + 600);
eq("split net", split.net, 5100 - 1100);

// ── AR aging: bordes de bucket y owed = balance − collected ──
const agingGroups = [...dedupeJobs([
  { id: 21, job_number: "D1", status: "delivered", date_out: "2026-06-30", delivery_date: "2026-06-03", bol_balance: "1000", bol_collected: "200" }, // 30 días → bucket 0-30
  { id: 22, job_number: "D2", status: "delivered", date_out: "2026-06-02", delivery_date: "2026-06-02", bol_balance: "500", bol_collected: "0" },    // 31 días → bucket 31-60
  { id: 23, job_number: "D3", status: "delivered", date_out: "2026-01-01", delivery_date: "2026-01-01", bol_balance: "300" },                        // >90
  { id: 24, job_number: "D4", status: "in_storage", bol_balance: "999" },                                                                            // no entregado: fuera
  { id: 25, job_number: "D5", status: "delivered", date_out: "2026-06-01", bol_balance: "100", bol_collected: "100" },                               // saldado: fuera
]).values()];
const aging = arAging(agingGroups, "2026-07-03");
eq("aging bucket 0-30", aging.buckets[0].amount, 800);
eq("aging bucket 31-60 (borde 31)", aging.buckets[1].amount, 500);
eq("aging bucket 90+", aging.buckets[3].amount, 300);
eq("aging total", aging.total, 1600);

// ── buildFilterCtx: rango + segmentos ──
const payments = [
  { id: 1, job_id: 1, amount: "700", discount: "50", received: true, received_date: "2026-06-10", concept: "job" },
  { id: 2, job_id: 3, amount: "300", received: false, payment_date: "2026-04-15", concept: "job" },
  { id: 3, job_id: 3, amount: "100", received: true, received_date: "2025-12-01", concept: "job" }, // fuera de rango 6m
];
const range = rangeFromPreset("6m", "2026-07-03");
const ctx = buildFilterCtx({ records, jobs, jobExtras: [], payments, range, stateF: "", brokerF: "" });
eq("ctx meses zero-fill", ctx.months.length, 6);
eq("ctx groups en rango (A100 may, B200 mar; cancelled jun cuenta)", ctx.groups.length, 3);
const rev = monthlyRevenueSeries(ctx, false);
eq("rev jun cobrado neto de descuento", rev.find(r => r.month === "2026-06").collected, 650);
eq("rev abr pendiente", rev.find(r => r.month === "2026-04").pending, 300);
eq("rev fuera de rango excluido", rev.reduce((s, r) => s + r.collected + r.pending, 0), 950);

const ctxTX = buildFilterCtx({ records, jobs, jobExtras: [], payments, range, stateF: "TX", brokerF: "" });
eq("ctx filtro estado TX → solo B200", ctxTX.groups.map(g => g.key), ["n:b200"]);
const ctxB7 = buildFilterCtx({ records, jobs, jobExtras: [], payments, range, stateF: "", brokerF: 7 });
eq("ctx filtro broker 7 → solo A100", ctxB7.groups.map(g => g.key), ["n:a100"]);
// pagos de jobs fuera del segmento no entran
eq("ctx broker 7 payments", ctxB7.payments.map(p => p.id), [1]);

// ── occupancy ──
const occ = occupancySeries(records, [...groups.values()], ["2026-04", "2026-05", "2026-06"]);
eq("occupancy abr (B200 en unidad 12)", occ[0].occupied, 1);
eq("occupancy may (A100 x2 + B200)", occ[1].occupied, 3);
eq("occupancy open cuenta por date_opened", occ[0].open, 3);

// ── topN ──
eq("topN agrupa cola en Otros", topN([{ label: "a", v: 5 }, { label: "b", v: 3 }, { label: "c", v: 2 }, { label: "d", v: 1 }], 2, "v"),
  [{ label: "a", v: 5 }, { label: "b", v: 3 }, { label: "Otros (2)", v: 3, isOther: true }]);

// ── real CF vs broker estimate ──
eq("effCf usa el real cuando está cargado", effCf({ volume: "550 cf", real_cf: 620 }), 620);
eq("effCf cae al estimado sin real", effCf({ volume: "550 cf" }), 550);
eq("effCf ignora real inválido/0", effCf({ volume: "550 cf", real_cf: 0 }), 550);
eq("hasRealCf", [hasRealCf({ real_cf: 620 }), hasRealCf({ volume: "550" }), hasRealCf({ real_cf: "abc" })], [true, false, false]);

// ── split job across two trucks: money/analytics must NOT double-count ──
// A split adds a "portion" row (same job_number, its own CF, money zeroed). The
// job stays ONE job everywhere: revenue, active-job count and storage P&L must be
// identical whether or not the portion row exists.
{
  // Base job (single row) vs the same job split into base + a zeroed portion.
  const base = { id: 30, job_number: "S300", storage_id: 10, date_in: "2026-05-02", date_out: null, status: "in_storage",
    billing_active: true, client_monthly_rate: "1000", broker_id: 7, bol_collected: "5000", broker_job_share_pct: "10",
    volume: "1200 cf", real_cf: 1200, customer: "Sol" };
  // After splitting 400 CF off: base keeps 800 CF, portion carries 400 CF, money zeroed.
  const baseAfter = { ...base, real_cf: 800, split_group: "n:s300:1" };
  const portion = { id: 31, job_number: "S300", storage_id: 10, date_in: "2026-05-02", date_out: null, status: "scheduled",
    split_group: "n:s300:1", real_cf: 400, volume: "1200 cf", customer: "Sol", broker_id: 7,
    billing_active: false, client_monthly_rate: null, bol_collected: null, bol_balance: 0,
    pickup_balance: 0, delivery_balance: 0, broker_job_share_pct: null, broker_job_share_amount: null };

  const recs = [{ id: 10, brand: "CubeSmart", unit: "1", state: "FL", monthly_cost: "300", situation: "Open", space_type: null, date_opened: "2026-01-05" }];
  const sit1 = () => "Open";

  const before = [base];
  const after = [baseAfter, portion];

  // dedupeJobs: same group count, and the representative must be the NON-portion row.
  const gAfter = dedupeJobs(after);
  eq("split dedupe → still one job", gAfter.size, 1);
  eq("split rep is the non-portion row", gAfter.get("n:s300").rep.id, 30);

  // Revenue: gross + broker share identical with/without the portion row.
  const kbrB = {}; for (const j of before) kbrB[j.id] = jobKey(j);
  const kbrA = {}; for (const j of after) kbrA[j.id] = jobKey(j);
  const gbB = new Map([...dedupeJobs(before).values()].map(g => [g.key, g]));
  const gbA = new Map([...gAfter.values()].map(g => [g.key, g]));
  const revB = computeRevenueSplit(before, [], kbrB, gbB, null);
  const revA = computeRevenueSplit(after, [], kbrA, gbA, null);
  eq("split revenue gross unchanged", revA.gross, revB.gross);
  eq("split revenue broker unchanged", revA.broker, revB.broker);

  // Storage P&L: income identical (portion has no rate; billing lives on primary).
  const pnlB = computeStoragePnl(recs, before, sit1);
  const pnlA = computeStoragePnl(recs, after, sit1);
  eq("split storage income unchanged", pnlA.totals.income, pnlB.totals.income);

  // Active-job count: still one job (dedupe by jobKey).
  eq("split active jobs = 1", computeMetrics(recs, after, pnlA).activeJobs, 1);

  // Trip capacity math: each portion's effCf sums back to the original 1200 CF.
  eq("split CF halves sum to original", effCf(baseAfter) + effCf(portion), 1200);

  // Determinism: rows load newest-first, so the portion (higher id) is often seen
  // BEFORE the source. Rep must still resolve to the money-bearing source (id 30).
  const gRev = dedupeJobs([portion, baseAfter]);
  eq("split rep deterministic regardless of order", gRev.get("n:s300").rep.id, 30);
  const pnlRev = computeStoragePnl(recs, [portion, baseAfter], sit1);
  eq("split storage income order-independent", pnlRev.totals.income, pnlB.totals.income);
}

// ── Driver P&L: atribución, labor, gastos, comisiones ──
{
  const drivers = [
    { id: 1, name: "Juan", daily_rate: 200, active: true },
    { id: 2, name: "Pedro", daily_rate: 250, active: true },
    { id: 3, name: "Luis", daily_rate: 100, active: true }, // sin actividad → fuera de rows
  ];
  // Job compartido (Juan+Pedro, $4000) + job solo de Juan ($1000) + legacy por nombre ($600 Pedro).
  const pnlJobs = [
    { id: 41, job_number: "P1", driver_ids: [1, 2], pickup_balance: "3000", delivery_balance: "1000", date_in: "2026-07-01" },
    { id: 42, job_number: "P2", driver_ids: [1], bol_collected: "1000", date_in: "2026-07-02" },
    { id: 43, job_number: "P3", driver: "Pedro y equipo", pickup_balance: "600", date_in: "2026-07-03" },
  ];
  const pnlGroups = [...dedupeJobs(pnlJobs).values()];
  const attributed = attributeRevenueToDrivers(pnlGroups, drivers);
  eq("attr split parejo job compartido + propio", Math.round(attributed.get(1).revenue), 2000 + 1000);
  eq("attr legacy por nombre", Math.round(attributed.get(2).revenue), 2000 + 600);
  eq("attr jobs count", [attributed.get(1).jobs, attributed.get(2).jobs], [2, 2]);

  const pnlRange = { fromMonth: "2026-07", toMonth: "2026-07" };
  const pnlExpenses = [
    { id: 1, driver_id: 1, category: "fuel", amount: "300", status: "approved", expense_date: "2026-07-05" },
    { id: 2, driver_id: 1, category: "hotel", amount: "150", status: "pending", expense_date: "2026-07-06" },  // pendiente: no suma al costo
    { id: 3, driver_id: 1, category: "tolls", amount: "999", status: "rejected", expense_date: "2026-07-06" }, // rechazado: excluido
    { id: 4, driver_id: 1, category: "meals", amount: "50", status: "approved", expense_date: "2026-06-30" },  // fuera de rango
    { id: 5, driver_id: 2, category: "fuel", amount: "100", status: "approved", expense_date: "2026-07-08" },
  ];
  const pnlWorkDays = [
    { id: 1, driver_id: 1, work_date: "2026-07-01", rate: 180 },        // rate congelado ≠ daily_rate actual
    { id: 2, driver_id: 1, work_date: "2026-07-02", rate: null },       // sin snapshot → usa daily_rate
    { id: 3, driver_id: 1, work_date: "2026-06-15", rate: 180 },        // fuera de rango
    { id: 4, driver_id: 2, work_date: "2026-07-01", rate: 250 },
  ];
  const pnlExtras = [
    { id: 1, driver_id: 1, driver_commission_amount: "70", active: true },
    { id: 2, driver_id: 1, driver_commission_amount: "30", active: false }, // inactivo: excluido
  ];
  const dp = computeDriverPnl({ driversList: drivers, groups: pnlGroups, jobExtras: pnlExtras, expenses: pnlExpenses, workDays: pnlWorkDays, range: pnlRange });
  const juan = dp.rows.find(r => r.driverId === 1);
  eq("pnl labor: snapshot + fallback a daily_rate", juan.laborCost, 180 + 200);
  eq("pnl gastos: solo approved en rango", juan.expensesTotal, 300);
  eq("pnl pendientes aparte", juan.pendingTotal, 150);
  eq("pnl comisiones solo activas", juan.commissions, 70);
  eq("pnl neto Juan", Math.round(juan.net), 3000 - (380 + 300 + 70));
  eq("pnl drivers sin actividad fuera", dp.rows.some(r => r.driverId === 3), false);
  eq("pnl totals net = suma de rows", Math.round(dp.totals.net), Math.round(dp.rows.reduce((s, r) => s + r.net, 0)));
}

// ── Cash reconciliation: pagos físicos en mano − gastos cash aprobados sin rendir ──
{
  const pays = [
    { id: 1, method: "cash", amount: "1000", received: true, banked: false, cash_with_whom: "Juan" },
    { id: 2, method: "zelle", amount: "500", received: true, banked: false, received_by: "Juan" },  // digital: no cuenta
    { id: 3, method: "check", amount: "400", received: true, banked: true, cash_with_whom: "Juan" }, // depositado: no cuenta
    { id: 4, method: "cash", amount: "300", received: true, banked: false, cash_with_whom: "Pedro" },
    { id: 5, method: "cash", amount: "200", discount: "50", received: true, banked: false, received_by: "Juan" }, // neto 150
  ];
  const exps = [
    { id: 1, driver_id: 1, paid_from: "driver_cash", status: "approved", settled: false, amount: "250" },
    { id: 2, driver_id: 1, paid_from: "driver_cash", status: "approved", settled: true, amount: "100" },  // rendido: no resta
    { id: 3, driver_id: 1, paid_from: "driver_cash", status: "pending", settled: false, amount: "80" },   // pendiente: no resta
    { id: 4, driver_id: 1, paid_from: "bank", status: "approved", settled: false, amount: "60" },          // banco: no resta
  ];
  const rec = driverCashReconciliation({ payments: pays, expenses: exps, driverName: "Juan", driverId: 1 });
  eq("cash held: físicos sin depositar, neto de descuento", rec.held, 1000 + 150);
  eq("cash gastos aprobados sin rendir", rec.approvedCashExpenses, 250);
  eq("cash esperado en mano", rec.expectedOnHand, 900);
  eq("cash unsettled items", rec.unsettledItems.map(e => e.id), [1]);
}

// ── Materiales: en mano por driver + valor ──
{
  const items = [{ id: 1, name: "Pads", unit: "unit", unit_cost: 10 }, { id: 2, name: "Shrink", unit: "roll", unit_cost: 25 }];
  const moves = [
    { id: 1, item_id: 1, movement_type: "issue", quantity: 40, driver_id: 1 },
    { id: 2, item_id: 1, movement_type: "return", quantity: 25, driver_id: 1 },
    { id: 3, item_id: 1, movement_type: "consume", quantity: 5, driver_id: 1, unit_cost: 12 }, // snapshot ≠ catálogo
    { id: 4, item_id: 2, movement_type: "issue", quantity: 2, driver_id: 2 },
    { id: 5, item_id: 1, movement_type: "purchase", quantity: 100 },                            // sin driver: fuera del reporte
  ];
  const sh = materialShortages({ items, movements: moves });
  const juanPads = sh.find(s => s.driverId === 1 && s.itemId === 1);
  eq("materiales en mano = issued − returned − consumed", juanPads.onHand, 10);
  eq("materiales valor con snapshot de costo", juanPads.value, 40 * 10 - 25 * 10 - 5 * 12);
  eq("materiales solo movimientos con driver", sh.length, 2);
}

// ── Fuel outliers: mediana $/gal + $/milla por odómetro ──
{
  const fexp = [
    { id: 1, category: "fuel", amount: "400", gallons: "100", status: "approved", truck_id: 1, odometer: 1000, expense_date: "2026-07-01" }, // $4/gal
    { id: 2, category: "fuel", amount: "410", gallons: "100", status: "approved", truck_id: 1, odometer: 1500, expense_date: "2026-07-03" }, // $4.10/gal
    { id: 3, category: "fuel", amount: "900", gallons: "100", status: "approved", expense_date: "2026-07-05" },                               // $9/gal → outlier
    { id: 4, category: "fuel", amount: "300", status: "rejected", gallons: "10", expense_date: "2026-07-06" },                                // rechazado: fuera
    { id: 5, category: "hotel", amount: "100", status: "approved", expense_date: "2026-07-06" },                                              // otra categoría
  ];
  const fo = fuelOutliers({ expenses: fexp });
  eq("fuel mediana", fo.medianPpg, 4.1);
  eq("fuel outlier >1.5×", fo.outliers.map(o => o.id), [3]);
  eq("fuel $/milla por delta de odómetro", fo.costPerMile.map(c => ({ miles: c.miles, perMile: +(c.perMile).toFixed(2) })), [{ miles: 500, perMile: 0.82 }]);
}

// ── Semana de pago (miércoles → martes) ──
{
  eq("payWeekStart miércoles queda igual", payWeekStart("2026-07-15"), "2026-07-15");        // mié
  eq("payWeekStart jueves → mié anterior", payWeekStart("2026-07-16"), "2026-07-15");        // jue
  eq("payWeekStart martes → mié de la semana pasada", payWeekStart("2026-07-14"), "2026-07-08"); // mar
  eq("payWeekDays 7 días mié..mar", payWeekDays("2026-07-15"), ["2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"]);
  eq("addDaysISO cruza el mes", addDaysISO("2026-07-30", 7), "2026-08-06");
}

// ── Pago por día: completo, medio, por hora, fallbacks ──
{
  const d = { daily_rate: 200, hourly_rate: 25 };
  eq("workDayPay full con snapshot", workDayPay({ day_type: "full", rate: 180 }, d), 180);
  eq("workDayPay full fallback a daily_rate", workDayPay({ day_type: "full", rate: null }, d), 200);
  eq("workDayPay legacy sin day_type = full", workDayPay({ rate: 180 }, d), 180);
  eq("workDayPay half = mitad", workDayPay({ day_type: "half", rate: 180 }, d), 90);
  eq("workDayPay hourly = horas × rate snapshot", workDayPay({ day_type: "hourly", hours: 6, rate: 30 }, d), 180);
  eq("workDayPay hourly fallback a hourly_rate", workDayPay({ day_type: "hourly", hours: 4, rate: null }, d), 100);
}

// ── Ajustes en el P&L: descuento baja el costo, bono lo sube ──
{
  const drivers = [{ id: 1, name: "Juan", daily_rate: 200, active: true }];
  const g = [...dedupeJobs([{ id: 51, job_number: "A1", driver_ids: [1], bol_collected: "2000", date_in: "2026-07-01" }]).values()];
  const range = { fromMonth: "2026-07", toMonth: "2026-07" };
  const wd = [
    { id: 1, driver_id: 1, work_date: "2026-07-01", day_type: "full", rate: 200 },
    { id: 2, driver_id: 1, work_date: "2026-07-02", day_type: "half", rate: 200 },
    { id: 3, driver_id: 1, work_date: "2026-07-03", day_type: "hourly", hours: 5, rate: 20 },
  ];
  const adj = [
    { id: 1, driver_id: 1, adj_date: "2026-07-04", kind: "deduction", amount: "50" },  // fuck-up
    { id: 2, driver_id: 1, adj_date: "2026-07-05", kind: "bonus", amount: "120" },     // compensación
    { id: 3, driver_id: 1, adj_date: "2026-06-30", kind: "bonus", amount: "999" },     // fuera de rango
  ];
  const dp = computeDriverPnl({ driversList: drivers, groups: g, jobExtras: [], expenses: [], workDays: wd, adjustments: adj, range });
  const r = dp.rows[0];
  eq("pnl labor mixto full+half+hourly", r.laborCost, 200 + 100 + 100);
  eq("pnl bonuses/deductions en rango", [r.bonuses, r.deductions], [120, 50]);
  eq("pnl adjustmentsNet", r.adjustmentsNet, 70);
  eq("pnl net con ajustes", Math.round(r.net), 2000 - (400 + 70));
}

if (failed) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log("\nAll analytics-data tests passed ✓");
