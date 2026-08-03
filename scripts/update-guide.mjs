#!/usr/bin/env node
// Actualiza las dos guías HTML del CRM (docs/guia-crm.html + docs/crm-guide-en.html)
// con los cambios recientes del código, usando Claude. Corre cada lunes desde
// .github/workflows/weekly-guide.yml y también a mano:
//
//   ANTHROPIC_API_KEY=sk-... node scripts/update-guide.mjs [--dry] [--force] [--since <sha>]
//
//   --dry    imprime las ediciones propuestas sin escribir nada
//   --force  saltea los filtros de "sin cambios" (usar para la primera corrida)
//   --since  commit base explícito (default: último commit con [guide-bot], sino 7 días)
//
// Cómo funciona:
//   1. Junta los commits desde el commit base y filtra a src/ + api/ (si no hay
//      nada y no faltan secciones del NAV → sale sin llamar a la API).
//   2. Extrae el NAV de src/App.jsx (fuente de verdad de las secciones del CRM)
//      y detecta secciones sin cubrir en la guía.
//   3. Le pide a Claude (2 llamadas: ES y después EN, en lockstep) ediciones en
//      JSON estricto por sección. Los mocks de UI (<!-- static-mock -->) y el CSS
//      del <head> nunca se le mandan para editar: se reinsertan byte a byte.
//   4. Valida todo (marcadores balanceados, sin <script>, ids conocidos, deltas
//      de tamaño razonables) y recién ahí escribe. Cualquier fallo → exit 1 sin
//      tocar archivos. El render a PDF lo hace scripts/render-guide-pdf.mjs.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";
const APP = "src/App.jsx";
const GUIDES = [
  { path: "docs/guia-crm.html", lang: "es" },
  { path: "docs/crm-guide-en.html", lang: "en" },
];
// Secciones propias de la guía que no existen en el NAV pero son válidas.
const EXTRA_IDS = ["cover", "intro", "acceso", "menu", "tips"];
const DIFF_CAP = 50_000; // bytes de diff que se mandan al modelo, como máximo

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const FORCE = args.includes("--force");
const SINCE = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;

const git = (...a) => {
  try { return execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch { return ""; }
};

function setOutput(changed) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `guide_changed=${changed}\n`);
  console.log(`guide_changed=${changed}`);
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---------- 1. Commits desde la última corrida ----------
function baseCommit() {
  if (SINCE) return SINCE;
  const bot = git("log", "-1", "--format=%H", "--grep=\\[guide-bot\\]");
  if (bot) return bot;
  return git("rev-list", "-1", "--before=7 days ago", "HEAD") || git("rev-list", "--max-parents=0", "HEAD");
}

function collectChanges(base) {
  const subjects = git("log", "--format=%h %s", `${base}..HEAD`, "--", "src/", "api/");
  const files = git("log", "--format=", "--name-only", `${base}..HEAD`, "--", "src/", "api/")
    .split("\n").map((f) => f.trim()).filter(Boolean);
  const relevant = [...new Set(files)].filter((f) => /^(src\/.*\.(jsx|js)|api\/.*\.mjs)$/.test(f));
  let appDiff = git("diff", `${base}..HEAD`, "--", APP);
  if (appDiff.length > DIFF_CAP) appDiff = appDiff.slice(0, DIFF_CAP) + "\n… (diff truncado)";
  const otherStat = git("diff", "--stat", `${base}..HEAD`, "--", "src/", "api/", `:(exclude)${APP}`);
  return { subjects, relevant, appDiff, otherStat };
}

