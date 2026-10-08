# Conexión bancaria (Chase → Teller → Bancos) y el email diario

Hasta ahora los movimientos del banco entraban a **Bancos** sólo si alguien subía
un screenshot o un CSV. Con esto, el banco se conecta **una sola vez** y:

1. Todas las mañanas el CRM trae los movimientos nuevos de las cuentas vinculadas
   y los carga en la **Bandeja** como *unreviewed*, con una categoría sugerida
   por la IA. Siguen pasando por el doble check de siempre (categorizar →
   verificar, dos personas distintas).
2. Después manda un **email** con el resumen: lo que entró y salió de cada
   cuenta desde el email anterior, el saldo según el banco, la lista de
   movimientos y cuántos esperan revisión.

El puente entre Chase y el CRM es **[Teller](https://teller.io)**: la persona
entra a Chase **dentro de la ventana de Teller** y el CRM nunca ve ni guarda la
clave del banco. El acceso es **sólo lectura**: con esto no se puede mover plata.

## Cuánto cuesta

| Pieza | Costo |
|---|---|
| Teller, entorno **development** | Gratis hasta 100 conexiones, con datos reales. |
| Teller, entorno **production** | US$0.30 por mes por conexión (un login de Chase = una conexión, aunque tenga 4 cuentas). Precio de la página de Teller: confirmalo al crear la cuenta. |
| Email (Gmail + Apps Script) | Gratis. |
| Vercel | Nada nuevo: es una acción dentro de `api/bank-analyze.mjs`, no una función más. |
| Categoría sugerida (Claude) | Centavos por día, con la `ANTHROPIC_API_KEY` que ya está. |

El CRM **nunca pide el saldo a Teller** (`/balances` se cobra por llamada): el
saldo del banco sale del `running_balance` que viene con cada movimiento. Si
Chase no lo informa, el email muestra "—" en esa columna.

## Puesta en marcha (una sola vez)

### 1. Cuenta en Teller

1. Crear la cuenta en [teller.io](https://teller.io) a nombre de la empresa y
   crear una aplicación. De ahí salen:
   - el **Application ID** (`app_…`);
   - el **certificado** y su **clave privada** (dos archivos `.pem`). Teller pide
     ese certificado en cada llamada fuera del sandbox: sin él, el token de una
     conexión no sirve para nada aunque se filtre.
2. Arrancar en **development**: datos reales y gratis.

### 2. Variables en Vercel

**Settings → Environment Variables** (Production), y después **Redeploy**:

| Variable | Valor |
|---|---|
| `TELLER_APP_ID` | El Application ID (`app_…`). |
| `TELLER_ENV` | `development` (después `production`). `sandbox` sirve para probar con datos falsos. |
| `TELLER_CERT` | El contenido del certificado `.pem`, entero. También se acepta en base64 o con `\n` literales. |
| `TELLER_KEY` | El contenido de la clave privada `.pem`, igual que arriba. |
| `BANK_DIGEST_SECRET` | Un texto largo al azar (`openssl rand -hex 32`). Lo usa el script de Gmail. |
| `APP_URL` | Ya existe: el link "Abrir el CRM" del email sale de acá. |

Hasta que estén, **Bancos → Cuentas** muestra qué falta.

### 3. Migración de la base

```bash
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank-feed.mjs
# o imprimir el SQL para pegarlo en el SQL Editor de Supabase:
node scripts/setup-bank-feed.mjs --sql
```

Con las variables de Vercel ya cargadas, el mismo SQL aparece en **Bancos →
Cuentas** con un botón **Copy SQL** mientras la migración no esté. Crea:

- `bank_feed_connections` — una fila por login de banco, con el token de Teller.
  **Sin ninguna policy de RLS**: sólo la service role (`api/bank-analyze.mjs`) la
  lee. Ni el navegador ni el agente de IA la pueden consultar
  (`AGENT_DENY_TABLES` en `lib/acl.mjs`). No agregarla nunca a `TABLE_ACL`.
- `bank_digest_settings` — quién recibe el email, en qué idioma, y hasta qué
  movimiento ya se mandó.
- Columnas `feed_*` en `bank_accounts` — qué cuenta de Teller llena cada cuenta
  del CRM, desde qué fecha, y el último saldo según el banco.

### 4. Conectar Chase

1. **Bancos → Cuentas → ＋ Connect bank**. Se abre la ventana de Teller: elegir
   Chase, entrar con el usuario de Chase, elegir las cuentas.
2. El panel propone qué cuenta del CRM llena cada cuenta del banco:
   - si una cuenta del CRM tiene los **mismos últimos 4 dígitos**, esa;
   - si no, **＋ Create a new account** (por ejemplo "Chase TOTAL CHECKING");
   - las **tarjetas** no se importan todavía (el signo y el saldo funcionan al
     revés que en una cuenta corriente).

   Si la cuenta "Chase Bank" que ya existe en el CRM no tiene cargados los
   últimos 4 dígitos, elegila a mano en la cuenta que corresponda.
3. **Import from**: desde qué fecha traer. Por defecto, hoy. Lo anterior ya está
   cargado por screenshots/CSV; traerlo de nuevo sólo arriesga duplicados.
4. **Save links**. Corre la primera sincronización en el momento.

**Primera verificación**: en la Bandeja, un débito conocido (nafta, un pago)
tiene que aparecer en **negativo** y un depósito en positivo.

Una vez vinculada una cuenta, **dejar de subir sus screenshots**: la conexión
trae cada movimiento sola.

### 5. El email diario

1. En **Bancos → Cuentas → Daily email**, cargar quién lo recibe (emails separados
   por comas, hasta 10), el idioma y **Save**. **Preview** muestra cómo saldría
   hoy, sin mandarlo ni marcar nada.
2. En [script.google.com](https://script.google.com), logueado con **la cuenta que
   lo manda** (la de Workspace): proyecto nuevo → pegar
   `scripts/bank-digest-email.gs` → completar `CRM_URL`
   (`https://TU-APP.vercel.app/api/bank-digest`) y `SECRET` (= `BANK_DIGEST_SECRET`).
3. Correr **`install`** una vez: pide permiso para mandar mails y llamar al CRM, y
   crea el trigger diario (entre las 8 y las 9 AM de Nueva York).
4. Probarlo ya: correr **`sendBankDigest`** a mano.

## Cómo funciona

```
8 AM  Apps Script ──GET /api/bank-digest──▶ CRM: sincroniza Chase (Teller) → Bandeja
                  ◀── destinatarios + asunto + HTML ──
      Gmail manda el email
      Apps Script ──POST /api/bank-digest { ack }──▶ CRM: "lo mandé"
```

- **Qué se importa**: sólo movimientos **posted** (un *pending* todavía puede
  cambiar o desaparecer: entra el día que se acredita), con fecha desde
  "Import from".
- **Sin duplicados**: cada movimiento de Teller tiene un id; re-sincronizar no
  carga nada dos veces. Si un movimiento ya estaba cargado por screenshot o CSV
  (misma cuenta, fecha, monto y descripción), se toma como ése y no se carga.
  Dos movimientos idénticos el mismo día (dos cargas de $50 en la misma
  estación) son dos movimientos.
- **Qué lista el email**: todo lo que entró al ledger de las cuentas vinculadas
  desde el email anterior, cualquiera sea la fecha del movimiento. El script
  confirma después de mandar; si el envío falla, el email siguiente repite esos
  movimientos. No se pierde ninguno y no se repite ninguno ya enviado.
- **El primer email** arranca desde lo que había en el ledger al vincular las
  cuentas: no manda la historia entera.
- **Sync now** en el panel sincroniza en el momento, sin mandar email.

## Cuando algo falla

| Se ve | Qué es | Qué hacer |
|---|---|---|
| **Needs reconnect** en el panel y ⚠ en el asunto del email | Chase pide volver a iniciar sesión (cambio de clave, MFA nuevo…). | **Reconnect** en el panel: se abre Teller sobre la misma conexión. Después, **Sync now**. |
| **Sync error** | Teller no respondió o rechazó la llamada. El mensaje dice por qué. | Si es el certificado, revisar `TELLER_CERT`/`TELLER_KEY`. Si es pasajero, se arregla solo al día siguiente: la ventana de lectura no avanza mientras falle. |
| "this account is no longer shared…" | La cuenta ya no está en la conexión (se destildó en Teller o se cerró). | **Reconnect** y volver a elegirla, o desvincularla con "Don't import". |
| No llega el email y Google avisa que falló el script | El script no pudo hablar con el CRM o no hay destinatarios. | El aviso de Google dice el motivo. 401 = `SECRET` distinto de `BANK_DIGEST_SECRET`. |
| El email sale sin saldo ("—") | Chase no informa `running_balance` en esa cuenta. | Nada: el saldo calculado del CRM sigue en Bancos → Cuentas. |

## Pasar a production

Cuando todo ande en development: `TELLER_ENV=production` en Vercel, Redeploy, y
**volver a conectar** (las conexiones de development no pasan a production).
Desconectar la de development desde el panel.

**Disconnect** corta la conexión también del lado de Teller (para que deje de
cobrarse), desvincula las cuentas y borra el token. Lo ya importado queda en
Bancos.

## Dónde está cada cosa

| Pieza | Archivo |
|---|---|
| Reglas puras (qué se importa, el email) | `src/bankFeedData.js` · tests en `scripts/test-bank-feed-data.mjs` |
| Teller (mTLS) + Supabase | `lib/bankFeed.mjs` · tests en `scripts/test-bank-feed.mjs` |
| Endpoint | `api/bank-analyze.mjs` (acciones `feed_*`, `digest_*`) + rewrite `/api/bank-digest` en `vercel.json` |
| Panel | `src/bankFeed.jsx`, dentro de Bancos → Cuentas |
| Email | `scripts/bank-digest-email.gs` (Apps Script) |
| Migración | `scripts/setup-bank-feed.mjs` (SQL en `BANK_FEED_SQL`) |
