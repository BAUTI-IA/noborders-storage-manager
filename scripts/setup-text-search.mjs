#!/usr/bin/env node
// One-time migration: creates public.search_crm_text(q, max_rows), la búsqueda
// de texto libre que usa el agente (herramienta `search` en lib/agent.mjs) para
// llegar a lo que el esquema no indexa: descripciones de claims, notas de jobs,
// comentarios de pagos y gastos, paradas de trips…
//
// Qué columnas entran y cómo se puntúa está declarado en lib/textCorpus.mjs;
// este script solo manda el SQL que esa declaración genera.
//
// Instala pg_trgm y unaccent (ambas habilitadas en Supabase, también en el plan
// free). Sin índices GIN a propósito: unaccent no es IMMUTABLE, así que no entra
// en una expresión de índice sin envolverla, y con tablas de cientos de filas el
// seq scan tarda milisegundos. Si algún día una de estas tablas crece de verdad,
// ese es el momento de agregarlos (ver docs/rag.md).
//
// La función es security definer y NO filtra por permisos: eso lo hace
// lib/retrieval.mjs en JS con canRead(), igual que checkSqlAccess() para la
// herramienta sql. Está revocada de anon/authenticated: solo el service role.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-text-search.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
import { buildSearchSql, TEXT_SOURCES } from "../lib/textCorpus.mjs";

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-text-search.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: buildSearchSql() }),
});

const text = await res.text();
if (res.ok) {
  console.log(`✓ search_crm_text lista sobre ${TEXT_SOURCES.length} tablas: ${TEXT_SOURCES.map((s) => s.table).join(", ")}`);
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
