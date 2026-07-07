#!/usr/bin/env node
// Security hardening for Supabase Storage: makes every document bucket PRIVATE
// and ensures authenticated-only access policies. Run once after deploying the
// signed-URL frontend (the app already resolves legacy public URLs to signed
// URLs at view time, so nothing breaks).
//
// What it does:
//   1. storage.buckets.public = false for all app buckets — public "object/public/..."
//      URLs stop working; documents with client PII are no longer world-readable.
//   2. Drops every storage.objects policy granted to the `anon` role (nothing in
//      this app should be readable without a session).
//   3. Creates read/write policies for `authenticated` users on the buckets that
//      were created by hand in the dashboard (the bol-* buckets already have
//      has_perm-based policies from setup-bol.mjs, which are kept).
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-storage-security.mjs

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-storage-security.mjs");
  process.exit(1);
}

// Every bucket the app uses. bol-signed should already be private; making it
// private again is a no-op.
const ALL_BUCKETS = ["bol-templates", "bol-generated", "bol-signed", "compliance-docs", "payment-docs", "closing-sheet-docs"];
// Buckets created from the dashboard that need explicit authenticated policies
// once they stop being public (the bol-* ones already have has_perm policies).
const DASHBOARD_BUCKETS = ["compliance-docs", "payment-docs", "closing-sheet-docs"];

const bucketList = ALL_BUCKETS.map((b) => `'${b}'`).join(", ");

const policiesFor = (b) => {
  const name = b.replace(/-/g, "_");
  return `
drop policy if exists ${name}_auth_sel on storage.objects;
create policy ${name}_auth_sel on storage.objects for select to authenticated
  using ( bucket_id = '${b}' );
drop policy if exists ${name}_auth_ins on storage.objects;
create policy ${name}_auth_ins on storage.objects for insert to authenticated
  with check ( bucket_id = '${b}' );
drop policy if exists ${name}_auth_upd on storage.objects;
create policy ${name}_auth_upd on storage.objects for update to authenticated
  using ( bucket_id = '${b}' ) with check ( bucket_id = '${b}' );
drop policy if exists ${name}_auth_del on storage.objects;
create policy ${name}_auth_del on storage.objects for delete to authenticated
  using ( bucket_id = '${b}' );`;
};

const SQL = `
-- 1) No more public buckets: getPublicUrl links stop resolving.
update storage.buckets set public = false where id in (${bucketList});

-- 2) Nothing anonymous should touch storage in this app.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and 'anon' = any(roles)
  loop
    execute format('drop policy %I on storage.objects', pol.policyname);
  end loop;
end $$;

-- 3) Authenticated-only access for the dashboard-created buckets.
${DASHBOARD_BUCKETS.map(policiesFor).join("\n")}
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});
const text = await res.text();
if (res.ok) {
  console.log(`✓ Buckets privados: ${ALL_BUCKETS.join(", ")}.`);
  console.log("✓ Políticas anon eliminadas de storage.objects.");
  console.log("✓ Acceso authenticated asegurado en compliance-docs, payment-docs y closing-sheet-docs.");
  console.log("  La app ya abre todo con URLs firmadas, así que los documentos viejos siguen visibles para usuarios logueados.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
