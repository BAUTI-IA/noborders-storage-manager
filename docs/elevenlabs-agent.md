# Agente de ElevenLabs (server-to-server)

> **DESENCHUFADO (widget).** El globito de ElevenLabs se sacó del CRM: se
> borró `src/elevenlabsAgent.jsx` y su montaje en `src/App.jsx`, así que ya no
> se carga su script de terceros ni aparece la burbuja. Volverlo a poner es
> revertir ese commit.
>
> La **puerta server-to-server sigue en el código** (`x-agent-secret` en
> `api/agent-hub.mjs`) porque no cuesta nada mientras nadie la llame, y falla
> cerrada sin configuración. Para cerrarla del todo, borrá `VOICE_AGENT_SECRET`
> de Vercel: sin eso, cualquier llamada con `x-agent-secret` recibe un 503.

> Para dejarlo andando paso a paso, ver
> [`elevenlabs-setup.md`](./elevenlabs-setup.md). Esto es el porqué.

El widget de ElevenLabs es el segundo globito del CRM (`src/elevenlabsAgent.jsx`),
al lado del agente propio. Este documento es sobre la otra mitad: cómo sus
**tools** llegan a la base sin abrirle la puerta a cualquiera.

## El problema

Los canales que ya existían mandan siempre un usuario adelante:

| Canal | Quién es el caller | Cómo se prueba |
|---|---|---|
| Widget del CRM (chat y voz) | la persona logueada | JWT de Supabase en `Authorization` |
| Telegram / WhatsApp | el `profiles` vinculado | `telegram_user_id` / `whatsapp_phone` |

Las tools de ElevenLabs no entran en esa tabla: las ejecutan **los servidores de
ElevenLabs**, no el navegador. No hay sesión, así que no hay JWT que mandar.

## La solución

Un secret compartido en el header `x-agent-secret`, que se chequea en
`serverToServerAuth()` (`api/agent-hub.mjs`) antes que nada.

Lo importante es lo que el secret **no** hace: no reparte autoridad. Autentica
al caller, y de ahí en adelante el pedido corre **como un usuario real del CRM**
— el de `VOICE_AGENT_ACTOR_EMAIL`. O sea:

- `lib/acl.mjs` filtra cada lectura y cada escritura igual que si esa persona
  estuviera en la app.
- El plan se sigue leyendo y confirmando antes de escribir nada.
- `action_log` guarda un nombre real, así que se puede deshacer desde
  **Trash / History** como cualquier otro cambio.

El agente de ElevenLabs nunca puede hacer más que ese usuario. Si querés que
solo consulte, dale un profile con permisos de `view` y listo — o poné
`AGENT_WRITES_ENABLED=false` y queda en solo lectura todo el sistema.

### Por qué no alcanza con saltear la validación de usuario

Es tentador escribir "si el secret es válido, seguí de largo". No alcanza, y
falla para el lado peligroso: `checkSqlAccess()` (`lib/agentWrite.mjs`) solo
aplica el permiso por tabla **cuando tiene un profile**:

```js
if (profile && !canRead(profile, table)) return `no tenés permiso para ver "${table}"`;
```

Sin profile esa línea no hace nada, y el caller lee el CRM entero: todos los
jobs, los balances, los pagos, las transacciones bancarias. Por eso la puerta
server-to-server **resuelve un profile o no abre**.

### Y por qué no hay secret por defecto

Un secret con fallback en el repo no es un secret: cualquiera que lea el código
lo tiene. Si falta `VOICE_AGENT_SECRET` o `VOICE_AGENT_ACTOR_EMAIL`, la puerta
contesta 503 y no entra nadie. Falla cerrada.

La comparación va sobre digests SHA-256 con `timingSafeEqual`, no sobre los
strings: `timingSafeEqual` tira excepción cuando los largos difieren, y esa
excepción filtraría el largo del secret.

## Configuración

| Variable | Default | Qué hace |
|---|---|---|
| `VOICE_AGENT_SECRET` | — | El secret compartido. Sin esto la puerta no abre. Generalo con `openssl rand -hex 32`. |
| `VOICE_AGENT_ACTOR_EMAIL` | — | Email del `profiles` cuyos permisos hereda el agente. Sin esto la puerta no abre. |

Los dos van en Vercel (Settings → Environment Variables). **No** en el front:
son de servidor, no llevan prefijo `VITE_`.

