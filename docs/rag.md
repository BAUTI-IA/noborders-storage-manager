# RAG en el CRM — qué recupera el agente y por qué

RAG (*Retrieval-Augmented Generation*, "generación aumentada por recuperación")
es una idea simple: **antes de que el modelo responda, un paso de búsqueda trae
los pedacitos de información relevantes y se los pega al prompt**. Tres etapas:

1. **Indexar** — preparar el material para poder buscarlo.
2. **Recuperar** — dada la pregunta, traer lo que corresponde.
3. **Generar** — mandarle eso al modelo como contexto.

La versión que todo el mundo tiene en la cabeza usa *embeddings*: se parte cada
documento en trozos, se guarda un vector de ~1500 números que codifica el
significado de cada uno, y ante una pregunta se traen los k trozos más parecidos
por similitud coseno. **Eso es una implementación de RAG, no la definición.** El
paso 2 puede ser cualquier cosa que encuentre lo correcto.

Este documento explica qué recupera el agente del CRM, por qué está hecho como
está, y cuándo convendría cambiarlo.

## Lo que ya había: recuperación por SQL

`lib/agent.mjs` hacía RAG desde el primer día:

| Pieza | Qué recupera |
|---|---|
| `getDbSchema()` | el esquema vivo de Postgres, desde `information_schema` |
| `getReferenceData()` | brokers, drivers, trucks, trips abiertos y storages como `id=nombre` |
| herramienta `sql` → RPC `agent_query` | cualquier SELECT de solo lectura, hasta 200 filas |
| `lib/brief.mjs` `collectBriefData()` | cinco queries en paralelo y las cuentas hechas en JS |

Todo eso viaja en el system prompt con `cache_control: ephemeral`, así que no se
re-factura en cada turno del loop.

## Por qué los datos del CRM **no** llevan embeddings

Los embeddings buscan por **parecido semántico**. No saben sumar, ni filtrar por
fecha, ni contar. Las preguntas reales del CRM son:

> ¿Cuánto me debe el broker Full Value? · ¿Qué entregas hay esta semana? ·
> ¿Qué camiones están en ruta?

Eso es `select sum(...) where ... group by ...`. Un índice vectorial devolvería
"los 8 jobs cuyo texto más se parece a la frase", que puede perfectamente **no
incluir** el que importa — y encima el modelo tendría que sumar a mano, que lo
hace mal. Para números, fechas, filtros y agregados, SQL gana siempre.

**Regla práctica: si podés escribir un `where`, no uses un vector.**

## Lo que sí necesitaba recuperación: el texto libre

Tres huecos, tres soluciones distintas. Todas viven en `lib/retrieval.mjs`.

### 1. La guía del CRM — herramienta `guide`

El agente sabía *operar* el CRM pero no *explicarlo*: "¿cómo cargo un extra?" no
tenía respuesta.

- **Corpus**: `docs/guia-crm.html` y `docs/crm-guide-en.html`, las guías vivas
  que el bot de `.github/workflows/weekly-guide.yml` actualiza cada lunes. Vienen
  delimitadas por marcadores `<!-- section:ID -->`, que son la unidad natural de
  chunk. El `GUIA-CRM.md` de la raíz quedó huérfano cuando entró ese pipeline: no
  se indexa, para no responder con documentación vieja.
- **Indexado**: `scripts/build-guide-index.mjs` genera `lib/guideText.mjs`, un
  módulo JS **comiteado**. No se lee el HTML con `fs` en runtime porque el
  bundler de Vercel no traza archivos de datos sueltos del repo de forma
  confiable: un `readFileSync` que anda en local se rompe en la lambda.
- **Recuperación**: **ninguna**. La guía entera son ~2.100 tokens por idioma, así
  que la herramienta la devuelve completa.

> **La decisión más importante de todo esto fue no construir un índice.**
> A 2.100 tokens, partir en chunks y rankearlos cuesta más código, más modos de
> fallar y peor precisión que traer todo. Saber cuándo *no* hace falta RAG
> vectorial es la mitad de saber usarlo.

`selectGuide()` igual sabe servir una sección sola, y si el corpus supera
`GUIDE_TOKEN_BUDGET` (8.000 tokens) pasa solo a devolver el índice para que el
modelo pida la sección que necesita. El día que la guía crezca, no hay que tocar
ni la herramienta ni el prompt.

### 2. Notas y descripciones de la base — herramienta `search`

`claims.description`, `storage_jobs.notes`, comentarios de pagos y gastos,
paradas de trips… texto que `sql` solo encontraba con un `ilike` afortunado.

- **Índice**: ninguno. `public.search_crm_text` (creada por
  `scripts/setup-text-search.mjs` a partir del catálogo de `lib/textCorpus.mjs`)
  une las columnas narrativas de 20 tablas y las escanea con `pg_trgm` +
  `unaccent`. Con tablas de cientos de filas, un seq scan tarda milisegundos.
  Sin índices GIN además porque `unaccent` no es `IMMUTABLE` y no entra en una
  expresión de índice sin envolverla en una función propia.
