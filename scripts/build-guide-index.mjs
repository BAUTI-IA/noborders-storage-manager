#!/usr/bin/env node
// Genera lib/guideText.mjs — el corpus de la guía del CRM que el agente lee para
// contestar "¿cómo se usa esto?" (herramienta `guide` en lib/agent.mjs).
//
//   node scripts/build-guide-index.mjs [--check]
//
//   --check  no escribe: falla si el generado quedó desactualizado respecto de
//            docs/*.html (lo corre el workflow semanal antes de comitear).
//
// Por qué un módulo JS comiteado y no leer el HTML con fs en runtime: el bundler
// de Vercel no traza archivos de datos sueltos del repo de forma confiable, y un
// fs.readFileSync("docs/…") que anda en local se rompe en la lambda.
//
// La fuente es la guía VIVA (docs/guia-crm.html + docs/crm-guide-en.html), que
// scripts/update-guide.mjs actualiza cada lunes. GUIA-CRM.md de la raíz quedó
// huérfano cuando entró ese pipeline: no se indexa, para no contestar con
// documentación vieja.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GUIDE_TOKEN_BUDGET, approxTokens, parseGuide } from "../lib/guideParse.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "lib", "guideText.mjs");
const SOURCES = [
  { lang: "es", path: "docs/guia-crm.html" },
  { lang: "en", path: "docs/crm-guide-en.html" },
];

const CHECK = process.argv.includes("--check");
const guide = {};
let overBudget = false;

for (const { lang, path } of SOURCES) {
  const file = join(ROOT, path);
  if (!existsSync(file)) {
    console.error(`ERROR: falta ${path}`);
    process.exit(1);
  }
  const sections = parseGuide(readFileSync(file, "utf8"));
  if (!sections.length) {
    console.error(`ERROR: ${path} no tiene marcadores <!-- section:ID -->`);
    process.exit(1);
  }
  const tokens = approxTokens(sections.map((s) => s.text).join("\n"));
  console.log(`${lang}: ${sections.length} secciones, ~${tokens} tokens (${sections.map((s) => s.id).join(", ")})`);
  if (tokens > GUIDE_TOKEN_BUDGET) {
    console.warn(`AVISO: la guía ${lang} (~${tokens} tok) superó el presupuesto de ${GUIDE_TOKEN_BUDGET}. La herramienta \`guide\` va a devolver el índice en vez del texto completo; ver docs/rag.md.`);
    overBudget = true;
  }
  guide[lang] = sections;
}

const body = `// GENERADO por scripts/build-guide-index.mjs — no editar a mano.
// Fuente: docs/guia-crm.html + docs/crm-guide-en.html, que actualiza el workflow
// semanal .github/workflows/weekly-guide.yml. Regenerar con: npm run guide:index
export const GUIDE = ${JSON.stringify(guide, null, 2)};
`;

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== body) {
    console.error("ERROR: lib/guideText.mjs está desactualizado. Corré: npm run guide:index");
    process.exit(1);
  }
  console.log("✓ lib/guideText.mjs al día");
} else {
  writeFileSync(OUT, body);
  console.log(`✓ ${OUT}`);
}
if (overBudget) console.log("(el índice se generó igual)");
