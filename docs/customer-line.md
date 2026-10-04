# Customer Line — la línea de clientes (agente de ElevenLabs)

Un agente de voz para **clientes con un job en curso**: "¿dónde están mis
cosas?", "¿cuánto debo?", "¿puedo pasar la entrega al 14?", "¿cuánto sale el
storage?". Hoy esas llamadas las atiende dispatch. Este documento es el lado
servidor: el endpoint con las tools del agente y por qué está armado así.

> No confundir con el agente de ElevenLabs del **equipo**
> ([`elevenlabs-agent.md`](./elevenlabs-agent.md)), que entra por
> `x-agent-secret`, corre como un usuario del CRM y puede leer y escribir todo
> lo que ese usuario puede. Esta línea no comparte nada con él.

## Por qué está armado así

**Mínimo privilegio por diseño, no por configuración.** Detrás de esta puerta
no hay LLM, ni SQL libre, ni usuario del CRM. Hay tres operaciones fijas que
como mucho ven **un único job**: el que el que llama demostró que es suyo. Si
alguien consigue `CUSTOMER_LINE_SECRET`, accede a lo mismo que ya sabría
cualquiera que tenga el número de job y el ZIP, no al CRM.

**La verificación vive en el servidor.** `verify_and_get_job` guarda el job
verificado en `customer_line_sessions`, asociado al `conversation_id`. Ese dato
lo completa ElevenLabs (`system__conversation_id`); el modelo nunca lo escribe.
`request_change` y `request_callback` **no reciben número de job**: siempre
trabajan sobre el job que se verificó en esa llamada. Así no hay forma de
convencer al modelo de que lea o modifique un job ajeno.

**No se puede averiguar qué jobs existen.** "El job no existe" y "el ZIP no
coincide" dan exactamente la misma respuesta. Hay dos límites:

- 3 intentos fallidos por llamada.
- 10 por número de job en 24 horas, sumando todas las llamadas. Este límite
  cuenta **el número que dijo el que llama**, exista o no. Si contara solo los
  jobs reales, el bloqueo mismo revelaría cuáles existen.

**Plan → confirm en el servidor.** `request_change` funciona en dos pasos:

1. Con `confirmed=false` guarda el pedido y devuelve un `readback` para leerle
   al cliente.
2. Con `confirmed=true` graba **la copia guardada**, no los argumentos que
   vengan con la confirmación.

Lo que queda escrito es exactamente lo que el cliente escuchó y aprobó. Un
read-back de más de 15 minutos ya no se puede confirmar. Un doble "sí"
devuelve la misma referencia en vez de crear un segundo pedido.

**Nunca modifica el job.** Los pedidos van a `customer_requests` y dispatch se
entera por Telegram. Los aprueba un humano.

**El saldo es el mismo número que ve dispatch.** `jobBalance` replica
`jobOutstanding` (`src/App.jsx:6533`):

`max(0, pickup + delivery + bol balance − cobrado) + extras abiertos`

"Cobrado" es lo mayor entre `bol_collected` y los pagos `job` recibidos. Si el
agente dijera otro monto, el cliente llegaría a la entrega con un número
distinto al del driver, que es justo la discusión en la puerta que esta línea
busca evitar.

**La ubicación del camión se da solo a nivel ciudad.** Se informa únicamente
si el job está arriba de un camión, el trip está `in_transit` y la posición
tiene menos de 36 horas. Sale de `trucks.last_location`, que llega en vivo de
Motive/Verizon, y se reduce a "Richmond, VA". Lo que no se puede reducir a
"Ciudad, ST" no se dice.

**Cada respuesta trae `instruction`.** Es una indicación en lenguaje natural
para el modelo sobre qué hacer después. Así un error se convierte en la frase
correcta para el cliente y no en un reintento en loop. Los resultados de
negocio (no verificado, bloqueado, falta un dato) vuelven como 200 con
`ok:false` y un código `error`. Si se cae la base, también vuelve un 200 con
algo que decir, porque el modelo está en medio de una llamada y necesita su
próxima frase, no un stack trace.

**No es un archivo nuevo en `api/`.** La carpeta ya tiene las 12 funciones que
permite el plan Hobby de Vercel. La línea es la acción `customer_line` de
`api/agent-hub.mjs`, y un rewrite en `vercel.json` le da la URL
`/api/customer-line`. Se rutea antes del chequeo de `ANTHROPIC_API_KEY`
porque no usa ningún modelo.

