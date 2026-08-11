// Render + pricing tests for src/inboundJobs.jsx.
// Run: node scripts/test-inbound-render.mjs
//
// The JSX is transpiled with esbuild (which arrives transitively via vite, the
// same caveat as @babel/parser in scripts/check-i18n.mjs), then rendered with
// react-dom/server. This covers the two things the pure fixture tests cannot:
// that priceRow() agrees with the Job Calculator, and that a card actually
// renders the verdict, the money and the warnings.
import { build } from "esbuild";
import { renderToString } from "react-dom/server";
import React from "react";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The bundle must live INSIDE the repo: it imports react/react-dom as externals,
// and Node resolves those relative to the importing file.
const outDir = join(ROOT, "node_modules", ".cache", "inbound-smoke");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "bundle.mjs");

await build({
  entryPoints: [join(ROOT, "src/inboundJobs.jsx")],
  bundle: true, format: "esm", platform: "node", outfile: out,
  // The app uses the automatic JSX runtime (no `import React` in components);
  // esbuild defaults to the classic transform, which would emit
  // React.createElement and blow up at render time.
  jsx: "automatic",
  external: ["react", "react-dom", "react/jsx-runtime"],
  loader: { ".js": "jsx", ".jsx": "jsx" }, logLevel: "error",
});

const { InboundJobsSection, InboundJobCard, priceRow } = await import(out);
const { evaluateJob } = await import(join(ROOT, "src/jobCalcData.js"));

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };
const html = (el) => renderToString(el);

// ── fixture: an Adam's Moving estimate as the sync would have stored it ──────
const ROW = {
  id: 1, source: "gmail", decision: "pending", received_at: "2026-08-07T21:42:37Z",
  job_number: "AZ658357", customer: "David", broker: "Adam's Moving & Storage",
  origin_zip: "64119", dest_zip: "64151", cu_ft: 1385, estimate: 2499.56,
  carrier_rate_per_cf: 1.1, loaded_miles: 12, deadhead_miles: 30,
  pickup_date_from: "2026-08-03", raw_body: "Estimated Volume: 1385 cf.\nBalance: $2,389.56",
  parsed: {
    job_number: "AZ658357", customer: "David", volume_cf: 1385, estimate_total: 2499.56,
    pickup_zip: "64119", delivery_zip: "64151",
    pickup_date_from: "2026-08-03", pickup_date_to: "2026-08-03",
    carrier_name: "Adam's Moving & Storage",
    _validation: { ok: true, blocking: [], missing: [] },
    _issues: [],
  },
};

// ── priceRow ─────────────────────────────────────────────────────────────────

t("priceRow prices a stored row and returns a verdict", () => {
  const x = priceRow(ROW, {}, {});
  assert.ok(x.result, "expected a priced result");
  assert.ok(["red", "yellow", "green"].includes(x.result.verdict));
  assert.equal(x.result.totalMiles, 42);
  assert.equal(x.hasMiles, true);
});

t("priceRow agrees exactly with evaluateJob — the queue cannot drift from the calculator", () => {
  const x = priceRow(ROW, {}, {});
  const direct = evaluateJob(
    { originZip: "64119", destZip: "64151", cuFt: 1385, brokerPrice: 1385 * 1.1,
      originAccess: "direct", destAccess: "direct", longCarry: false, shuttle: false,
      trucks: 1, drivers: 1, helpers: 1 },
    {}, { loadedMiles: 12, deadheadMiles: 30 }
  );
  assert.equal(x.result.operatingMargin, direct.operatingMargin);
  assert.equal(x.result.verdict, direct.verdict);
  assert.equal(x.result.askPrice, direct.askPrice);
});

t("editing the carrier rate re-prices the card", () => {
  const cheap = priceRow(ROW, { carrierRate: "0.40" }, {});
  const rich = priceRow(ROW, { carrierRate: "3.00" }, {});
  assert.ok(rich.result.operatingMargin > cheap.result.operatingMargin);
  assert.equal(cheap.basis.assumed, false, "an explicit rate is never an assumption");
});

t("with no carrier rate the card falls back to the customer total and says so", () => {
  const x = priceRow({ ...ROW, carrier_rate_per_cf: null }, {}, {});
  assert.equal(x.basis.assumed, true);
  assert.equal(x.basis.brokerPrice, 2499.56);
});

t("a row with no miles yet is left unpriced rather than priced at zero cost", () => {
  const x = priceRow({ ...ROW, loaded_miles: null, deadhead_miles: null }, {}, {});
  assert.equal(x.hasMiles, false);
  assert.equal(x.result, null);
});