// ---------- 2. NAV desde src/App.jsx ----------
function extractNav() {
  const src = readFileSync(APP, "utf8");
  const start = src.indexOf("const NAV = [");
  if (start < 0) fail(`no se encontró "const NAV = [" en ${APP}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) fail(`no se encontró el cierre del NAV en ${APP}`);
  const body = src.slice(start + "const NAV = ".length, end + 2);
  let nav;
  try { nav = new Function(`return ${body}`)(); }
  catch (e) { fail(`el literal NAV de ${APP} no se pudo evaluar: ${e.message}`); }
  return nav.flatMap((g) => g.items.map((it) => ({ id: it.id, label: it.label, group: g.section })));
}

// ---------- 3. Parseo de la guía por marcadores ----------
// Devuelve partes ordenadas: {type:"raw", text} | {type:"section", ids:[..], inner}
function parseGuide(html) {
  const parts = [];
  const re = /<!-- section:([a-z_,]+) -->\n([\s\S]*?)\n<!-- \/section:\1 -->/g;
  let last = 0, m;
  while ((m = re.exec(html))) {
    if (m.index > last) parts.push({ type: "raw", text: html.slice(last, m.index) });
    parts.push({ type: "section", ids: m[1].split(","), inner: m[2] });
    last = re.lastIndex;
  }
  parts.push({ type: "raw", text: html.slice(last) });
  if (!parts.some((p) => p.type === "section")) fail("la guía no tiene marcadores <!-- section:ID -->");
  return parts;
}

function serializeGuide(parts) {
  return parts.map((p) =>
    p.type === "raw" ? p.text : `<!-- section:${p.ids.join(",")} -->\n${p.inner}\n<!-- /section:${p.ids.join(",")} -->`
  ).join("");
}

// Reemplaza los bloques static-mock por placeholders y los guarda para reinsertar.
function stripMocks(inner, sectionKey, store) {
  let n = 0;
  return inner.replace(/<!-- static-mock -->[\s\S]*?<!-- \/static-mock -->/g, (block) => {
    const token = `<!-- static-mock:${sectionKey}:${++n} -->`;
    store.set(token, block);
    return token;
  });
}

function restoreMocks(inner, store) {
  let out = inner;
  for (const [token, block] of store) if (out.includes(token)) out = out.replace(token, block);
  return out;
}

// ---------- 4. Prompts ----------
function systemPrompt(lang) {
  const common = `Sos el redactor técnico de la guía de usuario del CRM "No Borders Moving — Operations CRM".
La guía es un HTML imprimible (A4). Editás SOLO el contenido de las secciones que se te piden; el CSS y los mocks de UI están afuera de tu alcance.

Reglas de formato HTML (respetalas a rajatabla):
- Usá los idioms existentes: <h1 class="sec"><span class="num">N</span>Título</h1>, <p class="lead">, tablas class="g" y class="t", cajas <div class="note"> / <div class="warn">, <div class="card">, <div class="two"> para dos columnas, clase "avoid" para no cortar en página, clase "break" para forzar salto de página.
- Los tokens <!-- static-mock:...:N --> son ilustraciones congeladas: dejalos EXACTAMENTE donde están (o movelos dentro de la misma sección), nunca los borres ni inventes nuevos.
- Nada de <script>, <style>, <link> ni atributos on*.
- Numeración: si agregás secciones, continuá la numeración visible de los <span class="num"> y actualizá la tabla de contenido de la sección "intro" si hace falta (con un edit replace_section de "intro").

Terminología del negocio (SIEMPRE en inglés, en los dos idiomas): job, driver, broker, trip, storage, closing sheet, settlement, pads, BOL, CF, warehouse, live load, FADD, sticker, lot.`;
  const es = `
Idioma: español rioplatense con voseo ("tocá", "podés", "elegí", "cargá"). Tono directo y práctico, como el resto de la guía.`;
  const en = `
Language: plain practical English, mirroring the Spanish guide's structure and section order exactly. Keep the same business terms.`;
  return common + (lang === "es" ? es : en);
}

function userPrompt({ lang, guideForModel, nav, missing, changes, esEdits }) {
  const navList = nav.map((s) => `- ${s.id} · "${s.label}" (grupo ${s.group})`).join("\n");
  const missingList = missing.length
    ? `Secciones del CRM que HOY NO están cubiertas en la guía (tenés que agregarlas con "add_section", una entrada corta y útil por sección, siguiendo el estilo de las existentes):\n${missing.map((s) => `- ${s.id} · "${s.label}"`).join("\n")}`
    : "No hay secciones del NAV sin cubrir.";
  const changeBlock = changes.subjects
    ? `Commits desde la última actualización de la guía:\n${changes.subjects}\n\nDiff de src/App.jsx (la UI principal):\n\`\`\`diff\n${changes.appDiff || "(sin cambios en App.jsx)"}\n\`\`\`\n\nResumen de otros archivos tocados:\n${changes.otherStat || "(ninguno)"}`
    : "No hubo commits relevantes desde la última corrida (esta corrida es solo para cubrir secciones faltantes).";
  const lockstep = esEdits
    ? `\nLa versión en ESPAÑOL ya fue editada con estas operaciones (mantené la guía en inglés en lockstep: mismas secciones, mismo orden, mismos ids, contenido equivalente traducido):\n\`\`\`json\n${JSON.stringify(esEdits, null, 1)}\n\`\`\``
    : "";
  return `GUÍA ACTUAL (${lang === "es" ? "español" : "inglés"}), con cada sección entre <!-- section:ID --> y <!-- /section:ID -->:

\`\`\`html
${guideForModel}
\`\`\`

SECCIONES DEL CRM (NAV real de la app, fuente de verdad):
${navList}

${missingList}

${changeBlock}
${lockstep}

TAREA: decidí qué secciones de la guía necesitan cambios por estos commits, y generá las secciones faltantes. Si los cambios de código NO afectan nada visible para el usuario final Y no hay secciones faltantes, respondé {"no_user_visible_changes": true}.

Respondé SOLO con JSON válido (sin markdown, sin texto extra) con esta forma:
{
  "no_user_visible_changes": false,
  "edits": [
    {"op": "replace_section", "id": "jobs", "html": "<contenido interno completo de la sección, sin los marcadores section>"},
    {"op": "add_section", "after": "billing", "id": "claims", "html": "<contenido interno de la sección nueva>"}
  ]
}
- "id" en replace_section: uno de los ids ya presentes en la guía.
- "add_section": id = id del NAV que falta; "after" = id de una sección existente detrás de la cual va.
- Editá lo MÍNIMO necesario: secciones que no cambian, no las incluyas.`;
}

// ---------- 5. Llamada a Claude ----------
async function askClaude(client, lang, payload) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    system: systemPrompt(lang),
    messages: [{ role: "user", content: userPrompt(payload) }],
  });
  const msg = await stream.finalMessage();
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch { fail(`la respuesta de Claude (${lang}) no es JSON válido:\n${text.slice(0, 2000)}`); }
  if (!parsed.no_user_visible_changes && !Array.isArray(parsed.edits)) {
    fail(`la respuesta de Claude (${lang}) no tiene "edits"`);
  }
  return parsed;
}