## Puesta en marcha

### 1. Migración

```bash
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-customer-line.mjs
```

También se puede pegar `scripts/setup-customer-line.sql` en el SQL Editor de
Supabase. Crea tres tablas:

| Tabla | Qué guarda | Quién la ve |
|---|---|---|
| `customer_line_sessions` | Una fila por llamada: job verificado, intentos fallidos, read-back pendiente | Solo service role (RLS sin políticas) |
| `customer_line_events` | Auditoría: una fila por resultado de cada tool | Solo service role |
| `customer_requests` | Pedidos de cambio y callbacks | `dispatching` / `jobs` (mismas políticas que genera `setup-rls`) |

`customer_requests` también figura en `lib/acl.mjs`, así que el agente interno
del CRM puede consultarla ("¿qué pidieron hoy por la línea?") y marcar pedidos
como resueltos. Las otras dos están en `AGENT_DENY_TABLES`.

Corré esta migración **antes** de volver a correr `setup-rls.mjs`: ese script
le aplica políticas a todas las tablas de `TABLE_ACL` y falla si
`customer_requests` todavía no existe.

### 2. Variables en Vercel

Van sin prefijo `VITE_`. **Redeployá después de cargarlas.**

| Variable | Qué es |
|---|---|
| `CUSTOMER_LINE_SECRET` | `openssl rand -hex 32`. Sin esta variable, la puerta contesta 503. |
| `CUSTOMER_LINE_TELEGRAM_CHAT_ID` | Chat que recibe los pedidos. Conviene que sea uno propio, para que las pruebas no le lleguen al grupo del equipo. Sin esta variable, los pedidos igual se guardan y la respuesta dice `team_notified: false`. |
| `TELEGRAM_BOT_TOKEN` | Ya existe: es el mismo bot del brief. |

### 3. Probar la puerta

```bash
URL=https://noborders-storage-manager-mu.vercel.app/api/customer-line

# 401: secret incorrecto
curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL -H 'content-type: application/json' \
  -H 'x-customer-line-secret: mal' -d '{"tool":"verify_and_get_job","conversation_id":"prueba"}'

# 200: verifica el job de prueba
curl -s -X POST $URL -H 'content-type: application/json' -H "x-customer-line-secret: $CUSTOMER_LINE_SECRET" \
  -d '{"tool":"verify_and_get_job","conversation_id":"prueba-1","job_number":"DEMO-7001","zip":"07102"}'
```

Cada llamada deja una línea `customer_line <tool> <resultado> <ms>` en los logs
de Vercel.

## Configuración en ElevenLabs

Las tres tools comparten esta configuración:

- **Tipo:** webhook (server tool), `POST`.
- **URL:** `https://noborders-storage-manager-mu.vercel.app/api/customer-line`
- **Header:** `x-customer-line-secret`, tomado de un **secret del workspace**.
  Nunca como texto literal en la tool.
- **Body:**
  - `tool`: constante con el nombre de la tool.
  - `conversation_id`: dynamic variable `system__conversation_id`.
- Todo lo demás lo completa el LLM, según la tabla de cada tool.

Las descripciones van en inglés porque las lee el modelo.

### `verify_and_get_job`

> Verify the caller owns a job and get its customer-safe details: status, pickup
> window, first available delivery date, scheduled delivery, where the truck is
> (city level), balance due, storage. Call it before sharing ANY job
> information. Needs the job number plus the ZIP code of the pickup or delivery
> address, or the last 4 digits of the phone number on the job.

| Parámetro | Tipo | Descripción para el LLM |
|---|---|---|
| `job_number` | string | Job number as the caller says it, letters and digits only (e.g. "7001" or "DEMO7001"). |
| `zip` | string | 5-digit ZIP code of the pickup or delivery address. Empty if they gave phone digits instead. |
| `phone_last4` | string | Last 4 digits of the phone number on the job. Empty if they gave a ZIP. |

### `request_change`

> Log a change request for the VERIFIED job (delivery date, delivery address,
> pickup date, contact info, storage). It never changes the job: a coordinator
> reviews it and calls back. Two steps: first call with confirmed=false and read
> the returned readback to the caller; only after a clear yes, call again with
> confirmed=true.

