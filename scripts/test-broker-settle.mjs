// Broker settlements — running balance per broker, payments spread over sheets.
import assert from "node:assert/strict";
import {
  allocatedBySheet, sheetRemaining, unallocated, brokerLedger, allocatePayment,
  openSheetsFor, sheetsToSettle, brokerStatement,
} from "../src/brokerSettleData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

// Allied (1): two sheets that owe us, one where we owe them. Atlas (2): one sheet.
const sheets = [
  { id: 10, broker_id: 1, load_date: "2026-09-01", status: "open", closing_sheet_number: "CS-10" },
  { id: 11, broker_id: 1, load_date: "2026-09-15", status: "open", closing_sheet_number: "CS-11" },
  { id: 12, broker_id: 1, load_date: "2026-09-20", status: "open" },
  { id: 20, broker_id: 2, load_date: "2026-08-10", status: "settled" },        // closed outside the CRM
  { id: 21, broker_id: 2, load_date: "2026-10-01", status: "disputed" },
  { id: 22, broker_id: 2, load_date: "2026-10-02", status: "open", deleted_at: "2026-10-03" },
];
const calcById = { 10: { net: 1000 }, 11: { net: 500 }, 12: { net: -300 }, 20: { net: 900 }, 21: { net: 250 }, 22: { net: 9999 } };

t("allocated per sheet ignores deleted payments", () => {
  assert.deepEqual(allocatedBySheet([
    { allocations: [{ sheet_id: 10, amount: 600 }, { sheet_id: 11, amount: 100 }] },
    { allocations: [{ sheet_id: 10, amount: "50" }] },
    { allocations: [{ sheet_id: 10, amount: 1 }], deleted_at: "x" },
    { allocations: null },
  ]), { 10: 650, 11: 100 });
});

t("remaining keeps the sign and treats hand-settled sheets as paid", () => {
  assert.equal(sheetRemaining({ status: "open" }, 1000, 600), 400);
  assert.equal(sheetRemaining({ status: "open" }, -300, 100), -200);
  assert.equal(sheetRemaining({ status: "open" }, 1000, 1000), 0);
  assert.equal(sheetRemaining({ status: "open" }, 1000, 1200), 0);
  assert.equal(sheetRemaining({ status: "settled" }, 900, 0), 0);
  assert.equal(sheetRemaining({ status: "settled" }, 900, 400), 500);   // settled by mistake while partly paid
  assert.equal(unallocated({ amount: 1000, allocations: [{ amount: 600 }] }), 400);
  assert.equal(unallocated({ amount: 100, allocations: [{ amount: 150 }] }), 0);
});

t("ledger: owes us, we owe, credit on account, balance", () => {
  const payments = [
    { broker_id: 1, direction: "in", amount: 800, allocations: [{ sheet_id: 10, amount: 700 }] },   // 100 unallocated
    { broker_id: 1, direction: "out", amount: 300, allocations: [{ sheet_id: 12, amount: 300 }] },
  ];
  const rows = brokerLedger({ sheets, calcById, payments });
  const allied = rows.find((r) => r.brokerId === 1), atlas = rows.find((r) => r.brokerId === 2);
  assert.equal(allied.owesUs, 300 + 500);
  assert.equal(allied.weOwe, 0);
  assert.equal(allied.credit, 100);
  assert.equal(allied.balance, 700);
  assert.equal(allied.openSheets, 2);
  assert.equal(allied.oldest, "2026-09-01");
  assert.equal(allied.paidIn, 800);
  assert.equal(allied.paidOut, 300);
  assert.equal(atlas.owesUs, 250);           // the disputed sheet still counts; the settled and deleted ones don't
  assert.equal(atlas.balance, 250);
});

t("allocation: oldest first, only sheets on the payment's side", () => {
  const open = openSheetsFor(1, { sheets, calcById, payments: [] });
  assert.deepEqual(open.map((s) => [s.id, s.remaining]), [[10, 1000], [11, 500], [12, -300]]);
  assert.deepEqual(allocatePayment(1200, open, "in"), { allocations: [{ sheet_id: 10, amount: 1000 }, { sheet_id: 11, amount: 200 }], unassigned: 0 });
  assert.deepEqual(allocatePayment(2000, open, "in"), { allocations: [{ sheet_id: 10, amount: 1000 }, { sheet_id: 11, amount: 500 }], unassigned: 500 });
  assert.deepEqual(allocatePayment(300, open, "out"), { allocations: [{ sheet_id: 12, amount: 300 }], unassigned: 0 });
  assert.deepEqual(allocatePayment(0, open, "in"), { allocations: [], unassigned: 0 });
});

t("sheets to settle once a payment covers them", () => {
  const payments = [{ broker_id: 1, direction: "in", amount: 1200, allocations: [{ sheet_id: 10, amount: 1000 }, { sheet_id: 11, amount: 200 }] }];
  assert.deepEqual(sheetsToSettle({ sheets, calcById, payments }), [10]);
  assert.deepEqual(sheetsToSettle({ sheets, calcById, payments: [] }), []);
});

t("statement: sheets and payments by date with a running balance", () => {
  const payments = [
    { id: 1, broker_id: 1, direction: "in", amount: 1000, paid_date: "2026-09-10", method: "ACH", reference: "R-1", allocations: [{ sheet_id: 10, amount: 1000 }] },
    { id: 2, broker_id: 1, direction: "out", amount: 300, paid_date: "2026-09-25", method: "Zelle", allocations: [{ sheet_id: 12, amount: 300 }] },
  ];
  const st = brokerStatement(1, { sheets, calcById, payments });
  assert.deepEqual(st.lines.map((l) => [l.kind, l.date, l.amount, l.balance]), [
    ["sheet", "2026-09-01", 1000, 1000],
    ["payment", "2026-09-10", -1000, 0],
    ["sheet", "2026-09-15", 500, 500],
    ["sheet", "2026-09-20", -300, 200],
    ["payment", "2026-09-25", 300, 500],
  ]);
  assert.equal(st.balance, 500);
  assert.equal(st.lines[1].label, "ACH · R-1");
  // Atlas: the sheet settled outside the CRM is left out.
  assert.deepEqual(brokerStatement(2, { sheets, calcById, payments: [] }).lines.map((l) => l.id), [21]);
});

if (!process.exitCode) console.log("\nAll broker settlement tests passed.");
