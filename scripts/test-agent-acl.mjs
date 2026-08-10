#!/usr/bin/env node
// Security-critical unit tests for the agent's gatekeeping: who may write what,
// and which tables the read tool may touch. Pure — no DB, no network.
//
//   node scripts/test-agent-acl.mjs
import { checkPermission, canRead } from "../lib/acl.mjs";
import { referencedTables, checkSqlAccess } from "../lib/agentWrite.mjs";
import { RECIPES } from "../lib/recipes.mjs";

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`✗ ${name}\n   esperado: ${JSON.stringify(want)}\n   obtenido: ${JSON.stringify(got)}`); }
  else console.log(`✓ ${name}`);
};

const admin = { role: "admin", email: "a@x.com" };
const dispatcher = { role: "member", email: "d@x.com", permissions: { jobs: { view: true, create: true, edit: true }, dispatching: { view: true }, trips: { view: true, create: true, edit: true } } };
const viewer = { role: "member", email: "v@x.com", permissions: { jobs: { view: true } } };

// ── Permissions ──────────────────────────────────────────────────────────────
eq("admin puede insertar pagos", checkPermission(admin, "payments", "insert").ok, true);
eq("dispatcher NO puede insertar pagos", checkPermission(dispatcher, "payments", "insert").ok, false);
eq("dispatcher puede crear jobs", checkPermission(dispatcher, "storage_jobs", "insert").ok, true);
eq("dispatcher puede editar trips", checkPermission(dispatcher, "trips", "update").ok, true);
eq("viewer NO puede editar jobs", checkPermission(viewer, "storage_jobs", "update").ok, false);
eq("sin perfil no se puede escribir", checkPermission(null, "storage_jobs", "insert").ok, false);
eq("nadie escribe profiles (ni admin)", checkPermission(admin, "profiles", "update").ok, false);
eq("nadie escribe el chat interno", checkPermission(admin, "chat_messages", "insert").ok, false);
eq("tabla inexistente rechazada", checkPermission(admin, "no_existe", "insert").ok, false);
// storage_billing has no deleted_at: deleting it would be irreversible.
eq("no se borra storage_billing", checkPermission(admin, "storage_billing", "soft_delete").ok, false);
eq("sí se borran jobs (recuperable)", checkPermission(admin, "storage_jobs", "soft_delete").ok, true);
// claim_notes is insertLevel:'edit' — a viewer with only claims.create must not pass.
eq("claim_notes exige edit, no create",
  checkPermission({ role: "member", permissions: { claims: { create: true } } }, "claim_notes", "insert").ok, false);

// ── Reads ────────────────────────────────────────────────────────────────────
eq("viewer lee jobs", canRead(viewer, "storage_jobs"), true);
eq("viewer NO lee pagos", canRead(viewer, "payments"), false);
eq("nadie lee profiles", canRead(admin, "profiles"), false);

// ── SQL gating ───────────────────────────────────────────────────────────────
eq("parsea tablas de un join",
  referencedTables("select * from storage_jobs j join payments p on p.job_id = j.id").map((t) => t.table),
  ["storage_jobs", "payments"]);
eq("ignora los CTE",
  referencedTables("with pend as (select * from payments) select * from pend").map((t) => t.table),
  ["payments"]);
eq("bloquea profiles", !!checkSqlAccess("select role from profiles", admin), true);
eq("bloquea el chat del equipo", !!checkSqlAccess("select * from chat_messages", admin), true);
eq("bloquea otros esquemas", !!checkSqlAccess("select * from auth.users", admin), true);
eq("permite information_schema", checkSqlAccess("select * from information_schema.columns", admin), null);
eq("admin lee pagos", checkSqlAccess("select * from payments", admin), null);
eq("viewer no lee pagos por sql", !!checkSqlAccess("select * from payments", viewer), true);
eq("sin perfil lee tablas de negocio", checkSqlAccess("select * from payments", null), null);

// ── Recipes ──────────────────────────────────────────────────────────────────
// Every recipe must declare permissions the ACL actually recognises: a typo in a
// table name would otherwise only surface when a user tries the operation.
const badPerms = [];
for (const [name, r] of Object.entries(RECIPES)) {
  if (!Array.isArray(r.perms) || !r.perms.length) { badPerms.push(`${name}: sin perms`); continue; }
  for (const [table, op] of r.perms) {
    if (!checkPermission(admin, table, op).ok) badPerms.push(`${name}: ${table}/${op}`);
  }
  if (typeof r.run !== "function") badPerms.push(`${name}: sin run()`);
  if (typeof r.describe !== "function") badPerms.push(`${name}: sin describe()`);
}
eq("todas las recetas declaran permisos válidos", badPerms, []);
// The capabilities the owner asks for by name — a guard against silently
// dropping one in a refactor.
for (const n of ["create_trip", "assign_jobs_to_trip", "record_payment", "set_truck_location"]) {
  eq(`existe la receta ${n}`, !!RECIPES[n], true);
}

console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodo OK");
process.exit(failed ? 1 : 0);
