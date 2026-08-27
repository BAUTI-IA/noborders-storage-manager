# Agente de IA por WhatsApp / Telegram

Le escribís al agente por WhatsApp en lenguaje natural y él carga, actualiza o consulta jobs del CRM. Ejemplos:

- **Crear**: "Tenemos un job del cliente García, pickup el 25 de julio en Miami FL, entrega en Orlando, FADD 1 de agosto, estimate 4500"
- **Actualizar**: "El job 1234 se entrega el viernes" / "Poné el job 1234 en depósito"
- **Explicar el CRM**: "¿cómo cargo un extra?", "¿qué significa el FADD naranja?" — lee la guía de uso (`docs/guia-crm.html`), no adivina.
- **Buscar en texto libre**: "el job donde el cliente se quejó de un espejo roto", "¿qué gasto menciona la puerta del warehouse?" — busca en notas, descripciones de claims y comentarios, respetando los permisos de quien pregunta.
- **Acordarse**: "¿qué te dije la semana pasada sobre el camión 3?" — más allá de los últimos turnos, acotado a la persona que pregunta.
- **Consultar cualquier dato del CRM** (operativo, financiero, flota, usuarios): "¿Qué entregas hay esta semana?", "¿Cuánto facturamos este mes?", "¿Qué camiones están en ruta?", "¿Cuánto le debemos al broker X?". El agente investiga la base con SQL de solo lectura (función `agent_query`, creada por `scripts/setup-agent-query.mjs`: solo SELECT, transacción read-only, máx. 200 filas; los chats internos y el estado del agente quedan excluidos).

Antes de escribir en el CRM siempre te muestra lo que entendió y espera tu **"sí"** (o "no" para cancelar). Si algo está mal, respondé con la corrección ("no, la entrega es el sábado") y re-propone.

**Audios**: también entiende notas de voz (Telegram y WhatsApp). Las transcribe con OpenAI Whisper (requiere `OPENAI_API_KEY` en Vercel; ~US$0.006/min), responde "🎤 Escuché: ..." con la transcripción y sigue el flujo normal.

## Qué puede hacer (agente ejecutivo)

El agente no está limitado a jobs: puede operar sobre **todo el CRM** — armar y editar trips, imputar pagos, cargar gastos, marcar facturas de storage, registrar eventos de jobs, asignar drivers, ubicar camiones en el mapa de live load, y crear/editar/borrar en el resto de las tablas (brokers, drivers, trucks, claims, equipos, materiales…).

Ejemplos que ya funcionan:
- **Trip / live load**: "Armá un trip con los jobs 1201 y 1198, camión 3, driver Pedro, sale el jueves" → crea el trip en `loading` y engancha los jobs en orden. "El camión 3 está en Ocala, FL" → `set_truck_location` geocodifica la dirección y lo pone en el mapa.
- **Pago**: "Imputá $1,800 en Zelle al job 1201" → método digital ⇒ `received` + `banked`, reparte primero el balance del job, después los extras más viejos, el resto a cuenta, y sincroniza `bol_collected`.

Cómo funciona por dentro (`lib/agent.mjs`): un loop con cuatro herramientas — `sql` (solo lectura, para investigar y resolver nombres → ids), `search` (texto libre: notas, descripciones de claims, comentarios de pagos y gastos, y con scope `memory` también lo que se habló en conversaciones anteriores), `guide` (la guía de uso del CRM, para preguntas de "¿cómo se hace X?") y `stage_plan` (propone un plan de operaciones). **Nada se escribe al proponer**: el plan se valida, se muestra en texto y solo se ejecuta con un "sí" explícito. La capa de recuperación está explicada en [docs/rag.md](rag.md).

