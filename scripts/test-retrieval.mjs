#!/usr/bin/env node
// Tests de la capa de recuperación del agente (lib/guideParse.mjs +
// lib/retrieval.mjs). Puro: no toca la base ni la red.
//
//   node scripts/test-retrieval.mjs
import { htmlToText, parseGuide, approxTokens, GUIDE_TOKEN_BUDGET } from "../lib/guideParse.mjs";
import { findSection, getGuide, guideIndex, guideLang, guideSections, renderIndex, selectGuide } from "../lib/retrieval.mjs";

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`✗ ${name}\n   esperado: ${JSON.stringify(want)}\n   obtenido: ${JSON.stringify(got)}`); }
  else console.log(`✓ ${name}`);
};

// ── HTML → texto ─────────────────────────────────────────────────────────────
// Los mockups de UI son adorno visual; si se colaran, el modelo respondería
// citando pedazos de maqueta en vez de la explicación real.
eq("descarta los mockups de UI",
  htmlToText(`<p>Antes</p><!-- static-mock --><div>BOTÓN FALSO</div><!-- /static-mock --><p>Después</p>`),
  "Antes\nDespués");
eq("descarta estilos y scripts",
  htmlToText(`<style>.a{color:red}</style><script>alert(1)</script><p>Hola</p>`), "Hola");
eq("conserva la jerarquía de encabezados",
  htmlToText(`<h2>Título</h2><p>Cuerpo</p>`), "## Título\nCuerpo");
eq("separa un encabezado del párrafo anterior",
  htmlToText(`<p>Antes</p><h2>Título</h2>`), "Antes\n\n## Título");
eq("conserva las listas",
  htmlToText(`<ul><li>uno</li><li>dos</li></ul>`), "- uno\n- dos");
eq("decodifica entidades",
  htmlToText(`<p>Brokers &amp; Drivers &mdash; 30&nbsp;d&iacute;as &rarr; ya</p>`).replace(/\s+/g, " "),
  "Brokers & Drivers — 30 días → ya");
eq("decodifica el resto de las letras acentuadas",
  htmlToText(`<p>&Ntilde;o&ntilde;o &uuml;ber gar&ccedil;on caf&egrave;</p>`), "Ñoño über garçon cafè");
eq("una entidad desconocida se deja como está",
  htmlToText(`<p>&noexiste; fin</p>`), "&noexiste; fin");
eq("decodifica entidades numéricas", htmlToText(`<p>&#8594;&#x2713;</p>`), "→✓");
eq("no deja tags sueltos", /<[^>]+>/.test(htmlToText(`<p><span class="x">a</span></p>`)), false);

// ── Parseo de secciones ──────────────────────────────────────────────────────
const HTML = `
<!-- section:uno --><h2>Primera</h2><p>Cuerpo uno</p><!-- /section:uno -->
<p>fuera de toda sección</p>
<!-- section:dos --><h2>Segunda</h2><p>Cuerpo dos</p><!-- /section:dos -->`;
eq("toma solo lo que está entre marcadores", parseGuide(HTML).map((s) => s.id), ["uno", "dos"]);
eq("el título sale del primer encabezado", parseGuide(HTML)[0].title, "Primera");
eq("sin encabezado, el título es el id",
  parseGuide(`<!-- section:x --><p>solo texto</p><!-- /section:x -->`)[0].title, "x");
eq("descarta secciones vacías",
  parseGuide(`<!-- section:v --><!-- static-mock --><b>x</b><!-- /static-mock --><!-- /section:v -->`).length, 0);
eq("sin marcadores no devuelve nada", parseGuide(`<p>plano</p>`).length, 0);

// ── Selección ────────────────────────────────────────────────────────────────
const SECS = [
  { id: "menu", title: "2 El menú", text: "## 2 El menú\nLas secciones de la izquierda." },
  { id: "brokers,drivers", title: "6 Brokers & Drivers", text: "## 6 Brokers & Drivers\nLista de brokers." },
];

eq("por debajo del presupuesto devuelve la guía entera",
  selectGuide(SECS).includes("Lista de brokers.") && selectGuide(SECS).includes("Las secciones de la izquierda."), true);
// El corte a índice es lo que hace que la guía pueda crecer sin tocar el prompt.
eq("por encima del presupuesto devuelve el índice",
  selectGuide(SECS, { budget: 1 }).includes("- menu: 2 El menú")
  && !selectGuide(SECS, { budget: 1 }).includes("Lista de brokers."), true);
eq("una sección pedida se devuelve sola",
  selectGuide(SECS, { section: "menu" }).includes("Lista de brokers."), false);
eq("guía vacía degrada con un mensaje, no rompe",
  selectGuide([]).includes("no está disponible"), true);
eq("una sección inexistente devuelve el índice, no un error",
  selectGuide(SECS, { section: "zzz" }).includes("- menu: 2 El menú"), true);

eq("encuentra por id exacto", findSection(SECS, "menu")?.id, "menu");
eq("ignora mayúsculas y acentos", findSection(SECS, "MENÚ")?.id, "menu");
eq("encuentra una mitad de un id compuesto", findSection(SECS, "drivers")?.id, "brokers,drivers");
eq("encuentra por título", findSection(SECS, "Brokers & Drivers")?.id, "brokers,drivers");
eq("no inventa una sección", findSection(SECS, "settlements"), null);
eq("una búsqueda vacía no matchea nada", findSection(SECS, "  "), null);
eq("índice vacío se dice, no se finge", renderIndex([]), "(la guía no está disponible)");

// ── Idioma ───────────────────────────────────────────────────────────────────
eq("en → en", guideLang("en"), "en");
eq("en-US → en", guideLang("en-US"), "en");
eq("es → es", guideLang("es"), "es");
eq("cualquier otra cosa cae a es", guideLang(undefined), "es");

// ── El corpus real generado ──────────────────────────────────────────────────
// Si estos fallan, lo más probable es que falte correr `npm run guide:index`.
for (const lang of ["es", "en"]) {
  const secs = guideSections(lang);
  eq(`la guía ${lang} tiene secciones`, secs.length > 0, true);
  eq(`la guía ${lang} no trae HTML`, secs.some((s) => /<[a-z][^>]*>/i.test(s.text)), false);
  eq(`la guía ${lang} entra en el presupuesto`,
    approxTokens(secs.map((s) => s.text).join("\n")) <= GUIDE_TOKEN_BUDGET, true);
  eq(`la guía ${lang} se sirve entera`, getGuide({ lang }).startsWith("GUÍA DEL CRM (completa)"), true);
}
eq("los dos idiomas cubren las mismas secciones",
  guideSections("es").map((s) => s.id), guideSections("en").map((s) => s.id));
eq("el índice del prompt lista dispatching", guideIndex("es").includes("- dispatching:"), true);
// El índice va en el system prompt, que se manda con cache_control: tiene que
// ser estable entre llamadas o se pierde el cache.
eq("el índice es estable", guideIndex("es"), guideIndex("es"));

console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodo verde");
process.exit(failed ? 1 : 0);
