#!/usr/bin/env node
// Vuelca los bloques que un agente EXTERNO (ElevenLabs) no puede generar solo:
// el esquema de la base y el directorio de ids. Son los mismos que
// lib/voice.mjs le inyecta al agente propio en cada sesión — de ahí que esto
// reuse getDbSchema()/getReferenceData()/voiceSchema() en vez de copiarlos: el
// día que cambie el esquema, este volcado cambia con él.
//
// El agente de ElevenLabs recibe su prompt una sola vez, al guardarlo, así que
// hay que volver a correr esto y volver a pegarlo cuando cambien las tablas o
// se agregue un broker/truck/driver que quieras que resuelva sin consultar.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/dump-agent-prompt.mjs
//
//   --schema-only / --directory-only   un solo bloque
//   --budget=N                         caracteres de esquema (default: el de la voz)
import { getDbSchema, getReferenceData } from "../lib/agent.mjs";
import { voiceSchema } from "../lib/voice.mjs";

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Falta SUPABASE_SERVICE_ROLE_KEY (Supabase → Settings → API Keys).");
  console.error("Necesita también SUPABASE_URL si no es el proyecto por defecto.");
  process.exit(1);
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const budgetArg = args.find((a) => a.startsWith("--budget="));
const budget = budgetArg ? Number(budgetArg.split("=")[1]) : undefined;

const wantSchema = !has("--directory-only");
const wantDirectory = !has("--schema-only");

// Un fallo acá tiene una sola causa práctica (falta la migración de
// agent_query, o la key no es la de service role), así que vale decirlo en vez
// de escupir un stack.
const fail = (what, e) => {
  console.error(`\nNo pude leer ${what}: ${e?.message || e}`);
  console.error("¿Corriste scripts/setup-agent-query.mjs? ¿La key es la de service_role?");
  process.exit(1);
};

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

console.log("# Pegá esto en el system prompt del agente de ElevenLabs.");
console.log(`# Generado el ${TODAY} — volvé a correrlo cuando cambie el esquema.\n`);

if (wantSchema) {
  const full = await getDbSchema().catch((e) => fail("el esquema", e));
  console.log("DATABASE (PostgreSQL, table: columns):");
  console.log(voiceSchema(full, budget));
  console.log();
}

if (wantDirectory) {
  const directory = await getReferenceData().catch((e) => fail("el directorio", e));
  console.log("CRM DIRECTORY (ids listos para usar — NO los busques con una query):");
  console.log(directory);
  console.log();
}

console.log(`TODAY: ${TODAY} (timezone America/New_York).`);
console.log("# ↑ Este agente no sabe qué día es. Si tu plataforma tiene una variable");
console.log("#   dinámica de fecha, usala acá en vez de la fecha fija de arriba.");
