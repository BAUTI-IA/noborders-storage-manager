# Pipeline — de la recepción del job al despacho

El trabajo entra por mail, WhatsApp o a mano, se evalúa solo con el motor del Job
Calculator, se decide (aceptar / hold / rechazar / ofrecer a un carrier) y, si se
acepta, se convierte en un job normal del CRM.

Antes de esto un trabajo o ya era una fila de `storage_jobs` (o sea, ya aceptado)
o no existía en ningún lado: no había dónde vivir mientras todavía no se decidía.
Esa etapa es la que agrega el módulo.

---

## Las cuatro fases

| Fase | Qué pasa | Dónde |
|---|---|---|
| 1 · Recepción | El mail / mensaje se lee y se convierte en un **lead** | `lib/leads.mjs`, `lib/recipes.mjs` (`create_lead`) |
| 2 · Análisis | Se calculan millas, días-camión, break-even y el semáforo | `src/jobCalcData.js` (`evaluateJob`), `job_evaluations` |
| 3 · Decisión | Accept / Hold (2 y 7 días) / Reject / Offer | `src/pipeline.jsx`, `lib/brief.mjs` |
| 4 · Despacho | Sugerencias de trip con posición del camión, crew, días y P&L | `api/trip-suggestions.mjs` |

## Ordenar por contribución por día-camión

El tablero **no** ordena por precio ni por porcentaje de margen: ordena por
`contribution_per_truck_day`. El recurso escaso de la operación es el día de
camión, así que un job de $5.900 que ocupa un camión cinco días vale menos que uno
de $3.200 que lo ocupa dos y medio. Los dos números salen de `evaluateJob()`, la
misma función que usa la pantalla Job Calculator — el Pipeline nunca inventa uno.

## El reloj del HOLD

Poner un lead en hold escribe tres fechas:

- `hold_started_on` — hoy
- `remind_at` — **día 2**: el brief de la mañana lo recuerda
- `hold_until` — **día 7**: hay que decidir; pasado eso el lead queda `expired`

Los dos números viven en `pipeline_settings.settings` (jsonb), así que cambiarlos
—o partirlos por broker más adelante— no necesita otra migración.

El barrido corre dentro del cron que **ya existe** (`GET /api/agent-hub`, 12:00
UTC): `sweepHolds()` marca los recordatorios enviados, vence lo que pasó de fecha
y le devuelve los tres grupos a `lib/brief.mjs`, que los publica en el grupo de
Telegram. El plan Hobby de Vercel no permite otro cron, y tampoco hace falta.

---

## Instalación

Crea `job_leads` y `pipeline_settings` con RLS por `public.has_perm('pipeline', …)`,
igual que el resto de las secciones. Es idempotente: correrla dos veces no rompe nada.

**Opción A — sin instalar nada (la más rápida).** Supabase → SQL Editor → pegar
`scripts/setup-pipeline.sql` → Run.

**Opción B — desde el repo.**

```
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-pipeline.mjs
```

El token sale de https://supabase.com/dashboard/account/tokens (es de cuenta, no
la key del proyecto) y empieza con `sbp_`.

**Permisos.** `has_perm()` arranca con `is_admin()`, así que un admin ve la sección
apenas corre la migración, sin configurar nada. Para el resto del equipo, en
**Users** hay que tildar `pipeline` (view / create / edit) como con cualquier otra
sección.

### Parámetros (`pipeline_settings.settings`)

Se editan desde **Pipeline → ⚙ Settings** (sólo admin, que es lo que pide la RLS
de la tabla). No hace falta SQL.

| Clave | Default | Qué hace |
|---|---|---|
| `holdReminderDays` | `2` | Día del recordatorio |
| `holdDecisionDays` | `7` | Día en que hay que decidir |
| `acceptAllSenders` | `false` | Cualquier remitente puede crear leads (para el script de todo el inbox). Sólo `true` literal lo prende |
| `allowedEmailDomains` | `[]` | Quién puede mandarnos leads: dominios y/o direcciones enteras. **Vacío no acepta a nadie.** |
| `carriers` | `[]` | Carriers a los que se puede ofrecer un job |
| `maxLeadsPerSenderPerDay` | `40` | Tope de leads **por remitente** por día |
| `maxLeadsPerDay` | `200` | Tope de todos los remitentes juntos, por día |

