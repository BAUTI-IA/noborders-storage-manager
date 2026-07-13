# Gmail sync — mails de las empresas de storage

El sistema lee (solo lectura) la casilla Gmail donde llegan los mails de las
empresas de storage (Public Storage, Extra Space, CubeSmart, U-Haul, etc.),
los clasifica con IA y:

- **Auto-aplica** lo seguro: cuando llega un **recibo de pago** de una unidad
  identificada con certeza, avanza su `payment_due_date` (nunca la retrocede).
- **Deja en cola de revisión** (Storage → 📧 Mails) todo lo demás:
  confirmaciones de alquiler (para dar de alta la unidad con un clic),
  recordatorios de pago con fecha distinta a la del sistema, avisos de aumento
  de tarifa y **lien notices** (aviso rojo inmediato en el menú).

Cada mail procesado queda guardado en la tabla `storage_emails` (auditoría e
idempotencia). Un workflow de GitHub Actions dispara la sincronización cada
30 minutos; también hay botón **Sincronizar ahora** en la pestaña Mails.

## Setup (una sola vez)

### 1. Crear la tabla en Supabase

Pegar y correr `scripts/setup-gmail-emails.sql` en el SQL editor de Supabase
(es idempotente). La pestaña Mails también muestra este SQL si detecta que la
tabla falta.

### 2. Proyecto en Google Cloud + credenciales OAuth

Todo esto se hace **con la cuenta Gmail donde llegan los mails de storage**:

1. Entrar a [console.cloud.google.com](https://console.cloud.google.com) →
   crear un proyecto nuevo (ej. `noborders-gmail-sync`).
2. **APIs & Services → Library** → buscar **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - Completar nombre de la app y mails de contacto (cualquier valor sirve).
   - Scopes: no hace falta agregar ninguno acá.
   - **Importante:** al terminar, en la pantalla del consent screen tocar
     **Publish app** para pasar de *Testing* a **In production**. Si queda en
     Testing, el refresh token **expira a los 7 días** y el sync se cae.
     No hace falta pasar la verificación de Google: como el único usuario es
     el dueño de la casilla, se salta el aviso "app no verificada".
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs: `https://developers.google.com/oauthplayground`
   - Guardar el **Client ID** y el **Client Secret**.

### 3. Obtener el refresh token (OAuth Playground)

1. Abrir [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground).
2. Tocar el **engranaje** (arriba a la derecha) → tildar **Use your own OAuth
   credentials** → pegar el Client ID y Client Secret del paso anterior.
3. En "Step 1", pegar a mano el scope:
   `https://www.googleapis.com/auth/gmail.readonly` → **Authorize APIs**.
4. Iniciar sesión con la cuenta Gmail de los storages. Google va a mostrar
   "Google hasn't verified this app" → **Advanced → Go to … (unsafe)** →
   permitir.
5. En "Step 2", tocar **Exchange authorization code for tokens** y copiar el
   **Refresh token** (empieza con `1//`).

### 4. Variables de entorno en Vercel

En el proyecto de Vercel → Settings → Environment Variables (production):

| Variable | Valor |
|---|---|
| `GMAIL_CLIENT_ID` | Client ID del paso 2 |
| `GMAIL_CLIENT_SECRET` | Client Secret del paso 2 |
| `GMAIL_REFRESH_TOKEN` | Refresh token del paso 3 |
| `GMAIL_SYNC_SECRET` | un secreto largo inventado (ej. `openssl rand -hex 32`) |

Ya deberían existir: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_URL` (o `VITE_SUPABASE_URL`). Después de cargar las variables,
**redeployar** para que tomen efecto.

### 5. Secrets en GitHub (para el cron)

En el repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Valor |
|---|---|
| `GMAIL_SYNC_SECRET` | el mismo valor que en Vercel |
| `APP_URL` | la URL pública de la app, ej. `https://tu-app.vercel.app` |

Si faltan, el workflow se saltea sin fallar (igual que el backup).

## Probar

```bash
# sin auth → 401
curl -i -X POST https://TU-APP.vercel.app/api/gmail-sync

# con el secret → procesa hasta 8 mails y responde los contadores
curl -s -X POST https://TU-APP.vercel.app/api/gmail-sync \
  -H "x-sync-secret: TU_SECRET"
# → {"processed":8,"applied":2,"pending":4,"ignored":2,"errors":0}

# correrlo dos veces seguidas: la segunda debe dar processed:0 (idempotente)
```

También se puede disparar a mano desde GitHub → Actions → **Gmail sync** →
Run workflow, y ver el estado de la última corrida en la tabla
`gmail_sync_state` de Supabase.

## Cómo funciona por dentro

- `lib/gmail.mjs` — OAuth (refresh token → access token) y lectura de mensajes
  vía la API REST de Gmail, sin dependencias nuevas. `BRAND_SENDERS` mapea
  dominio del remitente → marca (`storages.brand`) y arma el filtro `from:` de
  la búsqueda: **solo se bajan mails de esas empresas**, el resto de la casilla
  nunca se lee. Para agregar una empresa, sumar su dominio a ese mapa.
- `api/gmail-sync.mjs` — el pipeline: lista mensajes nuevos desde la última
  sincronización (con 1 h de solapamiento; la dedup real es el unique de
  `gmail_message_id`), procesa **hasta 8 mails por corrida** (el backlog drena
  en las corridas siguientes), clasifica y extrae campos con Claude (solo
  JSON validado contra una lista blanca), matchea contra las unidades
  existentes (marca + unidad + estado = exacto; marca + zip = aproximado) y
  decide la acción. Nada se auto-aplica sin match exacto y confianza ≥ 0.8.
- `.github/workflows/gmail-sync.yml` — el cron (cada 30 min). Si el endpoint
  falla, el workflow falla y GitHub avisa por mail.

## Problemas comunes

- **`invalid_grant` en el estado del sync** → el refresh token expiró (app en
  Testing en vez de Production) o fue revocado. Repetir el paso 3.
- **El sync corre pero no aparecen mails** → verificar que el remitente esté
  en `BRAND_SENDERS` (`lib/gmail.mjs`); los dominios que no están ahí no se
  buscan.
- **401 desde el workflow** → el secret de GitHub y la env var de Vercel no
  coinciden, o falta redeployar Vercel.
