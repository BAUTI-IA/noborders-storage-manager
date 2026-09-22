# WhatsApp de la empresa (WATI Coexistence) → CRM

La idea: los brokers nos mandan los jobs por WhatsApp (texto, capturas, PDFs,
audios). El CRM lee esos mensajes, entiende la *job information* y la deja
cargada como **lead en el Pipeline**, cotizada, para que una persona decida.

Se hace con **WATI en modo Coexistence**: el número sigue funcionando normal en
la **WhatsApp Business App del celular** y, al mismo tiempo, WATI (la API de
Meta) nos avisa de cada mensaje — incluidos los que el equipo responde desde
el celular (*echoes*).

> Esto es aparte del agente de IA interno (`docs/whatsapp-agent.md`), que sigue
> en Twilio con su propio número. No se pisan.

```
Broker manda el job por WhatsApp (texto / captura / PDF / audio)
   → llega al celular (Business App) y a WATI a la vez (Coexistence)
   → WATI llama a /api/wati-webhook
   → el CRM guarda el mensaje (wa_messages) y lo vincula por teléfono
     con el broker / job / driver                                ← Fase 1 (hecha)
   → la IA decide: ¿job nuevo, dato de un job que ya mandó, o charla?
   → si es un job: extrae los campos → lead en el Pipeline ("new")
   → se cotiza solo con el Job Calculator → aviso al equipo      ← Fase 2
   → una persona hace Accept → se convierte en job del CRM
```

**Nada se vuelve job solo.** Igual que con los mails, el lead nace en `new` y
lo acepta una persona.

---

## Fase 0 — Setup de WATI (lo hacen ustedes)

1. El número tiene que estar en **WhatsApp Business** (no el WhatsApp común),
   versión **2.24.17 o más nueva**. Hace falta la Página de Facebook de la
   empresa (con acceso admin) y el Business Portfolio de Meta.
2. Crear la cuenta de WATI. Si no aparece la opción Coexistence, pedírsela al
   soporte de WATI. **No** hacer la migración común a Cloud API (esa pide borrar
   WhatsApp del número).
3. Elegir **"Connect your WhatsApp Business app (WhatsApp Coexistence)"** →
   *Continue with Facebook* → elegir el Business Portfolio → *Connect your
   existing WhatsApp Business app* → **el mismo número** → mismo nombre y zona
   horaria (Eastern).
4. En el celular: abrir el mensaje de Facebook Business → *Connect* → escanear
   el QR.
5. **Sí a sincronizar los chats** (contactos + hasta 6 meses de historial). Si
   se saltea, después no se puede activar sin desconectar y rehacer todo.
6. **No** cargar un método de pago propio en la WABA de Meta (lo factura WATI).
7. Los dispositivos vinculados (WhatsApp Web, etc.) pueden desvincularse; se
   vuelven a vincular. WhatsApp para Windows y WearOS no son compatibles.

**Pruebas antes de seguir** (desde otro teléfono):

- [ ] Un mensaje entrante aparece en el celular **y** en el Team Inbox de WATI.
- [ ] Una respuesta **desde el celular** aparece en WATI (el echo). Sin esto, el
      CRM no ve lo que responde el equipo.
- [ ] Una respuesta desde **WhatsApp Web**, si lo usan: ¿aparece en WATI?
- [ ] Varios mensajes seguidos llegan todos.

**Mantenimiento:** abrir la app del celular **al menos cada 14 días**; si no,
Meta desconecta el número de la API.

**Limitaciones de Coexistence:** los grupos no pasan por la API (los grupos de
drivers quedan afuera); en la app se desactivan mensajes temporales, "ver una
vez", ubicación en vivo y listas de difusión; la API tiene un tope de 20
mensajes/segundo. Lo que se manda desde la app es gratis; por la API, la tarifa
de Meta más el plan de WATI.

---

## Fase 1 — Captura (hecha)

Guarda **todo** lo que pasa por el número, en las dos direcciones, y lo vincula
con el CRM. Todavía no hay IA: primero probamos que llega completo.

| Pieza | Dónde |
|---|---|
| Webhook | `/api/wati-webhook` → rewrite en `vercel.json` → `api/whatsapp-webhook.mjs?provider=wati` (no suma una función 13) |
| Lógica | `lib/wati.mjs` (auth, guardar, vincular) |
| Parseo y teléfonos (puro, con tests) | `src/watiData.js`, `scripts/test-wati-data.mjs` |
| Migración | `scripts/setup-wati.sql` / `scripts/setup-wati.mjs` |

**`wa_messages`** — una fila por mensaje:

- `direction`: `inbound` (nos escribieron), `outbound_app` (respondimos desde el
  celular — echo de Coexistence), `outbound_api` (desde WATI / API / template).
- `phone` (E.164), `contact_name`, `msg_type`, `body`, `media_url`, `status`
  (sent / delivered / read, se actualiza con los eventos de estado), `sent_at`.