`mergePipelineSettings()` limpia lo que se guarda: las listas pierden duplicados,
los topes tienen piso 1 y el global nunca queda por debajo del de un remitente.
Guardar desde la pantalla **mergea** sobre lo que hay, así que una clave que
agregue un deploy nuevo no se pierde si alguien guarda desde una pestaña vieja.

### Quién puede mandarnos leads (`allowedEmailDomains`)

Cada entrada es **un dominio entero** o **una dirección exacta**, y la diferencia
importa:

| Entrada | Deja entrar a | Cuándo usarla |
|---|---|---|
| `allied.com` | Cualquiera `@allied.com` y sus subdominios (`dispatch@mail.allied.com`) | El broker tiene dominio propio |
| `shawn@gmail.com` | Esa casilla y **nada más** | Quien escribe desde una cuenta personal |

`@Allied.com`, `ALLIED.com` y `https://allied.com/jobs` significan todos el
dominio. Una dirección entera **no** se recorta al dominio: si lo hiciera,
escribir `shawn@gmail.com` abriría el tablero a cualquiera con un Gmail. Por la
misma razón, un dominio público (`gmail.com`, `outlook.com`, `yahoo.com`… la
lista está en `PUBLIC_MAILBOX_DOMAINS`) **se rechaza como regla de dominio**: a
esos remitentes hay que nombrarlos dirección por dirección.

Por SQL, si hace falta, conviene mergear en vez de reemplazar:

```sql
update public.pipeline_settings
set settings = settings || jsonb_build_object(
      'allowedEmailDomains', jsonb_build_array('allied.com', 'atlasvanlines.com')
    )
where id = 1;
```

---

## Canal de mail (opcional, se enchufa después)

El tablero funciona sin esto: **"+ New lead"** abre un textarea donde se pega el
mail y los campos salen solos. El canal automático sólo evita el copiar y pegar.

Lo que **no** sirve es leer la casilla desde el cron diario de Vercel: un mail
podría tardar 24 h en entrar y contra un reloj de 2 días eso se come media
ventana. El canal tiene que empujar, no esperar al cron.

Cuál de los dos usar lo decide **dónde vive la casilla**, no el gusto:

| La casilla está en… | Camino | Por qué |
|---|---|---|
| Google Workspace / Gmail | **A — Apps Script** | No toca DNS. Cloudflare Email Routing se queda con el MX del dominio, así que apuntarlo ahí con Workspace activo corta el resto del mail de la empresa |
| No existe todavía, dominio en Cloudflare | **B — Email Routing** | Gratis y en tiempo real, sin casilla ni servidor |
| Workspace pero se quiere Cloudflare igual | B sobre un subdominio (`jobs@jobs.noborders.com`) | El MX del subdominio es propio; el dominio principal no se toca |

### 1. Variable en Vercel (los dos caminos)

- `PIPELINE_INBOUND_SECRET` — un string aleatorio (`openssl rand -hex 32`).
  **Sin esta variable el endpoint responde 503**: no hay secreto por defecto.
  Hay que hacer redeploy después de agregarla.

### 2.A Google Workspace — Apps Script

Hay dos modos, según qué llega a la casilla:

| Modo | Script | Allowlist |
|---|---|---|
| **Todo el inbox** — cada mail que entra es candidato a lead | `scripts/gmail-to-pipeline.gs` | **⚙ Settings → "Every email becomes a lead"** tildado |
| Sólo lo etiquetado `jobs` por un filtro de Gmail | el de abajo | dominios de brokers en Settings |

**Todo el inbox (lo recomendado para una casilla dedicada a jobs):**

