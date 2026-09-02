# Puesta a punto del agente de ElevenLabs

> **DESENCHUFADO (widget).** El globito de ElevenLabs se sacó del CRM: se
> borró `src/elevenlabsAgent.jsx` y su montaje en `src/App.jsx`, así que ya no
> se carga su script de terceros ni aparece la burbuja. Volverlo a poner es
> revertir ese commit.
>
> La **puerta server-to-server sigue en el código** (`x-agent-secret` en
> `api/agent-hub.mjs`) porque no cuesta nada mientras nadie la llame, y falla
> cerrada sin configuración. Para cerrarla del todo, borrá `VOICE_AGENT_SECRET`
> de Vercel: sin eso, cualquier llamada con `x-agent-secret` recibe un 503.

Checklist para dejarlo andando. El detalle de por qué cada cosa es así está en
[`elevenlabs-agent.md`](./elevenlabs-agent.md); esto es la secuencia.

Estado de partida (lo que ya está hecho): el widget es el segundo globito del
CRM, la puerta server-to-server existe y `crm_lookup` está bien configurada del
lado de ElevenLabs.

---

## Paso 1 — Env vars en Vercel

Settings → Environment Variables. **Sin** prefijo `VITE_`: son de servidor.

| Variable | Valor |
|---|---|
| `VOICE_AGENT_SECRET` | `openssl rand -hex 32` |
| `VOICE_AGENT_ACTOR_EMAIL` | el email de un usuario del CRM |

El agente hereda **exactamente** los permisos de ese usuario. Conviene crear uno
dedicado (`agente-voz@noborders.com`) en vez de reusar el tuyo: así sus cambios
se distinguen en Trash/History y revocarlo es desactivar ese usuario. Si querés
que solo consulte, dale permisos de `view` y nada más.

**Redeployá después de agregarlas** — Vercel no las inyecta en un build que ya
existe.

Verificá que la puerta abre:

```bash
# 401 esperado: secret incorrecto
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://noborders-storage-manager-mu.vercel.app/api/agent-hub \
  -H 'content-type: application/json' -H 'x-agent-secret: mal' \
  -d '{"action":"voice_tool","name":"crm_lookup","input":{"query":"select 1"}}'

# 200 esperado: secret correcto
curl -s -X POST \
  https://noborders-storage-manager-mu.vercel.app/api/agent-hub \
  -H 'content-type: application/json' -H "x-agent-secret: $VOICE_AGENT_SECRET" \
  -d '{"action":"voice_tool","name":"crm_lookup","input":{"query":"select count(*) from trucks where deleted_at is null"},"conversation_id":"prueba"}'
```

Un **503** significa que falta una de las dos variables, o que el redeploy no
salió. Un **401**, que el secret del header no es el de Vercel.

---

## Paso 2 — Las otras cuatro tools

Ya tenés `crm_lookup`. Las otras cuatro son **la misma tool** con dos cambios:
la constante `name` y el `input`. Duplicá `crm_lookup` y editá esos dos campos —
URL, headers y `conversation_id` quedan idénticos.

| `name` (Constant Value) | `input` (LLM Prompt) | Description para el LLM |
|---|---|---|
| `crm_ask` | `question: string` | Preguntas que no salen de un solo SELECT: deuda real de un job, settlements, cómo funciona la empresa. Más lento que crm_lookup. |
| `crm_plan` | `request: string` | Propone un cambio. NO escribe nada: devuelve un plan para leer en voz alta. |
| `crm_confirm` | *(sin `input`)* | Ejecuta el plan ya leído. Solo después de un "sí" hablado. |
| `crm_cancel` | *(sin `input`)* | Descarta el plan pendiente. |

En las cinco, `conversation_id` va como **Dynamic Variable →
`system__conversation_id`**. Es lo que hace que el `crm_confirm` encuentre el
plan que propuso `crm_plan`: si falta, todas las conversaciones comparten la
misma cola y un "sí" puede ejecutar el plan de otra llamada en paralelo.

`crm_confirm` y `crm_cancel` no llevan `input` — el body es solo `action`,
`name` y `conversation_id`.

---

## Paso 3 — Los bloques que faltan en el prompt