| Parámetro | Tipo | Descripción para el LLM |
|---|---|---|
| `kind` | enum: `delivery_date`, `delivery_address`, `pickup_date`, `contact_info`, `storage`, `other` | What they want changed. |
| `details` | string | The request in one or two sentences, in the caller's words. |
| `preferred_date` | string | YYYY-MM-DD if they asked for a specific date, else empty. |
| `confirmed` | boolean | false to stage and get the readback; true only after the caller said yes to it. |

### `request_callback`

> Ask a human coordinator to call the customer back. Use it for refunds, damage
> claims, complaints, billing disputes, quotes, an angry caller, failed
> verification, or anything you can't resolve. Works without verification; then
> a callback phone number is required.

| Parámetro | Tipo | Descripción para el LLM |
|---|---|---|
| `topic` | enum: `quote`, `refund`, `damage_claim`, `complaint`, `billing`, `change_followup`, `delivery_issue`, `other` | What the call is about. |
| `reason` | string | One sentence for the coordinator. |
| `urgency` | enum: `normal`, `urgent` | `urgent` only for an active problem (delivery today, damage at the door, very upset caller). |
| `caller_name` | string | Caller's name if given. |
| `best_time` | string | When to call, in their words. |
| `callback_phone` | string | Number to call back, if the caller is not verified or wants a different one. |
| `job_number` | string | Job number an UNVERIFIED caller mentions (stored as "claimed", not trusted). |
| `caller_id` | dynamic variable `system__caller_id` | Solo en llamadas telefónicas: se usa como teléfono de callback si el cliente no dicta otro. |

## Job de prueba (para el demo)

Cargalo desde el CRM. Así el demo no expone datos de clientes reales.

| Campo | Valor |
|---|---|
| Job # | `DEMO-7001` |
| Customer | `Doe, Jane` |
| Client phone | `973-555-0142` (los 555-01xx son ficticios) |
| Pickup | Miami, FL `33101` |
| Delivery | Newark, NJ `07102` |
| Status | `picked_up` |
| FADD | dos o tres días después de la grabación |
| Delivery date | vacío: así el agente tiene que decir "todavía no está agendada" |
| Pickup balance / delivery balance | $1,000 / $2,340, con un pago `job` **recibido** de $1,000 → saldo $2,340 |
| Trip | un trip de prueba en `in_transit`, con un camión de prueba |

**Ubicación del camión:** al camión de prueba hay que darle una posición menos
de 36 horas antes de grabar. Se le puede decir al agente del CRM: "el camión
DEMO está en Richmond, VA".

Se podría usar un camión real con GPS de Motive, pero el job de prueba
aparecería en el manifiesto del driver y en Live Load. Si se hace así, hay que
sacarlo del trip apenas termina la grabación.

**Opcional, para mostrar storage:** `DEMO-7002` en `in_storage`, warehouse
`Indiana`, billing activo a $250 por mes y un `storage_billing` pendiente ya
vencido.

## Gaps conocidos

- **El caller ID no verifica.** Se puede falsificar, así que solo se usa como
  teléfono para el callback.
- **El bloqueo por job tiene un costo.** Alguien que conoce un número de job
  puede bloquear la verificación de ese job por 24 horas. El cliente sigue
  teniendo el callback. Es preferible a dejar probar ZIPs sin límite.
- **Los pedidos no tienen pantalla en el CRM.** Hoy se ven por Telegram y en la
  tabla, y el agente interno los puede consultar. Una bandeja en Dispatch sería
  el próximo paso, y ahí sí hay que pasar por i18n.
- **El agente no cambia nada por su cuenta.** Es una decisión, no una carencia:
  cambiar la fecha de entrega afecta el trip, al driver y a otros clientes.

## Archivos

- `lib/customerLineData.mjs`: las reglas puras. Verificación, saldo, snapshot
  seguro, ubicación a nivel ciudad y el mensaje para el equipo.
- `lib/customerLine.mjs`: acceso a datos (inyectable) y las tres tools.
- `api/agent-hub.mjs`: `customerLineAuth()` y `customerLine()`.
- `vercel.json`: el rewrite `/api/customer-line`.
- `scripts/setup-customer-line.sql` / `.mjs`: la migración.
- `scripts/test-customer-line.mjs` (`npm run test:customer-line`): sin red ni
  base de datos. Cubre la lista blanca de campos, la falta de oráculo, los
  bloqueos, el plan → confirm, la fórmula del saldo y la puerta HTTP.