1. En [script.google.com](https://script.google.com), **logueado con la casilla**
   (la cuenta de Workspace), proyecto nuevo → pegar `scripts/gmail-to-pipeline.gs`.
2. Completar `CRM_URL` y `SECRET` (el mismo `PIPELINE_INBOUND_SECRET` de Vercel).
3. Elegir `install` → **Run** una vez. Pide permiso de Gmail y crea el trigger
   de cada 5 minutos. Desde ese momento, todo mail nuevo del inbox se manda al CRM
   (`BACKFILL_HOURS` > 0 manda también las últimas N horas en la primera corrida).
4. En **Pipeline → ⚙ Settings** tildar **"Every email becomes a lead"**.

El script avanza un checkpoint por fecha (Script Properties): cada mail se manda
una vez, y si el CRM contesta error el checkpoint queda ahí y el próximo tick
reintenta. Los propios mails de la cuenta (respuestas) no se mandan.

**No todo mail es un job.** Con cualquier remitente habilitado, el extractor
decide además `is_job_offer`: newsletters, recibos y avisos de Google se
descartan con el motivo `not_a_job` y aparecen en **"Emails dropped today"**
(nada desaparece en silencio). Si uno era un job, se pega con **+ New lead**.
Los topes por remitente y por día siguen valiendo.

**Sólo lo etiquetado `jobs`:**

1. En la casilla, un filtro por broker (`from:@allied.com`) que aplique la
   etiqueta **`jobs`**.
2. En script.google.com **con esa cuenta**, proyecto nuevo:

```js
const CRM_URL = 'https://TU-APP.vercel.app/api/inbound-email';
const SECRET  = 'EL_SECRETO';   // el mismo de Vercel
const LABEL   = 'jobs';

function pushNewJobs() {
  const label = GmailApp.getUserLabelByName(LABEL);
  if (!label) return;
  const done = GmailApp.getUserLabelByName(LABEL + '/enviado')
            || GmailApp.createLabel(LABEL + '/enviado');

  for (const thread of label.getThreads(0, 20)) {
    let ok = true;
    for (const msg of thread.getMessages()) {
      const res = UrlFetchApp.fetch(CRM_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-pipeline-secret': SECRET },
        payload: JSON.stringify({
          from: msg.getFrom(),
          subject: msg.getSubject(),
          message_id: msg.getId(),
          text: msg.getPlainBody().slice(0, 40000),
        }),
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() >= 400) { console.error(res.getContentText()); ok = false; }
    }
    // Sólo se mueve de etiqueta si salió bien: si falló, el próximo tick reintenta.
    if (ok) { thread.removeLabel(label); thread.addLabel(done); }
  }
}
```

3. **Triggers** → `pushNewJobs` → Time-driven → Minutes timer → cada 5 minutos.

Reintentar no duplica: `message_id` se guarda en `source_ref` y `ingestEmail()`
devuelve el lead que ya existe.

### 2.B Cloudflare Email Routing

1. El dominio de la empresa tiene que estar en Cloudflare.
2. **Email → Email Routing → Email Workers**, creá un Worker con esto:

```js
export default {
  async email(message, env) {
    const chunks = [];
    for await (const c of message.raw) chunks.push(c);
    const raw = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    // El cuerpo va tal cual: el parseo y la contención viven del lado del CRM.
    await fetch(env.CRM_URL + "/api/inbound-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pipeline-secret": env.PIPELINE_SECRET },
      body: JSON.stringify({
        from: message.from,
        subject: message.headers.get("subject") || "",
        message_id: message.headers.get("message-id") || "",
        text: raw.slice(0, 40000),
      }),
    });
  },
};
```

3. Variables del Worker: `CRM_URL` (`https://TU-APP.vercel.app`) y `PIPELINE_SECRET`
   (el mismo valor que pusiste en Vercel).
4. **Email Routing → Routes**: mandá `jobs@tudominio.com` a ese Worker.
5. Cargá los remitentes habilitados en **⚙ Settings** (ver arriba) — si no, todo
   se descarta.

### 3. Probarlo sin esperar ningún mail

```
curl -X POST https://TU-APP.vercel.app/api/inbound-email \
  -H 'Content-Type: application/json' -H 'x-pipeline-secret: EL_SECRETO' \
  -d '{"from":"dispatch@allied.com","subject":"Job available",
       "text":"820 cu ft, pickup 7/25-7/26 Miami FL 33125, delivery Atlanta GA 30301, FADD 8/1, $3,200"}'
```

| Respuesta | Qué pasó |
|---|---|
| `{"ok":true,"lead_id":N}` | Entró. Está en el tablero con el semáforo calculado |
| `{"ok":true}` sin `lead_id` | Se descartó. El motivo sale en el tablero (ver abajo), no en la respuesta |
| `401` | El secreto no coincide con el de Vercel |
| `503` | Falta `PIPELINE_INBOUND_SECRET`, o faltó el redeploy |

### Qué se descartó y por qué

El webhook contesta `202` a todo el mundo para no ser un oráculo de qué dominios
aceptamos, lo cual también haría desaparecer sin rastro a un broker real que
todavía no está en la allowlist. Por eso cada descarte escribe una fila en
`action_log` (`entity = job_leads`, `action = dropped`), y el tablero muestra
arriba **"Hoy se descartaron N mails entrantes · Ver por qué"** con el remitente,
el asunto, el motivo y qué hacer al respecto. El historial completo está en
**Trash → History**.

Los motivos posibles están en `DROP_REASONS` (`src/pipelineData.js`):
`sender_not_allowed`, `rate_limited` (tope de ese remitente), `day_cap` (tope de
todos juntos), `no_sender` y `not_a_job` (el extractor leyó que no era una oferta).

---

## Seguridad: el mail es entrada no confiable

Un mail de broker es texto de afuera que termina en un prompt. Las reglas son
duras y fallan cerradas:

- **Allowlist de remitentes.** Sin nada configurado no entra nada. Un remitente
  rechazado recibe `202` y nada más — el endpoint no le dice a internet qué
  dominios aceptamos. Del lado de adentro sí queda registrado (ver arriba). Un
  dominio de correo público no se acepta como regla de dominio, así que una
  casilla personal habilitada nunca arrastra al resto del proveedor.
- **Dos topes diarios.** Uno por remitente (`maxLeadsPerSenderPerDay`, contado
  sobre `parsed->>sender`) y uno global de respaldo (`maxLeadsPerDay`). El que
  importa es el primero: contar todos los remitentes juntos, como se hacía antes,
  dejaba que un broker movido se comiera el presupuesto del día y tapara al resto.
- **Esquema cerrado.** El extractor sólo puede devolver los campos del schema, y el
  prompt le dice explícitamente que el cuerpo del mail es dato a parsear y que
  cualquier instrucción adentro se ignora.
- **El lead nace `new`.** Nunca se convierte solo en job. Aceptar es siempre un
  click de una persona en el formulario de job de siempre.
- **`raw_text` está fuera del alcance del agente.** Está en `AGENT_DENY_COLUMNS`
  (`lib/acl.mjs`) y se filtra del esquema que ve el agente de WhatsApp/Telegram, así
  que un mail no puede inyectarle texto por la puerta de atrás.
- **Topes.** 20.000 caracteres por mail, `maxLeadsPerSenderPerDay` leads por día, y
  el mismo `message-id` nunca crea dos leads.
- **Secreto compartido** comparado en tiempo constante, igual que el webhook de
  DocuSign.

---

## Dónde vive cada cosa (el tope de 12 funciones)

`api/` tiene exactamente 12 archivos y el plan Hobby de Vercel topea en 12 — está
documentado en `api/geocode.mjs`. Por eso el Pipeline no agrega ninguno:

| Acción | Endpoint | Cómo |
|---|---|---|
| Leer un mail pegado | `api/trip-suggestions.mjs` | `action: "lead_extract"` |
| Evaluar un lead | `api/trip-suggestions.mjs` | `action: "lead_evaluate"` |
| Ordenar la tanda | `api/trip-suggestions.mjs` | `action: "lead_rank"` |
| Sugerir trips | `api/trip-suggestions.mjs` | sin `action` — como siempre |
| Mail entrante | `api/agent-hub.mjs` | `action: "inbound_email"` + rewrite `/api/inbound-email` |
| Barrido del reloj | `api/agent-hub.mjs` | dentro del brief diario |

La lógica compartida vive en `lib/leads.mjs`, que no se despliega como función.

---

## Las millas vacías salen de donde está el camión

El Job Calculator mide el deadhead desde un ZIP base fijo de configuración, que
es lo único que puede hacer para un job a una semana vista. Pero un lead se
evalúa **ahora**, y la flota reporta dónde está: las millas vacías que importan
son las que tiene que manejar el camión que realmente tomaría el job.

El ELD da lat/lng y el modelo de costos habla en ZIPs, así que `lib/geo.mjs`
hace el geocoding inverso de la posición (Google si hay key, si no Nominatim
paceado a su política) y lo cachea para siempre en `geo_cache` con clave `rev:`.
Un coordenada redondeada a dos decimales — un kilómetro — así el cache sirve
aunque el GPS de un camión estacionado tiemble.

**Las dos piernas son asimétricas a propósito**, porque es lo que pasa de verdad:

| Pierna | Desde | Hasta |
|---|---|---|
| Ida | **donde está el camión ahora** | el pickup |
| Vuelta | el delivery | el ZIP base — el camión eventualmente vuelve |

`deadheadFor()` ya las tomaba por separado, así que los tres supuestos
(`roundTrip` / `oneWay` / `none`) siguen funcionando sin tocarlos.

Si el geocoding inverso falla o el camión no tiene posición, cae al ZIP base y
se comporta como antes. El detalle del lead dice **de dónde** se midieron, así
que no hay que suponerlo: cambia el veredicto.

**Limitación honesta:** es la posición al momento de evaluar. Para cuando el job
realmente salga el camión puede estar en otro lado — pero es la mejor
información que hay cuando hay que decidir, que es el momento que importa.

---

## Calibración automática de actuals

`job_evaluations` tenía desde la primera migración columnas para lo que un job
**realmente** costó, y `calibrate()` las convierte en settings corregidos. Pero se
cargaban a mano, así que no se cargaban nunca, y el modelo de costos sólo podía
envejecer. Todo lo que hacen falta ya estaba en el CRM.

`calibrateDelivered()` corre dentro del cron diario, sobre los jobs entregados en
los últimos 45 días cuyo lead todavía tiene la evaluación sin completar:

| Campo | De dónde sale |
|---|---|
| `actual_truck_days` | Días que el camión **se movió** según el GPS (`truck_pings`, vía `truckDays()` de `reportsData.js` — el mismo número que muestra Reports). Si el camión no tiene ELD, cae a fechas distintas de `driver_work_days`. |
| `actual_miles` | Suma de las millas de esos días |
| `actual_fuel` · `actual_tolls` · `actual_materials` | `expenses` de esa categoría, del trip o del job, dentro de la ventana |
| `actual_hotel_nights` | Fechas distintas con gasto de hotel (no hay columna de noches; es el proxy) |
| `actual_drivers` · `actual_trucks` | El trip y los `driver_ids` del job |
| `actual_helpers` | Queda `null` — helper no se registra como rol en ningún lado, así que `rowCrew()` cae a lo planificado |

**La ventana** es del `departure_date` del trip (o el pickup) hasta el `date_out`.
Nunca la vida entera del job: un job puede estar meses en storage y barrer todo
ese período metería gastos que no tienen nada que ver con el viaje.

### La trampa que esto evita

Un trip lleva varios jobs, pero la evaluación coteó cada uno **como si tuviera el
camión para él solo**. Imputarle a un job su tajada de un viaje compartido y
después promediarla le enseñaría al modelo que todo sale más barato de lo que
sale, y el sesgo iría siempre para el mismo lado.

Por eso un job que compartió viaje **igual registra sus actuals** —se ven en el
detalle del lead, prorrateados por pies cúbicos— pero con `actuals_shared = true`,
y `calibrate()` saltea esas filas. Sólo aprende de los jobs que corrieron solos,
que son lectura limpia. Es el mismo criterio con el que `calibrate()` ya filtraba
las filas "clean" para `cuFtPerHour`.

Si no hay nada medido —ni GPS ni nómina— no se escribe nada. Un actual inventado
es peor que ninguno.

---

## Modelos

| Para qué | Modelo | Variable para cambiarlo |
|---|---|---|
| Leer un mail y sacarle los campos | `claude-sonnet-5` | `PIPELINE_EXTRACT_MODEL` |
| Ordenar la tanda de leads | `claude-opus-5` | `PIPELINE_RANK_MODEL` |

El semáforo, el break-even y el $/día-camión **no pasan por ningún modelo**: son
`evaluateJob()` en `src/jobCalcData.js`, matemática determinística. Si se apaga la
API key el tablero sigue funcionando entero; sólo se caen el "pegar el mail" y el
botón de analizar la tanda.

La extracción queda en Sonnet 5 a propósito: es un parseo contra un esquema
cerrado, corre en cada lead, y Sonnet 5 sale menos de la mitad que Opus 5. Para
moverla alcanza con `PIPELINE_EXTRACT_MODEL=claude-opus-5` en Vercel — sin deploy.

**Opus 5 piensa por defecto** (en Opus 4.8, omitir `thinking` significaba no
pensar). Los tokens de razonamiento salen del mismo `max_tokens` que la respuesta,
así que cada llamada lo declara explícito y tiene presupuesto de sobra: si un día
las respuestas aparecen cortadas, ese es el primer lugar donde mirar.

---

## Tests

```
npm test                 # incluye scripts/test-pipeline-data.mjs
npm run i18n:check
```

`src/pipelineData.js` no importa nada, así que corre igual en el navegador, en
Node y dentro de una función de Vercel — el reloj, el ranking y la conversión
lead → job se testean sin red ni base.
