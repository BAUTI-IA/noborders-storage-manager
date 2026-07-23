# Agente de IA por WhatsApp

Le escribís al agente por WhatsApp en lenguaje natural y él carga, actualiza o consulta jobs del CRM. Ejemplos:

- **Crear**: "Tenemos un job del cliente García, pickup el 25 de julio en Miami FL, entrega en Orlando, FADD 1 de agosto, estimate 4500"
- **Actualizar**: "El job 1234 se entrega el viernes" / "Poné el job 1234 en depósito"
- **Consultar**: "¿Qué entregas hay esta semana?" / "¿Cómo está el job de García?"

Antes de escribir en el CRM siempre te muestra lo que entendió y espera tu **"sí"** (o "no" para cancelar). Si algo está mal, respondé con la corrección ("no, la entrega es el sábado") y re-propone.

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
   - `WHATSAPP_ALLOWED_NUMBERS` — números habilitados en E.164, separados por coma: `+5491122334455,+13055551234`. Cualquier otro número se ignora en silencio.
3. **Twilio**: creá una cuenta en twilio.com → Messaging → *Try it out* → *Send a WhatsApp message* (sandbox). Uníte al sandbox desde tu teléfono (mandando el código "join xxx-yyy" al número del sandbox) y configurá **"When a message comes in"** = `https://TU-APP.vercel.app/api/whatsapp-webhook` (POST).
4. Guardá el número del sandbox como contacto y escribile.

Cuando el flujo esté probado, se puede pasar del sandbox a un número de WhatsApp propio comprado en Twilio (requiere aprobar un perfil de WhatsApp Business con Meta; Twilio guía el trámite). El webhook es el mismo.

## Notas

- El agente resuelve fechas relativas ("el viernes", "esta semana") con timezone America/New_York.
- "se entrega el X" → `delivery_date`; solo usa `fadd` si decís "FADD" o "primera fecha disponible".
- Si un número de job existe en varias filas (varias ubicaciones de storage), la actualización se aplica a todas, igual que el formulario de edición de la app.
- Twilio corta el webhook a ~15 s, y la extracción con IA puede tardar más. Por eso el webhook responde al instante (TwiML vacío) y la respuesta real llega después por la API REST de Twilio (`sendWhatsApp` en `lib/twilio.mjs`), procesando en segundo plano con `waitUntil`.
