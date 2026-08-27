// La capa de recuperación del agente: de dónde sale el contexto que NO está en
// el esquema de la base.
//
// El agente ya recupera datos estructurados con SQL (herramienta `sql` →
// agent_query), y para plata, fechas y agregados eso le gana a cualquier índice
// vectorial: los embeddings buscan por parecido semántico, no saben sumar ni
// filtrar por fecha. Lo que SQL no alcanza es el texto libre, y de eso se ocupa
// este módulo:
//
//   guide  — la guía de uso del CRM ("¿cómo cargo un extra?", "¿qué es FADD?")
//   search — texto libre de la base: descripciones de claims, notas de jobs,
//            comentarios de pagos y gastos, paradas de trips…
//
// Ver docs/rag.md para el porqué del diseño y el camino a pgvector.
import { admin } from "./clients.mjs";
import { canRead } from "./acl.mjs";
import { GUIDE } from "./guideText.mjs";
import { GUIDE_TOKEN_BUDGET, approxTokens } from "./guideParse.mjs";
import { DEFAULT_MAX_ROWS, HARD_MAX_ROWS, MIN_QUERY_CHARS } from "./textCorpus.mjs";

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


// ── Texto libre del CRM ──────────────────────────────────────────────────────
// El RPC search_crm_text (scripts/setup-text-search.mjs) corre con service role
// y NO filtra por permisos: devuelve todo lo que matchea. El filtro vive acá, en
// JS, con la misma semántica que checkSqlAccess() usa para la herramienta sql:
//
//   * quien está identificado en el CRM ve exactamente lo que su rol le permite;
//   * quien NO está identificado (Telegram sin vincular) conserva lectura — su
//     puerta de entrada es la whitelist del canal, no el rol.
//
// Las filas que el perfil no puede ver se descartan en silencio: decir "hay 3
// resultados que no podés ver" ya filtra la existencia del dato.
export const visibleToProfile = (profile, table) => !profile || canRead(profile, table);

const isoDay = (v) => (v ? String(v).slice(0, 10) : "");

export function formatHits(hits) {
  return hits.map((h) => {
    const head = [
      `${h.source_table} #${h.row_id}`,
      h.job_number ? `job ${h.job_number}` : null,
      h.label || null,
      isoDay(h.created_at) || null,
    ].filter(Boolean).join(" · ");
    return `[${head}] ${String(h.body || "").replace(/\s+/g, " ").trim()}`;
  }).join("\n");
}

// -> texto listo para devolver como tool_result.
export async function searchCrmText({ query, profile = null, limit = DEFAULT_MAX_ROWS } = {}) {
  const q = String(query ?? "").trim();
  if (q.length < MIN_QUERY_CHARS) return `La búsqueda necesita al menos ${MIN_QUERY_CHARS} caracteres.`;
  if (!admin) return "(la búsqueda de texto no está disponible en este entorno)";

  const max = Math.min(Math.max(Number(limit) || DEFAULT_MAX_ROWS, 1), HARD_MAX_ROWS);
  const { data, error } = await admin.rpc("search_crm_text", { q, max_rows: max });
  if (error) {
    return `ERROR: la búsqueda de texto no está disponible: ${error.message} (¿corriste scripts/setup-text-search.mjs?)`;
  }

  const hits = (data || []).filter((h) => visibleToProfile(profile, h.source_table));
  if (!hits.length) return `Sin resultados de texto libre para "${q}".`;
  return `RESULTADOS DE TEXTO LIBRE para "${q}" (tabla #id · job · etiqueta · fecha):\n${formatHits(hits)}`;
}

// ── Memoria de conversaciones ────────────────────────────────────────────────
// handleIncoming recorta wa_conversations.history a los últimos turnos, así que
// lo viejo se perdía. Ahora cada turno se archiva en agent_memory y se puede
// recuperar después.
//
// El ranking corre en JS y no en Postgres: el conjunto es chico (los turnos de
// una persona), y así el mismo algoritmo que el SQL —cobertura de términos, no
// similitud de la frase entera— queda en una función pura y testeable. La
// diferencia con search_crm_text es que acá no hay trigramas: la tolerancia a
// plurales y conjugaciones se consigue comparando prefijos de palabra.
export const MEMORY_SCAN = 500;   // turnos recientes que se traen para rankear
export const MEMORY_HITS = 12;    // turnos que vuelven al modelo
export const MEMORY_KEEP_DAYS = 180;

