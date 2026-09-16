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

```
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-pipeline.mjs
```

Crea `job_leads` y `pipeline_settings` con RLS por `public.has_perm('pipeline', …)`,
igual que el resto de las secciones. Es idempotente.

Después, en **Users**, dale permiso `pipeline` a quien corresponda.

### Parámetros (`pipeline_settings.settings`)

| Clave | Default | Qué hace |
|---|---|---|
| `holdReminderDays` | `2` | Día del recordatorio |
| `holdDecisionDays` | `7` | Día en que hay que decidir |
| `allowedEmailDomains` | `[]` | Dominios de brokers habilitados. **Vacío no acepta a nadie.** |
| `carriers` | `[]` | Carriers a los que se puede ofrecer un job |
| `maxLeadsPerSenderPerDay` | `40` | Tope de leads por mail por día |

```sql
update public.pipeline_settings set settings = jsonb_build_object(
  'holdReminderDays', 2,
  'holdDecisionDays', 7,
  'allowedEmailDomains', jsonb_build_array('allied.com', 'atlasvanlines.com'),
  'carriers', jsonb_build_array('Shawn')
) where id = 1;
```

---

## Canal de mail (opcional, se enchufa después)

El tablero funciona sin esto: **"+ New lead"** abre un textarea donde se pega el
mail y los campos salen solos. El canal automático sólo evita el copiar y pegar.

Elegí Cloudflare Email Routing y no leer Gmail desde el cron porque el cron es
diario: un mail podría tardar 24 h en entrar, y contra un reloj de 2 días eso se
come media ventana.

### 1. Variable en Vercel

- `PIPELINE_INBOUND_SECRET` — un string aleatorio. **Sin esta variable el endpoint
  responde 503**: no hay secreto por defecto.

### 2. Cloudflare Email Routing

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
5. Cargá los dominios de los brokers en `allowedEmailDomains` (ver arriba) — si no,
   todo se descarta.

Probar sin Cloudflare:

```
curl -X POST https://TU-APP.vercel.app/api/inbound-email \
  -H 'Content-Type: application/json' -H 'x-pipeline-secret: EL_SECRETO' \
  -d '{"from":"dispatch@allied.com","subject":"Job available",
       "text":"820 cu ft, pickup 7/25-7/26 Miami FL 33125, delivery Atlanta GA 30301, FADD 8/1, $3,200"}'
```

---

## Seguridad: el mail es entrada no confiable

Un mail de broker es texto de afuera que termina en un prompt. Las reglas son
duras y fallan cerradas:

- **Allowlist de dominios.** Sin dominios configurados no entra nada. Un remitente
  rechazado recibe `202` y nada más — el endpoint no le dice a internet qué
  dominios aceptamos.
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

## Tests

```
npm test                 # incluye scripts/test-pipeline-data.mjs
npm run i18n:check
```

`src/pipelineData.js` no importa nada, así que corre igual en el navegador, en
Node y dentro de una función de Vercel — el reloj, el ranking y la conversión
lead → job se testean sin red ni base.
