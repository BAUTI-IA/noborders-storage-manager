# Agente de IA por WhatsApp / Telegram

Le escribís al agente por WhatsApp en lenguaje natural y él carga, actualiza o consulta jobs del CRM. Ejemplos:

- **Crear**: "Tenemos un job del cliente García, pickup el 25 de julio en Miami FL, entrega en Orlando, FADD 1 de agosto, estimate 4500"
- **Actualizar**: "El job 1234 se entrega el viernes" / "Poné el job 1234 en depósito"
- **Consultar cualquier dato del CRM** (operativo, financiero, flota, usuarios): "¿Qué entregas hay esta semana?", "¿Cuánto facturamos este mes?", "¿Qué camiones están en ruta?", "¿Cuánto le debemos al broker X?". El agente investiga la base con SQL de solo lectura (función `agent_query`, creada por `scripts/setup-agent-query.mjs`: solo SELECT, transacción read-only, máx. 200 filas; los chats internos y el estado del agente quedan excluidos).

Antes de escribir en el CRM siempre te muestra lo que entendió y espera tu **"sí"** (o "no" para cancelar). Si algo está mal, respondé con la corrección ("no, la entrega es el sábado") y re-propone.

**Audios**: también entiende notas de voz (Telegram y WhatsApp). Las transcribe con OpenAI Whisper (requiere `OPENAI_API_KEY` en Vercel; ~US$0.006/min), responde "🎤 Escuché: ..." con la transcripción y sigue el flujo normal.

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

## Notas

- El agente resuelve fechas relativas ("el viernes", "esta semana") con timezone America/New_York.
- "se entrega el X" → `delivery_date`; solo usa `fadd` si decís "FADD" o "primera fecha disponible".
- Si un número de job existe en varias filas (varias ubicaciones de storage), la actualización se aplica a todas, igual que el formulario de edición de la app.
- Twilio corta el webhook a ~15 s, y la extracción con IA puede tardar más. Por eso el webhook responde al instante (TwiML vacío) y la respuesta real llega después por la API REST de Twilio (`sendWhatsApp` en `lib/twilio.mjs`), procesando en segundo plano con `waitUntil`.