// ---------- 6. Aplicar ediciones con validación ----------
function applyEdits(parts, edits, validIds, mocks) {
  const findSection = (id) => parts.find((p) => p.type === "section" && p.ids.includes(id));
  for (const e of edits) {
    if (!e || typeof e.html !== "string") fail(`edición inválida: ${JSON.stringify(e).slice(0, 200)}`);
    if (/<\s*script\b/i.test(e.html) || /\bon\w+\s*=/i.test(e.html)) fail(`la edición de "${e.id}" trae <script> o handlers inline`);
    if (e.op === "replace_section") {
      const part = findSection(e.id);
      if (!part) fail(`replace_section de un id inexistente: "${e.id}"`);
      // los mocks congelados de esa sección tienen que sobrevivir
      for (const token of mocks.keys()) {
        if (part.inner.includes(token) && !e.html.includes(token)) fail(`la edición de "${e.id}" perdió el mock ${token}`);
      }
      const ratio = e.html.length / Math.max(part.inner.length, 1);
      if (ratio > 5 || ratio < 0.15) fail(`la edición de "${e.id}" cambia el tamaño de la sección ${part.inner.length} → ${e.html.length} bytes (delta sospechoso)`);
      part.inner = e.html;
    } else if (e.op === "add_section") {
      if (!validIds.includes(e.id)) fail(`add_section con id desconocido: "${e.id}"`);
      if (findSection(e.id)) fail(`add_section de una sección que ya existe: "${e.id}"`);
      if (e.html.length < 200) fail(`la sección nueva "${e.id}" quedó demasiado corta (${e.html.length} bytes)`);
      const anchor = findSection(e.after);
      if (!anchor) fail(`add_section "${e.id}": el ancla "${e.after}" no existe`);
      const idx = parts.indexOf(anchor);
      parts.splice(idx + 1, 0, { type: "raw", text: "\n\n" }, { type: "section", ids: [e.id], inner: e.html });
    } else {
      fail(`op desconocida: "${e.op}"`);
    }
  }
  return parts;
}

