// Qué columnas de texto libre entran en la búsqueda del agente, y cómo se
// arma el SQL de public.search_crm_text a partir de eso.
//
// Una sola declaración, tres consumidores: scripts/setup-text-search.mjs genera
// la función de Postgres, lib/retrieval.mjs filtra los resultados por permisos,
// y scripts/test-retrieval.mjs verifica que toda tabla listada acá exista en
// TABLE_ACL — si no, sus filas se descartarían enteras y la búsqueda mentiría
// por omisión.
//
// Reglas para agregar una fuente:
//   * la tabla TIENE que estar en TABLE_ACL (lib/acl.mjs) y no en AGENT_DENY_TABLES;
//   * `soft` = si la tabla tiene deleted_at (ver SOFT_DELETE_TABLES);
//   * `text` son las columnas narrativas — no metas nombres ni enums, son ruido.
//
// Deliberadamente afuera: chat_messages y suggestions (privacidad del equipo),
// wa_conversations/action_log (internos del agente), y bank_transactions — la
// única tabla grande, cuyo raw_description son líneas de resumen bancario ya
// categorizadas por IA, ruido puro para esta búsqueda.
export const TEXT_SOURCES = [
  { table: "claims",               soft: true,  job: "job_number", label: "coalesce(client_name, incident_type)", text: ["incident_type", "description", "resolution_type"] },
  { table: "claim_notes",          soft: true,  job: null,         label: "'claim #' || claim_id",                text: ["note"] },
  { table: "storage_jobs",         soft: true,  job: "job_number", label: "customer",                             text: ["notes", "carrier_notes", "billing_notes", "bol_payment_notes"] },
  { table: "job_events",           soft: true,  job: null,         label: "event_type",                           text: ["notes"] },
  { table: "job_extras",           soft: true,  job: null,         label: "extra_type",                           text: ["description", "notes"] },
  { table: "payments",             soft: true,  job: null,         label: "concept",                              text: ["notes", "discount_reason", "cash_with_whom"] },
  { table: "expenses",             soft: true,  job: "job_number", label: "coalesce(vendor, category)",           text: ["notes", "vendor"] },
  { table: "trips",                soft: true,  job: null,         label: "trip_number",                          text: ["notes"] },
  { table: "trip_stops",           soft: true,  job: null,         label: "category",                             text: ["note", "address"] },
  { table: "closing_sheets",       soft: true,  job: null,         label: "closing_sheet_number",                 text: ["notes", "other_fees_description"] },
  { table: "equipment_items",      soft: true,  job: null,         label: "name",                                 text: ["notes"] },
  { table: "driver_adjustments",   soft: true,  job: "job_number", label: "kind",                                 text: ["reason"] },
  { table: "material_movements",   soft: true,  job: "job_number", label: "movement_type",                        text: ["notes"] },
  { table: "brokers",              soft: true,  job: null,         label: "name",                                 text: ["notes"] },
  { table: "drivers",              soft: true,  job: null,         label: "name",                                 text: ["notes"] },
  { table: "trucks",               soft: true,  job: null,         label: "coalesce(name, plate)",                text: ["notes"] },
  { table: "companies",            soft: true,  job: null,         label: "name",                                 text: ["notes"] },
  { table: "compliance_documents", soft: true,  job: null,         label: "document_name",                        text: ["notes"] },
  // Sin deleted_at (no están en SOFT_DELETE_TABLES): no lleva filtro de borrado.
  { table: "storage_billing",      soft: false, job: null,         label: "status",                               text: ["notes"] },
  { table: "trip_events",          soft: false, job: null,         label: "event_type",                           text: ["notes"] },
];

// Cuánto texto de cada fila vuelve al modelo. Suficiente para entender el
// hallazgo; si necesita el resto, ya tiene la tabla y el id para pedirlo con sql.
export const SNIPPET_CHARS = 600;
// Umbral de word_similarity. pg_trgm usa 0.6 por defecto, que para "espejo roto"
// dentro de un párrafo largo casi nunca dispara; 0.35 encuentra sin inundar.
export const WORD_SIMILARITY_MIN = 0.35;
// Umbral por término suelto: más alto, para tolerar plurales y conjugaciones
// ("espejos" ↔ "espejo") sin empezar a traer cualquier palabra parecida.
export const TERM_SIMILARITY_MIN = 0.6;
export const MIN_QUERY_CHARS = 3;
export const DEFAULT_MAX_ROWS = 30;
export const HARD_MAX_ROWS = 60;

