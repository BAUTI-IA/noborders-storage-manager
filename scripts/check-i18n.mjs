#!/usr/bin/env node
// i18n coverage checker. Scans src/*.jsx for user-visible UI strings (JSX text,
// placeholder/title attributes, alert/confirm dialogs) and reports the ones
// missing from the I18N_ES dictionary in src/i18n.js, plus Spanish-looking
// strings hardcoded in the source (the source language must be English).
//
// Run with:  npm run i18n:check
// Exit code 1 when something is missing, so it can gate CI.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

// ── Load dictionary keys from src/i18n.js ────────────────────────────────────
const i18nSrc = readFileSync(join(SRC, "i18n.js"), "utf8");
const dictStart = i18nSrc.indexOf("export const I18N_ES = {");
const dictEnd = i18nSrc.indexOf("\n};", dictStart);
const dict = new Set();
{
  const keyRe = /^\s*"((?:[^"\\]|\\.)*)":/gm;
  let m;
  const body = i18nSrc.slice(dictStart, dictEnd);
  while ((m = keyRe.exec(body))) dict.add(JSON.parse('"' + m[1] + '"'));
}

// ── Heuristics ───────────────────────────────────────────────────────────────
const hasLetter = (s) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(s);
// Strings that are all symbols/numbers, single chars, identifiers, URLs, CSS
// values, emails, etc. are not UI copy.
const ignorable = (raw) => {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length < 2 || !hasLetter(t)) return true;
  if (/^[a-z_$][\w$]*$/.test(t)) return true;               // identifier-like
  if (/^[A-Z]{1,4}$/.test(t)) return true;                  // acronyms (OK, CF…)
  if (/^https?:|^data:|^mailto:/.test(t)) return true;
  if (/^[\w.+-]+@[\w-]+\.\w{2,}$/.test(t)) return true;     // emails
  if (/^\d/.test(t) && !/\s/.test(t)) return true;          // 10x10, 17px…
  if (/^[#.]?[\w-]+(\([^)]*\))?$/.test(t) && !/\s/.test(t)) return true;
  return false;
};
const looksSpanish = (s) =>
  /[áéíóúñÁÉÍÓÚÑ¿¡]/.test(s) ||
  /\b(sin|elegí|cargá|corré|buscá|agregá|creá|falta|borrar|cuenta|nueva|nuevo|pendiente|cobro|pago|mes|semana|hoy|categoría|gastos|papelera|historial|bandeja|conciliación|ingresos|egresos|deberia|debería)\b/i.test(s);

// Whitelist: strings that read the same in both languages, proper nouns, or
// checker noise — never reported. The long list lives in scripts/i18n-ignore.json
// (exact-match, reviewed by hand); keep hardcoded additions SHORT.
const SAME_IN_BOTH = new Set(
  ["No Borders Moving", "Operations CRM", "OK", "Zelle", "Cash", "Check", "Total", "Supabase", "CSV", "PDF"].map((s) => s.toLowerCase())
);
const IGNORE = new Set(JSON.parse(readFileSync(join(ROOT, "scripts", "i18n-ignore.json"), "utf8")));

// ── AST walk ─────────────────────────────────────────────────────────────────
function walk(node, fn, parents = []) {
  if (!node || typeof node.type !== "string") return;
  fn(node, parents);
  const next = [...parents, node];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, next));
    else if (v && typeof v.type === "string") walk(v, fn, next);
  }
}

const DIALOG_CALLEES = new Set(["alert", "confirm", "prompt"]);
const ATTRS = new Set(["placeholder", "title", "aria-label", "alt"]);