El agente propio recibe el esquema y el directorio inyectados en cada sesión.
El de ElevenLabs recibe el prompt una sola vez, al guardarlo, así que hay que
pegárselos.

```bash
SUPABASE_SERVICE_ROLE_KEY=... npm run agent:prompt
```

Sin checkout local, la misma consulta desde Supabase → SQL Editor:

```sql
select table_name,
       string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as cols
from information_schema.columns
where table_schema = 'public'
  and table_name not like 'chat_%'
  and table_name not in ('wa_conversations','action_log','brief_snapshots')
group by table_name
order by table_name;
```

Hay que volver a correrlo y repegar cuando cambie el esquema o se agreguen
brokers/trucks/drivers que quieras que resuelva sin consultar.

### La fecha

El prompt actual **no tiene fecha**, así que "¿qué entregas hay esta semana?" no
tiene contra qué resolverse. Buscá en el desplegable de Dynamic Variable (el
mismo donde encontraste `system__conversation_id`) una de fecha/hora y usala. Si
no hay, dejá la fecha fija que imprime el script y refrescala cada tanto.

---

## Paso 4 — El prompt corregido

Sobre el que ya tenés, agregar los tres bloques y dos reglas. Queda así:

```text
You are the voice of the operations assistant of "No Borders Moving", a US moving & storage company. The team talks to you while driving, loading a truck or walking through a warehouse — you are on a phone speaker, hands are busy, and nobody can read a screen.

TODAY: {{FECHA}} (timezone America/New_York).

HOW TO SPEAK:
[…dejá tu bloque tal cual, está completo…]

LATENCY & FILLERS:
[…dejá tu bloque tal cual…]
- The directory below is already loaded. NEVER run a query to turn a broker, driver, truck, trip or storage name into an id — read it off the list.

CRM DIRECTORY (ids ready to use — do NOT look these up):
{{SALIDA DE npm run agent:prompt}}

DATABASE (PostgreSQL, table: columns):
{{SALIDA DE npm run agent:prompt}}

DOMAIN RULES:
[…dejá tu bloque tal cual…]

CHANGING DATA (CRITICAL WORKFLOW):
[…dejá tu bloque tal cual…]

GENERAL:
[…dejá tu bloque tal cual, y agregá…]
- Never say you can't do something in the CRM. Either do it, or say exactly what is missing: a piece of data, or a permission you don't have.
- A tool answer starting with DENIED or ERROR is information, not a dead end: it says what went wrong. If it names a table that doesn't exist, use the one it suggests. Never repeat the same failing call twice.
```

Las dos reglas nuevas del final importan: sin ellas, ante un error el agente
contesta "hubo un problema, lo intento de nuevo" y repite la misma llamada
fallida — que es exactamente lo que pasó en la conversación que falló.

---

## Paso 5 — Probarlo

Por orden, cada uno prueba una capa distinta:

1. **"¿Cuántos trucks hay?"** → `crm_lookup`. Prueba secret, profile y SQL.
2. **"¿Qué entregas hay esta semana?"** → prueba que tenga la fecha.
3. **"¿Cuánto debe el job 1201?"** → `crm_ask` (deuda real, no un balance crudo).
4. **"El camión 3 está saliendo de Ocala"** → `crm_plan`. Tiene que leer el plan
   y esperar. **No** tiene que escribir nada todavía.
5. **"Sí"** → `crm_confirm`. Verificá que el cambio aparezca en Trash/History
   a nombre del usuario del Paso 1.

Si el 5 no encuentra el plan, el problema es `conversation_id`: no está llegando
igual en `crm_plan` y `crm_confirm`.

---

## Errores y qué significan

| Respuesta | Causa |
|---|---|
| `503` | Falta `VOICE_AGENT_SECRET` o `VOICE_AGENT_ACTOR_EMAIL`, o no redeployaste |
| `503` con "no existe en profiles" | El email no corresponde a ningún usuario del CRM |
| `403` | El usuario del agente está desactivado |
| `401` | El secret del header no coincide con el de Vercel |
| `400` + `valid_tools` | El `name` no es una de las cinco tools |
| `DENIED: la tabla "X" no existe` | Nombre de tabla inventado; la respuesta sugiere la real |
| `DENIED: no tenés permiso` | La tabla existe pero el usuario del Paso 1 no la puede ver |