Garantías de seguridad:
- **Permisos por usuario**: cada escritura se chequea contra el rol/permisos del usuario en el CRM (`lib/acl.mjs`, mismo mapa que las políticas RLS). El agente nunca puede hacer más que la persona que se lo pide.
- **Validación doble** (al proponer y antes de ejecutar): tablas y columnas existentes, FKs vivas, valores de enum válidos, ids explícitos para update/delete, máximo 10 pasos y 50 filas por paso.
- **Borrado siempre recuperable** (`deleted_at`); las tablas sin papelera no se pueden borrar.
- **Auditoría**: todo queda en `action_log` con el email del usuario, igual que las acciones de la app → aparece en **Trash / History** y se puede deshacer.
- **Recetas de dominio** (`lib/recipes.mjs`) para las operaciones con reglas finas (trips, pagos con imputación, gastos), para que el agente produzca exactamente los mismos datos que la app.
- **Tablas privadas**: `profiles`, chats del equipo, `action_log` y el estado del agente no se pueden leer ni escribir.
- **Kill switch**: `AGENT_WRITES_ENABLED=false` deja al agente en modo solo lectura.

### Vincular la cuenta (necesario para escribir desde Telegram/WhatsApp)
En el CRM, el chat del agente tiene el botón **"Vincular Telegram"** → da un código de 6 dígitos (15 min). El empleado le manda al bot `/link 123456` y queda atado a su usuario del CRM. Sin vincular, por Telegram solo puede consultar.

Migraciones necesarias: `scripts/setup-agent-query.mjs` (lectura), `scripts/setup-agent-writes.mjs` (columnas de vinculación en `profiles`), `scripts/setup-text-search.mjs` (búsqueda de texto libre) y `scripts/setup-agent-memory.mjs` (memoria de conversaciones).
Tests de permisos: `node scripts/test-agent-acl.mjs`.

## Cómo funciona

Twilio recibe tu mensaje de WhatsApp y lo reenvía a `api/whatsapp-webhook.mjs` (Vercel). Ahí Claude extrae la intención y los campos, el código valida todo y responde por el mismo canal. El borrador pendiente de confirmación se guarda en la tabla `wa_conversations` (una fila por teléfono).

## Setup (una sola vez)

1. **Tabla de estado**:
   ```
   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-whatsapp-agent.mjs
   ```