t("looked-up miles from the card override the stored ones", () => {
  const x = priceRow(ROW, { miles: { loadedMiles: 900, deadheadMiles: 100 } }, {});
  assert.equal(x.result.totalMiles, 1000);
});

t("priceRow tolerates a row whose extraction never populated parsed", () => {
  const x = priceRow({ id: 9, origin_zip: null, dest_zip: null }, {}, {});
  assert.equal(x.result, null);
  assert.deepEqual(x.issues, []);
  assert.equal(x.validation.ok, true);
});

// ── card rendering ───────────────────────────────────────────────────────────

t("the card renders the verdict, the profit and the job", () => {
  const x = priceRow(ROW, {}, {});
  const out = html(React.createElement(InboundJobCard, { x }));
  const vm = { red: "DO NOT TAKE IT", yellow: "CAREFUL", green: "TAKE IT" }[x.result.verdict];
  assert.ok(out.includes(vm), `expected the verdict "${vm}"`);
  assert.ok(out.includes("AZ658357"), "expected the job number");
  assert.ok(out.includes("David"), "expected the customer");
  assert.ok(out.includes("Accept — open the job form"));
  assert.ok(out.includes("Carrier rate $/CF"));
});

t("an unpriced card offers the miles lookup instead of a fake number", () => {
  const x = priceRow({ ...ROW, loaded_miles: null, deadhead_miles: null }, {}, {});
  const out = html(React.createElement(InboundJobCard, { x }));
  assert.ok(out.includes("Not priced yet"));
  assert.ok(out.includes("Look up"));
});

t("a blocked extraction shows what is missing and cannot be silently accepted", () => {
  const blocked = { ...ROW, dest_zip: null, parsed: { ...ROW.parsed, _validation: { ok: false, blocking: ["delivery_zip"], missing: [] } } };
  const out = html(React.createElement(InboundJobCard, { x: priceRow(blocked, {}, {}) }));
  assert.ok(out.includes("Cannot be priced yet."));
  assert.ok(out.includes("delivery_zip"));
});

t("a cross-check disagreement is shown next to the card", () => {
  const suspect = { ...ROW, parsed: { ...ROW.parsed, _issues: [{ field: "balance", model: 1, source: 2389.56 }] } };
  const out = html(React.createElement(InboundJobCard, { x: priceRow(suspect, {}, {}) }));
  assert.ok(out.includes("Check these against the email."));
  assert.ok(out.includes("balance"));
});

t("the customer-total warning appears only when no carrier rate is known", () => {
  const withRate = html(React.createElement(InboundJobCard, { x: priceRow(ROW, {}, {}) }));
  const without = html(React.createElement(InboundJobCard, { x: priceRow({ ...ROW, carrier_rate_per_cf: null }, {}, {}) }));
  assert.ok(!withRate.includes("Priced on the customer total"));
  assert.ok(without.includes("Priced on the customer total"));
});

t("the rejected view offers reopening instead of accepting", () => {
  const out = html(React.createElement(InboundJobCard, { x: priceRow(ROW, {}, {}), showRejected: true }));
  assert.ok(out.includes("Move back to pending"));
  assert.ok(!out.includes("Accept — open the job form"));
});

t("the email body is only rendered once opened", () => {
  const x = priceRow(ROW, {}, {});
  assert.ok(!html(React.createElement(InboundJobCard, { x })).includes("Balance: $2,389.56"));
  assert.ok(html(React.createElement(InboundJobCard, { x, mailOpen: true })).includes("Balance: $2,389.56"));
});

// ── section mounts ───────────────────────────────────────────────────────────

const thenable = (data) => new Proxy({}, {
  get(_t, p) {
    if (p === "then") return (res) => res({ data, error: null });
    if (p === "maybeSingle" || p === "single") return async () => ({ data: Array.isArray(data) ? data[0] : data, error: null });
    return () => thenable(data);
  },
});
const supabase = {
  from: (table) => thenable(table === "job_calc_settings" ? { settings: {} } : []),
  channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  removeChannel: () => {},
};

t("the section mounts and renders its toolbar", () => {
  const out = html(React.createElement(InboundJobsSection, {
    supabase,
    session: { access_token: "tok", user: { id: "u1", email: "a@b.c" } },
    profile: { role: "admin", permissions: {} },
    isAdmin: true, brokers: [{ id: 3, name: "Adams Moving" }], onPrefillJob: () => {},
  }));
  for (const needle of ["Check for new jobs", "Pending", "Rejected"]) {
    assert.ok(out.includes(needle), `toolbar missing "${needle}"`);
  }
});

rmSync(outDir, { recursive: true, force: true });
console.log(process.exitCode ? "\nSOME INBOUND RENDER TESTS FAILED" : "\nALL INBOUND RENDER TESTS PASSED");
