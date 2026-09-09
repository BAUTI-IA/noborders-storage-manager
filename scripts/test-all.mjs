#!/usr/bin/env node
// Runs every scripts/test-*.mjs in sequence and exits 1 if any of them fails.
// Each test file sets its own exit code, so this is just the aggregator.
//
// Run with:  npm test   (CI runs it on every PR — see .github/workflows/ci.yml)
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => /^test-.*\.mjs$/.test(f) && f !== "test-all.mjs").sort();

const failed = [];
for (const f of files) {
  console.log(`\n── ${f} ──`);
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(f);
}

console.log("");
if (failed.length) {
  console.log(`✗ ${failed.length} of ${files.length} test file(s) failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`✓ All ${files.length} test files passed.`);