2. **Variables de entorno en Vercel** (además de las existentes `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `APP_URL`):
   - `TWILIO_AUTH_TOKEN` — Auth Token de la cuenta Twilio (verifica la firma de cada request; sin él, la verificación se saltea — solo para dev).
   - `TWILIO_ACCOUNT_SID` — Account SID de Twilio (empieza con `AC...`). Necesario para enviar las respuestas por la API REST.
   - `TWILIO_WHATSAPP_FROM` — número emisor con prefijo, ej. sandbox: `whatsapp:+14155238886`.
   - `WHATSAPP_ALLOWED_NUMBERS` — números habilitados en E.164, separados por coma: `+5491122334455,+13055551234`. Cualquier otro número se ignora en silencio. Poner `*` habilita a cualquier número (no recomendado: cualquiera que descubra el número podría cargar datos al CRM).
3. **Twilio**: creá una cuenta en twilio.com → Messaging → *Try it out* → *Send a WhatsApp message* (sandbox). Uníte al sandbox desde tu teléfono (mandando el código "join xxx-yyy" al número del sandbox) y configurá **"When a message comes in"** = `https://TU-APP.vercel.app/api/whatsapp-webhook` (POST).
4. Guardá el número del sandbox como contacto y escribile.

Cuando el flujo esté probado, se puede pasar del sandbox a un número de WhatsApp propio comprado en Twilio (requiere aprobar un perfil de WhatsApp Business con Meta; Twilio guía el trámite). El webhook es el mismo.

## Canal Telegram (alternativa sin Twilio/Meta)

El mismo agente atiende por Telegram (`api/telegram-webhook.mjs`; el cerebro compartido vive en `lib/agent.mjs`). Setup:

1. En Telegram, hablarle a **@BotFather** → `/newbot` → nombre y username del bot → copia el **token** (`123456:ABC...`).
2. Variables en Vercel: `TELEGRAM_BOT_TOKEN` (el token), `TELEGRAM_WEBHOOK_SECRET` (un string aleatorio inventado), `TELEGRAM_ALLOWED_USERS` (@usernames o IDs numéricos separados por coma, o `*` para cualquiera). Redeploy.
3. Registrar el webhook:
   ```
   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_URL=https://TU-APP.vercel.app node scripts/setup-telegram-webhook.mjs
   ```
4. Buscar el bot en Telegram y escribirle. `/start` muestra la ayuda.

Las conversaciones de Telegram se guardan en `wa_conversations` con clave `tg:<chat_id>`.

## Brief diario al grupo del equipo

Cada mañana (12:00 UTC ≈ 8:00 Miami en verano, 7:00 en invierno) un Vercel Cron ejecuta `api/agent-hub.mjs (GET)`, que arma con `lib/brief.mjs` un resumen operativo/financiero — agenda del día, cobros, fugas de storage billing, FADD críticos, claims — y lo manda al grupo de Telegram.

Los cobros usan la fórmula real del CRM (`jobOutstanding`): balances + extras **menos pagos registrados como recibidos** — separando "deuda real" de "balances sin depurar" (viejos, probablemente cobrados y no descargados). Cada envío real guarda una foto en `brief_snapshots` (migración: `scripts/setup-brief-snapshots.mjs`) para mostrar deltas vs ayer, e incluye mensajes de cobro en inglés listos para reenviar a los top deudores.

Setup:
1. Crear un grupo de Telegram y agregar al bot como miembro.
2. En el grupo, mandar `/chatid@ElBot` → responde el Chat ID (número negativo).
3. Variables en Vercel: `TELEGRAM_BRIEF_CHAT_ID` (ese ID) y `CRON_SECRET` (string aleatorio que autentica el cron). Redeploy.
4. Probar sin enviar: `GET /api/agent-hub?dry=1` con header `Authorization: Bearer <CRON_SECRET>` devuelve el brief como JSON.

En grupos el bot solo responde a `/chatid` — la conversación normal del grupo no lo activa; el agente completo funciona por chat privado.

## Velocidad

El chat del CRM (`src/agentChat.jsx` → `POST /api/agent-hub` con `stream:true`) recibe la respuesta **en streaming** por SSE: el texto aparece mientras se escribe, y entre medio muestra en qué anda ("🔎 Consultando la base…", "📝 Armando el plan…", "⚙️ Ejecutando…"). Telegram y WhatsApp no soportan streaming; ahí el bot muestra "escribiendo…" hasta que llega la respuesta.

Además:
- Modelo por defecto `claude-sonnet-5` con `effort: medium` — se puede cambiar sin tocar código con `AGENT_MODEL` / `AGENT_EFFORT` en Vercel (ej. `AGENT_MODEL=claude-opus-4-8` si preferís profundidad sobre velocidad).
- Brokers, drivers, camiones, trips abiertos y storages van **precargados** en el prompt (cache de 5 min), así resolver "el camión 3" o "Full Value" no cuesta una vuelta extra al modelo.
- El esquema de la base y ese directorio se piden en paralelo y se cachean por instancia.

## Notas

- El agente resuelve fechas relativas ("el viernes", "esta semana") con timezone America/New_York.
- "se entrega el X" → `delivery_date`; solo usa `fadd` si decís "FADD" o "primera fecha disponible".
- Si un número de job existe en varias filas (varias ubicaciones de storage), la actualización se aplica a todas, igual que el formulario de edición de la app.
- Twilio corta el webhook a ~15 s, y la extracción con IA puede tardar más. Por eso el webhook responde al instante (TwiML vacío) y la respuesta real llega después por la API REST de Twilio (`sendWhatsApp` en `lib/twilio.mjs`), procesando en segundo plano con `waitUntil`.
