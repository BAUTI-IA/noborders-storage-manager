// La capa de recuperación del agente: de dónde sale el contexto que NO está en
// el esquema de la base.
//
// El agente ya recupera datos estructurados con SQL (herramienta `sql` →
// agent_query), y para plata, fechas y agregados eso le gana a cualquier índice
// vectorial: los embeddings buscan por parecido semántico, no saben sumar ni
// filtrar por fecha. Lo que SQL no alcanza es el texto libre, y de eso se ocupa
// este módulo:
//
//   guide — la guía de uso del CRM ("¿cómo cargo un extra?", "¿qué es FADD?")
//
// Ver docs/rag.md para el porqué del diseño y el camino a pgvector.
import { GUIDE } from "./guideText.mjs";
import { GUIDE_TOKEN_BUDGET, approxTokens } from "./guideParse.mjs";

// ── Guía del CRM ─────────────────────────────────────────────────────────────
// El corpus entero son ~2.100 tokens por idioma, así que la recuperación óptima
// es traerlo completo: partirlo en chunks y rankearlos costaría más código y más
// modos de fallar de los que ahorra. Las funciones igual saben servir una
// sección sola, y selectGuide() cae automáticamente a "índice + pedí una
// sección" si la guía crece por encima del presupuesto: el día que eso pase no
// hay que tocar ni la herramienta ni el prompt.

export const guideLang = (lang) => (String(lang ?? "").toLowerCase().startsWith("en") ? "en" : "es");

export const guideSections = (lang) => GUIDE[guideLang(lang)] || [];

// Normalización para emparejar lo que pida el modelo con un id o un título:
// sin acentos, sin mayúsculas, sin signos.
const norm = (s) => String(s ?? "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

export const renderIndex = (secs) =>
  (secs.length ? secs.map((s) => `- ${s.id}: ${s.title}`).join("\n") : "(la guía no está disponible)");

// El modelo puede pedir "billing", "Brokers & Drivers" o "menú": las tres tienen
// que caer bien. Se prueba id exacto → id compuesto ("brokers,drivers") →
// substring → título.
export function findSection(secs, wanted) {
  const q = norm(wanted);
  if (!q) return null;
  return secs.find((s) => norm(s.id) === q)
    || secs.find((s) => norm(s.id).split(" ").includes(q))
    || secs.find((s) => norm(s.id).includes(q) || q.includes(norm(s.id)))
    || secs.find((s) => norm(s.title).includes(q))
    || null;
}

// Núcleo puro: recibe las secciones y devuelve el texto listo para tool_result.
export function selectGuide(secs, { section = null, budget = GUIDE_TOKEN_BUDGET } = {}) {
  if (!secs.length) return "(la guía del CRM no está disponible en este entorno)";

  if (section) {
    const hit = findSection(secs, section);
    return hit
      ? `GUÍA DEL CRM — sección "${hit.id}":\n\n${hit.text}`
      : `No existe una sección "${section}". Secciones disponibles:\n${renderIndex(secs)}`;
  }

  if (approxTokens(secs.map((s) => s.text).join("\n")) <= budget) {
    return `GUÍA DEL CRM (completa):\n\n${secs.map((s) => `### ${s.id}\n${s.text}`).join("\n\n---\n\n")}`;
  }
  // La guía creció: en vez de inundar el contexto se devuelve el índice y el
  // modelo pide la sección que necesita en una segunda llamada.
  return `GUÍA DEL CRM — índice de secciones. Volvé a llamar a \`guide\` con la que necesites:\n${renderIndex(secs)}`;
}

export const guideIndex = (lang) => renderIndex(guideSections(lang));

export const getGuide = ({ lang = "es", section = null } = {}) =>
  selectGuide(guideSections(lang), { section });