function extract(file, src) {
  const ast = parse(src, { sourceType: "module", plugins: ["jsx"] });
  const found = new Map(); // text -> {kind, line}
  // Ranges covered by tr(en, es) / trAI(en, es) / t(en) calls — those strings
  // are already language-aware, so literals inside them are not "missing".
  const trRanges = [];
  walk(ast.program, (node) => {
    if (node.type !== "CallExpression") return;
    const c = node.callee;
    const name = c?.type === "Identifier" ? c.name : c?.type === "MemberExpression" && c.property?.type === "Identifier" ? c.property.name : null;
    if (name === "tr" || name === "trAI" || name === "t") trRanges.push([node.start, node.end]);
  });
  const inTr = (node) => trRanges.some(([s, e]) => node.start >= s && node.end <= e);
  const add = (raw, kind, line, node) => {
    const t = raw.replace(/\s+/g, " ").trim();
    if (ignorable(t) || SAME_IN_BOTH.has(t.toLowerCase()) || IGNORE.has(t)) return;
    if (node && inTr(node)) return;
    if (!found.has(t)) found.set(t, { kind, line });
  };
  walk(ast.program, (node, parents) => {
    const parent = parents[parents.length - 1];
    if (node.type === "JSXText") add(node.value, "jsx", node.loc.start.line, node);
    // <input placeholder="..." title="...">
    if (node.type === "JSXAttribute" && node.name?.name && ATTRS.has(node.name.name)) {
      if (node.value?.type === "StringLiteral") add(node.value.value, "attr:" + node.name.name, node.loc.start.line, node.value);
      // {cond ? "a" : "b"} inside attr
      if (node.value?.type === "JSXExpressionContainer") {
        walk(node.value, (n2) => {
          if (n2.type === "StringLiteral") add(n2.value, "attr:" + node.name.name, n2.loc.start.line, n2);
        });
      }
    }
    // String literals rendered as JSX children: {cond ? "Yes" : "No"} etc.
    if (node.type === "StringLiteral" && parent) {
      const inChildren = parents.some((p, i) => p.type === "JSXExpressionContainer" && parents[i - 1]?.type === "JSXElement");
      const inAttr = parents.some((p) => p.type === "JSXAttribute");
      const isCompare = parent.type === "BinaryExpression" || parent.type === "SwitchCase";
      const isProp = parent.type === "ObjectProperty" || parent.type === "MemberExpression" || parent.type === "CallExpression" && !inChildren;
      if (inChildren && !inAttr && !isCompare && !isProp) add(node.value, "jsx-expr", node.loc.start.line, node);
    }
    // Display strings declared in plain objects and rendered later via JSX
    // (NAV labels, PAGE_META titles/subs...): { label:"...", title:"...", sub:"..." }
    if (node.type === "ObjectProperty" && !node.computed && node.value?.type === "StringLiteral") {
      const key = node.key?.name || node.key?.value;
      if (["label", "title", "sub", "section"].includes(key)) add(node.value.value, "objprop:" + key, node.loc.start.line, node.value);
    }
    // alert("...") / window.confirm(`...`)
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name = callee?.type === "Identifier" ? callee.name : callee?.type === "MemberExpression" && callee.property?.type === "Identifier" ? callee.property.name : null;
      if (name && DIALOG_CALLEES.has(name)) {
        const arg = node.arguments[0];
        if (arg?.type === "StringLiteral") add(arg.value, "dialog", arg.loc.start.line, arg);
        if (arg?.type === "TemplateLiteral") arg.quasis.forEach((q) => hasLetter(q.value.cooked || "") && add(q.value.cooked, "dialog-template", q.loc.start.line, q));
      }
    }
  });
  return found;
}

let missing = 0, spanish = 0;
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".jsx")).sort()) {
  const src = readFileSync(join(SRC, f), "utf8");
  const found = extract(f, src);
  const rows = [...found.entries()].filter(([t]) => !dict.has(t));
  if (!rows.length) continue;
  console.log(`\n=== src/${f} — ${rows.length} untranslated string(s) ===`);
  for (const [t, meta] of rows.sort((a, b) => a[1].line - b[1].line)) {
    const es = looksSpanish(t);
    if (es) spanish++; else missing++;
    console.log(`  ${es ? "[ES-SOURCE]" : "[MISSING]  "} L${meta.line} [${meta.kind}] ${JSON.stringify(t)}`);
  }
}
console.log(`\n${missing} string(s) missing from I18N_ES · ${spanish} Spanish-hardcoded string(s) in source.`);
if (missing + spanish > 0) {
  console.log("Add English source text + an entry in I18N_ES (src/i18n.js), or use tr(en, es) for JS-side strings.");
  process.exit(1);
}
console.log("i18n coverage OK ✓");