export const normalizeText = (s) => String(s ?? "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export const queryTerms = (q) => normalizeText(q).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

// Un término matchea si aparece como prefijo de alguna palabra del texto (o al
// revés): así "espejo" encuentra "espejos" y "roto" encuentra "rotos", sin
// arrastrar un stemmer.
const hasTerm = (words, term) => words.some((w) => w.startsWith(term) || term.startsWith(w));

// Mismo criterio de puntaje que search_crm_text: la frase exacta manda, y si no,
// gana el que cubre más términos de la consulta.
export function rankByTerms(query, items, { limit = MEMORY_HITS } = {}) {
  const needle = normalizeText(query).trim();
  const terms = queryTerms(query);
  if (needle.length < MIN_QUERY_CHARS) return [];

  return items
    .map((item, i) => {
      const norm = normalizeText(item.text);
      const words = norm.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      if (norm.includes(needle)) return { item, i, score: 1 };
      if (!terms.length) return null;
      const hits = terms.filter((t) => hasTerm(words, t)).length;
      return hits ? { item, i, score: hits / terms.length } : null;
    })
    .filter(Boolean)
    // Empate ⇒ gana lo más reciente: items viene ordenado del más nuevo al más
    // viejo, así que alcanza con desempatar por posición.
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.item);
}

// Archiva los dos turnos del intercambio. Best-effort a propósito: que la
// memoria falle no puede costarle la respuesta al usuario.
export async function rememberTurns(convoKey, userEmail, turns) {
  if (!admin || !convoKey) return;
  const rows = (turns || [])
    .filter((t) => t && String(t.text || "").trim())
    .map((t) => ({
      convo_key: convoKey,
      user_email: userEmail || null,
      role: t.role === "assistant" ? "assistant" : "user",
      text: String(t.text).slice(0, 4000),
    }));
  if (!rows.length) return;
  try { await admin.from("agent_memory").insert(rows); }
  catch (e) { console.error("agent_memory insert:", e?.message || e); }
}

// La misma persona escribe por app, Telegram y voz: cuando está identificada se
// busca por su email, para que la memoria cruce canales. Sin identificar, queda
// acotada al canal — nunca se mezclan dos personas.
export async function searchMemory({ query, convoKey, userEmail = null, limit = MEMORY_HITS } = {}) {
  const q = String(query ?? "").trim();
  if (q.length < MIN_QUERY_CHARS) return `La búsqueda necesita al menos ${MIN_QUERY_CHARS} caracteres.`;
  if (!admin) return "(la memoria no está disponible en este entorno)";

  let sel = admin.from("agent_memory").select("role, text, created_at").order("created_at", { ascending: false }).limit(MEMORY_SCAN);
  sel = userEmail ? sel.eq("user_email", userEmail) : sel.eq("convo_key", convoKey);

  const { data, error } = await sel;
  if (error) {
    return `ERROR: la memoria no está disponible: ${error.message} (¿corriste scripts/setup-agent-memory.mjs?)`;
  }

  const hits = rankByTerms(q, data || [], { limit });
  if (!hits.length) return `No encontré nada en conversaciones anteriores sobre "${q}".`;
  const lines = hits.map((h) => `[${isoDay(h.created_at)} · ${h.role === "assistant" ? "vos" : "él/ella"}] ${String(h.text).replace(/\s+/g, " ").trim()}`);
  return `CONVERSACIONES ANTERIORES sobre "${q}" (de la más relevante a la menos):\n${lines.join("\n")}`;
}

// Se llama desde el cron diario (api/agent-hub.mjs GET): el plan free de
// Supabase son 500 MB y esta tabla crece con cada mensaje.
export async function pruneMemory(days = MEMORY_KEEP_DAYS) {
  if (!admin) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await admin.from("agent_memory").delete().lt("created_at", cutoff).select("id");
  if (error) { console.error("agent_memory prune:", error.message); return 0; }
  return (data || []).length;
}
