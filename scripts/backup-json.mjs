#!/usr/bin/env node
// Backup de datos de Supabase SIN contraseña de la base.
// Usa la service_role key (que salteа RLS) contra la API REST (PostgREST)
// para exportar todas las tablas a archivos JSON.
//
// Variables de entorno:
//   SUPABASE_URL                (default: proyecto noborders-storages)
//   SUPABASE_SERVICE_ROLE_KEY   (obligatoria)
//   BACKUP_DIR                  (default: ./backup)
//
// Uso: node scripts/backup-json.mjs
//
// Nota: esto respalda los DATOS (filas de cada tabla). El esquema
// (tablas, funciones, políticas RLS) ya vive versionado en scripts/*.sql.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://szkmktxziojzgfjkomua.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BACKUP_DIR = process.env.BACKUP_DIR || "backup";
const PAGE = 1000; // PostgREST devuelve como mucho ~1000 filas por request

if (!KEY) {
  console.error(
    "Falta SUPABASE_SERVICE_ROLE_KEY. Copiala de Supabase → Settings → API Keys."
  );
  process.exit(1);
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
};

async function discoverTables() {
  // El root de PostgREST expone un OpenAPI con todas las tablas/vistas.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers });
  if (!res.ok) {
    throw new Error(`No se pudo listar las tablas (HTTP ${res.status})`);
  }
  const spec = await res.json();
  const defs = spec.definitions || {};
  return Object.keys(defs).sort();
}

async function dumpTable(table) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(
      table
    )}?select=*&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break; // última página
  }
  return rows;
}

async function main() {
  await mkdir(BACKUP_DIR, { recursive: true });
  const tables = await discoverTables();
  console.log(`Encontradas ${tables.length} tablas/vistas.`);

  const manifest = { tables: {}, errors: {} };
  let failures = 0;

  for (const table of tables) {
    try {
      const rows = await dumpTable(table);
      await writeFile(
        join(BACKUP_DIR, `${table}.json`),
        JSON.stringify(rows, null, 0)
      );
      manifest.tables[table] = rows.length;
      console.log(`  ✓ ${table}: ${rows.length} filas`);
    } catch (e) {
      failures++;
      manifest.errors[table] = String(e.message || e);
      console.error(`  ✗ ${table}: ${e.message || e}`);
    }
  }

  await writeFile(
    join(BACKUP_DIR, "_manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  const ok = Object.keys(manifest.tables).length;
  console.log(`\nBackup: ${ok} tablas OK, ${failures} con error.`);
  if (failures > 0) {
    console.error("Hubo tablas que fallaron (ver arriba). Backup parcial.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Backup falló:", e.message || e);
  process.exit(1);
});