Conviene crear un usuario dedicado en el CRM (por ejemplo
`agente-voz@noborders.com`) en vez de reusar el de una persona: así los cambios
del agente se distinguen de los de un humano en el historial, y revocarlo es
desactivar ese usuario.

### Del lado de ElevenLabs

Cada server tool apunta a `POST https://<tu-dominio>/api/agent-hub` con el
header `x-agent-secret: <VOICE_AGENT_SECRET>` y un body:

```jsonc
{
  "action": "voice_tool",
  "name": "crm_lookup",              // crm_lookup | crm_ask | crm_plan | crm_confirm | crm_cancel
  "input": { "query": "select ..." },
  "conversation_id": "{{conversation_id}}"
}
```

El nombre de la tool se acepta en `name` (que es como lo manda ElevenLabs) o en
`tool` (como lo manda nuestro widget). Si mandás cualquier otra cosa, el 400 te
devuelve `valid_tools` con la lista, así el modelo puede corregir solo.

### La tabla de jobs se llama `storage_jobs`

El error más fácil de cometer, y el agente lo comete solo si no le diste el
esquema: **no existe una tabla `jobs`**. La de jobs es `storage_jobs` (un job
lógico son varias filas que comparten `job_number`). Otras que se confunden:

| Lo que el modelo escribe | Lo que existe |
|---|---|
| `jobs` | `storage_jobs` |
| `units`, `warehouses` | `storages` |
| `stops` | `trip_stops` (paradas que NO son jobs: nafta, balanza, service) |

Pedir una tabla inexistente ya no contesta "no tenés permiso" —contestaba eso, y
mandaba al agente a buscar un admin en vez de a corregir el nombre—: ahora dice
que no existe y sugiere las más parecidas.

Igual conviene pegarle el bloque `DATABASE` al system prompt del agente en
ElevenLabs, con el esquema real. Sale de `getDbSchema()` (`lib/agent.mjs`).

### Punto y coma

`agent_query` rechaza **cualquier** `;` — es como garantiza una sola sentencia.
Como los modelos lo ponen por costumbre, el server saca uno final si está
(`normalizeSql`). Eso no habilita dos sentencias: `select 1; drop ...` sigue
teniendo un `;` en el medio y se rechaza igual.

`conversation_id` importa: es lo que separa una conversación de otra. Un plan
propuesto en una llamada **no** tiene que poder confirmarse con el "sí" de otra
que está corriendo al mismo tiempo. Si no lo mandás, todas las conversaciones
comparten la misma cola de confirmación.

El catálogo de tools y el system prompt del agente de voz están en
`lib/voice.mjs` (`voiceTools()` y `buildVoiceInstructions()`).

### Lo que la puerta server-to-server no puede hacer

Dos acciones son solo de navegador y contestan 403:

- `link_code` — el código de vinculación de Telegram es de la persona logueada,
  no de una credencial compartida.
- `voice_token` — emite un `client_secret` de OpenAI Realtime para nuestro
  propio widget. ElevenLabs trae su propio stack de voz.

## Probarlo

```bash
node scripts/test-agent-auth.mjs   # la tabla de decisión de la puerta — sin red ni DB
```

Contra el deploy:

```bash
# 401: secret incorrecto
curl -s -X POST https://<tu-dominio>/api/agent-hub \
  -H 'content-type: application/json' -H 'x-agent-secret: cualquier-cosa' \
  -d '{"action":"voice_tool","tool":"crm_lookup","input":{"query":"select 1"}}'

# 200: secret correcto
curl -s -X POST https://<tu-dominio>/api/agent-hub \
  -H 'content-type: application/json' -H "x-agent-secret: $VOICE_AGENT_SECRET" \
  -d '{"action":"voice_tool","tool":"crm_lookup","input":{"query":"select count(*) from trucks where deleted_at is null"},"conversation_id":"prueba"}'
```

## Archivos

- `api/agent-hub.mjs` — `serverToServerAuth()` y el ruteo de las dos puertas.
- `scripts/test-agent-auth.mjs` — los tests de la puerta.
- `src/elevenlabsAgent.jsx` — el globito en el CRM.
- `lib/acl.mjs` — quién puede leer y escribir qué. Lo que hace que el secret no
  sea una llave maestra.