// Una rama por fuente. Sin alias de tabla a propósito: cada rama consulta una
// sola tabla, así las expresiones de `label` y `text` se escriben como SQL
// normal y no hay que reescribirlas (un alias inyectado con regex se metía
// adentro de los literales: 'claim #' se volvía 't.claim #').
const branch = ({ table, soft, job, label, text }) => {
  const body = `concat_ws(' · ', ${text.join(", ")})`;
  return `  select '${table}'::text as source_table,
         id::bigint as row_id,
         ${job ? `${job}::text` : "null::text"} as job_number,
         nullif(btrim((${label})::text), '') as label,
         ${body} as body,
         created_at
    from public.${table}
   where ${soft ? "deleted_at is null and " : ""}btrim(${body}) <> ''`;
};

// La función corre como security definer y NO filtra por permisos: eso lo hace
// lib/retrieval.mjs en JS con canRead(), igual que checkSqlAccess() para la
// herramienta sql. El service role saltea RLS, así que el filtro vive en código.
// La función corre como security definer y NO filtra por permisos: eso lo hace
// lib/retrieval.mjs en JS con canRead(), igual que checkSqlAccess() para la
// herramienta sql. El service role saltea RLS, así que el filtro vive en código.
//
// Ranking por COBERTURA DE TÉRMINOS, no por similitud de la frase entera:
// word_similarity("espejo roto", "…el espejo del living llegó roto…") mide el
// mejor tramo continuo, así que se queda en "espejo" y empata con una fila que
// solo dice "espejo". Contar cuántos términos de la consulta aparecen sube al
// que los tiene todos, que es el que la persona estaba buscando.
const likeEscape = (expr) => `replace(replace(replace(${expr}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

export const buildSearchSql = () => `create extension if not exists pg_trgm;
create extension if not exists unaccent;

create or replace function public.search_crm_text(q text, max_rows int default ${DEFAULT_MAX_ROWS})
returns table (source_table text, row_id bigint, job_number text, label text, body text, created_at timestamptz, score real)
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  with needle as (
    select unaccent(lower(btrim(q))) as n,
           -- q viaja como parámetro (nada de inyección), pero un '%' suelto del
           -- usuario haría matchear todo: se escapan los comodines de LIKE.
           ${likeEscape("unaccent(lower(btrim(q)))")} as lk,
           -- Términos de 3+ letras: descarta la mayoría de las palabras vacías
           -- sin necesidad de mantener una lista de stopwords por idioma.
           array(
             select t from unnest(regexp_split_to_array(unaccent(lower(btrim(q))), '[^a-z0-9]+')) t
              where length(t) >= 3
           ) as terms
  ),
  corpus as (
${TEXT_SOURCES.map(branch).join("\n  union all\n")}
  ),
  scored as (
    select c.source_table, c.row_id, c.job_number, c.label, c.body, c.created_at,
           n.n as needle, n.lk as lk, n.terms as terms,
           unaccent(lower(c.body)) as norm
      from corpus c cross join needle n
     -- Piso de 3 caracteres: con 1 o 2, el LIKE de la frase matchea casi todo
     -- el corpus y la búsqueda devuelve ruido con score 1.0.
     where length(n.n) >= ${MIN_QUERY_CHARS}
  ),
  ranked as (
    select s.*,
           (s.norm like '%' || s.lk || '%') as phrase_hit,
           word_similarity(s.needle, s.norm) as phrase_score,
           (select count(*) from unnest(s.terms) t
             where s.norm like '%' || ${likeEscape("t")} || '%'
                or word_similarity(t, s.norm) >= ${TERM_SIMILARITY_MIN}) as term_hits
      from scored s
  )
  select source_table, row_id, job_number, label,
         left(body, ${SNIPPET_CHARS}) as body,
         created_at,
         (case when phrase_hit then 1.0
               else 0.7 * (term_hits::real / greatest(cardinality(terms), 1))
                  + 0.3 * phrase_score
          end)::real as score
    from ranked
   where phrase_hit
      or (cardinality(terms) > 0 and term_hits = cardinality(terms))
      or phrase_score >= ${WORD_SIMILARITY_MIN}
   order by score desc, created_at desc nulls last
   limit least(coalesce(max_rows, ${DEFAULT_MAX_ROWS}), ${HARD_MAX_ROWS})
$fn$;

revoke all on function public.search_crm_text(text, int) from public;
revoke all on function public.search_crm_text(text, int) from anon;
revoke all on function public.search_crm_text(text, int) from authenticated;`;