- `broker_id` / `driver_id` / `job_id`: a quién pertenece el teléfono.
- `raw`: el JSON completo de WATI, para reprocesar si algo se leyó mal.
- Sin duplicados: `(provider, provider_message_id)` es único, así que un
  reintento de WATI no crea dos filas.

**Vinculación por teléfono.** Los teléfonos del CRM son texto libre
(`(305) 555-1234`, `+1 305…`) y WhatsApp manda código de país + número. Se
comparan por los **últimos 10 dígitos** (`wa_phone_key()` en SQL = `phoneKey()`
en JS), contra `brokers.contact_phone`, `drivers.phone` y
`storage_jobs.client_phone`. Si un cliente tiene varios jobs gana uno abierto
y, entre esos, el más nuevo. No hace falta normalizar los teléfonos ya
cargados.

**Seguridad.** Cualquiera puede escribirle al número, así que:
- el endpoint exige `WATI_WEBHOOK_SECRET` y **sin esa variable responde 503**
  (no hay modo abierto);
- texto, nombres y `raw` se guardan como datos: nunca se ejecutan ni se le
  pasan a la IA como instrucciones;
- sólo el service role escribe; leer requiere el permiso `pipeline` → view;
  `wa_match_phone()` sólo la puede ejecutar el service role.

### Instalación

1. **Migración** — Supabase → SQL Editor → pegar `scripts/setup-wati.sql` → Run.
   O: `SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-wati.mjs`.
2. **Vercel** → variable `WATI_WEBHOOK_SECRET` = un string aleatorio
   (`openssl rand -hex 32`) → redeploy.
3. **WATI** → configuración de Webhooks → URL:
   `https://TU-APP.vercel.app/api/wati-webhook?token=EL_SECRETO`
   con los eventos de **mensaje recibido**, **mensaje enviado** (session /
   template) y **estados** (delivered / read). Si WATI deja agregar un header,
   también sirve `X-Webhook-Secret: EL_SECRETO` en lugar del `?token=`.
4. Mandar un mensaje de prueba y fijarse en Supabase → `wa_messages`.

### Qué verificar con datos reales

El formato de WATI no está documentado del todo y los echoes de Coexistence
son nuevos, por eso el parser es tolerante y todo evento que no entiende queda
en los logs de Vercel como `[wati] ignored (...)` con el JSON completo. Con el
primer día de mensajes hay que confirmar:

- [ ] Que lo respondido desde el celular llega con `direction = outbound_app`
      (hoy se detecta por `owner: true` en un evento que no es de envío por API).
- [ ] Que imágenes / documentos traen su URL (`media_url`).
- [ ] Que los eventos de estado actualizan `status`.

**Criterio para pasar a la Fase 2:** una semana en la que todo lo que se ve en
el celular aparece en `wa_messages`.

---

## Fase 2 — Leer los jobs (siguiente)

- **Quién se procesa:** sólo números permitidos (falla cerrado, como la
  allowlist de mails): una lista `allowedWhatsAppNumbers` en Pipeline →
  Settings, más los brokers con teléfono cargado. El resto se guarda pero no
  pasa por la IA.
- **Mensajes en partes:** los brokers mandan un job en 3–4 mensajes. La IA mira
  los mensajes recientes del chat (~30 min) y decide: *job nuevo* → crea lead;
  *completa el lead que ya mandó* → llena sólo lo que faltaba (sin duplicar);
  *no es un job* → nada.
- **Varios jobs en un mensaje:** extender el extractor de `lib/leads.mjs` para
  devolver una lista.
- **Capturas y PDFs:** Claude visión (como `bol-analyze`). **Audios:**
  `lib/transcribe.mjs`.
- **Campos:** los de `LEAD_FIELDS` (broker job #, cliente, origen/destino con
  ZIP, cu ft, precio del broker, FADD, fechas, tipo de job); lo dudoso queda
  marcado *low confidence*.
- **Cotización** automática con `evaluateLead()` y **aviso** al grupo de
  Telegram (opcional: mail por Gmail).
- **Seguridad:** el texto es input no confiable → la IA sólo devuelve datos con
  esquema cerrado; topes de leads por remitente y por día; lo descartado queda
  en History.
- Migración: columna `lead_id` en `wa_messages` → `job_leads`.

## Fase 3 — Pantallas

- **Pipeline:** badge WhatsApp en el lead, el hilo original al lado de los
  campos extraídos y los números permitidos en Settings.
- **Job:** pestaña WhatsApp con la conversación de ese broker / cliente.
- Todo con su traducción en `I18N_ES`.

## Fase 4 — Después (opcional)

- Mandar desde el CRM por la API de WATI: confirmar al broker, *Offer to
  carrier* (hoy abre un link wa.me) y templates de recordatorio (fuera de la
  ventana de 24 h Meta sólo permite templates aprobados).
- Mensajes sobre jobs existentes ("delivered", "cambió la fecha") → proponer el
  cambio para confirmar, nunca aplicarlo solo.