function validateFinal(html, previousIds) {
  const open = (html.match(/<!-- section:/g) || []).length;
  const close = (html.match(/<!-- \/section:/g) || []).length;
  if (open !== close) fail(`marcadores de sección desbalanceados (${open} abren, ${close} cierran)`);
  if (/<!-- static-mock:/.test(html)) fail("quedó un placeholder de mock sin reinsertar");
  for (const id of previousIds) {
    if (!new RegExp(`<!-- section:[a-z_,]*\\b${id}\\b`).test(html)) fail(`desapareció la sección "${id}"`);
  }
}

// ---------- main ----------
const base = baseCommit();
console.log(`Commit base: ${base.slice(0, 10)} (${SINCE ? "--since" : "auto"})`);
const changes = collectChanges(base);
const nav = extractNav();

const esHtmlOrig = readFileSync(GUIDES[0].path, "utf8");
const coveredIds = [...esHtmlOrig.matchAll(/<!-- section:([a-z_,]+) -->/g)].flatMap((m) => m[1].split(","));
const missing = nav.filter((s) => !coveredIds.includes(s.id));
const validIds = [...nav.map((s) => s.id), ...EXTRA_IDS];

console.log(`Commits relevantes: ${changes.subjects ? changes.subjects.split("\n").length : 0} · archivos: ${changes.relevant.length} · secciones faltantes: ${missing.length}`);

if (!FORCE && !changes.relevant.length && !missing.length) {
  console.log("Sin cambios en src/ ni api/ y sin secciones faltantes: no hay nada que actualizar.");
  setOutput(false);
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) fail("falta ANTHROPIC_API_KEY en el entorno");
const client = new Anthropic();

let esEdits = null;
const results = [];
for (const guide of GUIDES) {
  const html = readFileSync(guide.path, "utf8");
  const parts = parseGuide(html);
  const mocks = new Map();
  for (const p of parts) if (p.type === "section") p.inner = stripMocks(p.inner, p.ids[0], mocks);
  const guideForModel = serializeGuide(parts.map((p) =>
    p.type === "raw" ? { ...p, text: p.text.replace(/<head>[\s\S]*<\/head>/, "<head>…(CSS omitido)…</head>") } : p
  ));

  console.log(`Pidiendo ediciones a ${MODEL} (${guide.lang})…`);
  const resp = await askClaude(client, guide.lang, { lang: guide.lang, guideForModel, nav, missing, changes, esEdits });

  if (resp.no_user_visible_changes) {
    if (missing.length) fail(`Claude (${guide.lang}) dijo "sin cambios" pero faltan ${missing.length} secciones del NAV`);
    if (guide.lang === "es") {
      console.log("Claude no encontró cambios visibles para el usuario. No se actualiza la guía.");
      setOutput(false);
      process.exit(0);
    }
    fail("la versión EN dijo 'sin cambios' pero la ES sí tuvo ediciones (quedarían fuera de sync)");
  }

  const previousIds = parts.filter((p) => p.type === "section").flatMap((p) => p.ids);
  applyEdits(parts, resp.edits, validIds, mocks);
  for (const p of parts) if (p.type === "section") p.inner = restoreMocks(p.inner, mocks);
  const finalHtml = serializeGuide(parts);
  validateFinal(finalHtml, previousIds);

  if (guide.lang === "es") esEdits = resp.edits.map((e) => ({ ...e, html: e.html.slice(0, 20_000) }));
  results.push({ path: guide.path, html: finalHtml, edits: resp.edits });
}

if (DRY) {
  for (const r of results) {
    console.log(`\n--dry · ${r.path}: ${r.edits.length} edición(es)`);
    for (const e of r.edits) console.log(`  ${e.op} ${e.id}${e.after ? ` (after ${e.after})` : ""} · ${e.html.length} bytes`);
  }
  setOutput(false);
  process.exit(0);
}

// Validado todo en los dos idiomas: recién ahora escribimos.
for (const r of results) {
  writeFileSync(r.path, r.html);
  console.log(`Escrito ${r.path} (${r.edits.length} edición(es))`);
}
setOutput(true);