- **Ranking: cobertura de términos, no similitud de la frase.** Esta es la parte
  que hay que entender. `word_similarity('espejo roto', '…el espejo del living
  llegó roto…')` mide el mejor **tramo continuo**, así que se queda en "espejo" y
  **empata** con una fila que solo dice "espejo". Contando cuántos términos de la
  consulta aparecen, el que los tiene todos sube al primer puesto — que es el que
  la persona estaba buscando. (Medido: 0.88 contra 0.53.)
- **Tolerancias**: acentos (`unaccent`), plurales y conjugaciones
  (`word_similarity` por término, umbral 0.6), y piso de 3 caracteres — con 1 o 2
  el `LIKE` de la frase matchea casi todo el corpus y devuelve ruido con score 1.

### 3. Memoria de conversaciones — `search` con scope `memory`

`handleIncoming` recorta el historial a los últimos ~10 turnos: lo anterior se
descartaba. Ahora cada turno se archiva en `public.agent_memory`
(`scripts/setup-agent-memory.mjs`).

El ranking corre **en JS** (`rankByTerms`), no en Postgres: el conjunto es chico
—los turnos de una persona— y así el mismo criterio que el SQL queda en una
función pura y testeable. Sin trigramas, la tolerancia a plurales sale de
comparar prefijos de palabra en los dos sentidos.

## Seguridad: dónde vive el filtro de permisos

`search_crm_text` es `security definer` y el cliente de Supabase usa el service
role, que **saltea RLS**. Entonces el filtro por permisos vive en JS
(`visibleToProfile` en `lib/retrieval.mjs`, sobre `canRead` de `lib/acl.mjs`),
con la misma semántica que `checkSqlAccess` usa para la herramienta `sql`:

- quien está identificado en el CRM ve exactamente lo que su rol le permite;
- quien **no** lo está (Telegram sin vincular) conserva lectura — su puerta de
  entrada es la whitelist del canal, no el rol.

Las filas que el perfil no puede ver se descartan **en silencio**: decir "hay 3
resultados que no podés ver" ya filtra la existencia del dato.

`scripts/test-retrieval.mjs` verifica que toda tabla del catálogo esté en
`TABLE_ACL`. Si alguna no lo estuviera, `canRead` la descartaría para *todos* y
la búsqueda mentiría por omisión sin que nadie se entere.

Fuera del corpus a propósito: los chats del equipo y las sugerencias
(privacidad), el estado interno del agente, y `bank_transactions` — la única
tabla grande, cuyo `raw_description` son líneas de resumen bancario ya
categorizadas por IA.

## Cuándo sí pasar a pgvector

No hoy. Los umbrales que lo justificarían:

- **La guía supera ~20.000 tokens** y las preguntas empiezan a fallar porque el
  modelo se pierde en el texto completo. Paso previo más barato: recuperación por
  sección, que ya está implementada y se activa sola con el presupuesto.
- **Miles de descripciones de claims o notas**, y la búsqueda por términos falla
  por **sinónimos** ("rajado" vs "quebrado" vs "roto") o por el cruce **es/en**
  ("mirror" no encuentra "espejo"). Ese es el caso donde los embeddings ganan de
  verdad: es lo único que la coincidencia léxica no puede resolver.

Si llega ese día, el camino es corto y no tira nada de lo que hay:

1. `create extension vector;` en Supabase (disponible también en el plan free).
2. Tabla `text_chunks (source_table, row_id, chunk, embedding vector(1024))`.
3. Un job que embeba lo nuevo (Voyage o similar) — no hace falta reindexar todo:
   basta con lo que cambió desde la última corrida.
4. Buscar con el operador de distancia coseno `<=>` y **fusionar** con lo que ya
   devuelve `search_crm_text`. Híbrido léxico + vectorial le gana a cualquiera de
   los dos solos: el léxico clava los nombres propios y los números, el vectorial
   los sinónimos.
5. `lib/retrieval.mjs` ya tiene el ranking aislado; el cambio no toca ni las
   herramientas ni el prompt del agente.

## Cómo probarlo

Los tests puros no tocan la base:

```
node scripts/test-retrieval.mjs
```

Para validar el SQL de verdad, sin tocar producción, alcanza con un Postgres
local: crear tablas mínimas con las columnas que declara `lib/textCorpus.mjs`,
correr `buildSearchSql()` contra esa base, insertar unas filas de prueba y
consultar `search_crm_text('espejo roto')`. Conviene verificar tres cosas: que
una fila con `deleted_at` **no** aparezca, que la que contiene todos los términos
salga primera, y que una consulta de `'%'` no devuelva todo el corpus.

## Migraciones

```
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-text-search.mjs
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-agent-memory.mjs
```

La guía se regenera sola en el workflow semanal; a mano es `npm run guide:index`.
