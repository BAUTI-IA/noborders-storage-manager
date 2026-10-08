# Conexión bancaria (Chase → Plaid → Bancos) y el email diario

Hasta ahora los movimientos del banco entraban a **Bancos** sólo si alguien subía
un screenshot o un CSV. Con esto, el banco se conecta **una sola vez** y:

1. Todas las mañanas el CRM trae los movimientos nuevos de las cuentas vinculadas
   y los carga en la **Bandeja** como *unreviewed*, con una categoría sugerida
   por la IA. Siguen pasando por el doble check de siempre (categorizar →
   verificar, dos personas distintas).
2. Después manda un **email** con el resumen: lo que entró y salió de cada
   cuenta desde el email anterior, el saldo según el banco, la lista de
   movimientos y cuántos esperan revisión.

El puente entre Chase y el CRM es **[Plaid](https://plaid.com)**. Con Chase la
conexión es la oficial (OAuth): la persona entra **en la página de Chase**, elige
qué cuentas compartir, y el acceso se puede cortar desde el mismo Chase. Ni el
CRM ni Plaid ven la clave. El CRM sólo pide el producto **Transactions**
(lectura de movimientos): no puede mover plata.

> La primera versión usaba Teller, que cerró su API en julio de 2026. Ver
> "Historia" al final.

## Cuánto cuesta

| Pieza | Costo |
|---|---|
| Plaid, plan **Trial** | Gratis, con datos reales. Hasta **10 conexiones en total** (un login de Chase = una conexión, aunque tenga 4 cuentas). |
| Email (Gmail + Apps Script) | Gratis. |
| Vercel | Nada nuevo: es una acción dentro de `api/bank-analyze.mjs`, no una función más. |
| Categoría sugerida (Claude) | Centavos por día, con la `ANTHROPIC_API_KEY` que ya está. |

Letra chica del Trial (docs de Plaid, "Pricing and billing"):

- Las 10 conexiones son **en total, no a la vez**: desconectar (`/item/remove`)
  **no devuelve el lugar**. Por eso el panel avisa antes de conectar un segundo
  banco o de desconectar.
- **Reconnect no gasta una conexión**: abre Plaid en *update mode* sobre la misma.
- Si algún día se pasa a un plan pago, Plaid no publica precios: se ven al pedir
  acceso a Production o se cotizan con ventas.

El CRM **nunca llama a `/accounts/balance/get` ni a `/transactions/refresh`**,
que Plaid cobra por llamada. El saldo sale de `/accounts/get`, que es gratis y
está tan al día como la última actualización de movimientos.

## Puesta en marcha (una sola vez)

### 1. Cuenta en Plaid

1. Crear la cuenta en [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup)
   con el email de la empresa y verificar el email.
2. Pedir el plan **Trial** desde el botón del inicio del Dashboard (o
   [dashboard.plaid.com/trial-plan](https://dashboard.plaid.com/trial-plan)) y
   aceptar los acuerdos. No pide registro de empresa.
3. En **Developers → Keys** están el **client_id** y dos **secrets**: el de
   *Sandbox* (datos de prueba) y el de *Production* (el real, el del Trial).

Si al conectar Chase no aparece, revisar en el Dashboard el estado de registro
de las instituciones OAuth: según Plaid, en el Trial el acceso a Chase se
habilita solo, pero puede tardar unas horas.

### 2. Variables en Vercel

**Settings → Environment Variables** (Production), y después **Redeploy**:

| Variable | Valor |
|---|---|
| `PLAID_CLIENT_ID` | El client_id. |
| `PLAID_SECRET` | El secret de **Production**. |
| `PLAID_ENV` | `production`. (`sandbox` + el secret de Sandbox sirve para probar con datos falsos.) |
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

- `bank_feed_connections` — una fila por login de banco ("Item" en Plaid), con
  el access token y el cursor de sincronización. **Sin ninguna policy de RLS**:
  sólo la service role (`api/bank-analyze.mjs`) la lee. Ni el navegador ni el
  agente de IA la pueden consultar (`AGENT_DENY_TABLES` en `lib/acl.mjs`). No
  agregarla nunca a `TABLE_ACL`.
- `bank_digest_settings` — quién recibe el email, en qué idioma, y hasta qué
  movimiento ya se mandó.
- Columnas `feed_*` en `bank_accounts` — qué cuenta de Plaid llena cada cuenta
  del CRM, desde qué fecha, y el último saldo según el banco.

Es re-ejecutable, y sirve también sobre una base donde se haya corrido la
versión de Teller.

### 4. Conectar Chase

Desde **una computadora** (en el navegador de escritorio Chase se abre en una
ventana emergente: si el navegador la bloquea, permitirla).

1. **Bancos → Cuentas → ＋ Connect bank**. Se abre la ventana de Plaid: buscar
   Chase, y Plaid lleva a la página de Chase para entrar y elegir las cuentas.
2. El panel propone qué cuenta del CRM llena cada cuenta del banco:
   - si una cuenta del CRM tiene los **mismos últimos 4 dígitos**, esa;
   - si no, **＋ Create a new account** (por ejemplo "Chase TOTAL CHECKING");
   - las **tarjetas** no se importan todavía.

   Si la cuenta "Chase Bank" que ya existe en el CRM no tiene cargados los
   últimos 4 dígitos, elegila a mano en la cuenta que corresponda.
3. **Import from**: desde qué fecha traer. Por defecto, hoy. Plaid trae hasta 90
   días hacia atrás; lo anterior ya está cargado por screenshots/CSV, y traerlo
   de nuevo sólo arriesga duplicados.
4. **Save links**. Corre la primera sincronización en el momento. Justo después
   de conectar, Plaid puede tardar unos minutos en juntar el historial: si el
   panel lo dice, tocar **Sync now** un rato después.

**Primera verificación**: en la Bandeja, un débito conocido (nafta, un pago)
tiene que aparecer en **negativo** y un depósito en positivo. (Plaid usa el signo
al revés — positivo = sale plata — y el CRM lo da vuelta; el script de Sandbox de
abajo lo verifica movimiento por movimiento.)

Una vez vinculada una cuenta, **dejar de subir sus screenshots**: la conexión
trae cada movimiento sola.

**Recomendado**: conectar con un **usuario de Chase de solo lectura** (Chase →
Access & security → agregar un usuario que sólo pueda ver esas cuentas), no con
el del dueño.

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
8 AM  Apps Script ──GET /api/bank-digest──▶ CRM: /transactions/sync en Plaid → Bandeja
                  ◀── destinatarios + asunto + HTML ──
      Gmail manda el email
      Apps Script ──POST /api/bank-digest { ack }──▶ CRM: "lo mandé"
```

- **Qué se importa**: sólo movimientos **posted**. Uno *pending* todavía puede
  cambiar o desaparecer; cuando se acredita, Plaid lo manda de nuevo como posted
  y ahí entra. Con fecha desde "Import from".
- **El cursor**: Plaid entrega los cambios desde la última lectura
  (`/transactions/sync`). El cursor se guarda recién cuando los movimientos ya
  están en la base: si algo falla, la próxima vez se leen otra vez. Si Plaid
  cambia los datos en medio de la lectura, se reinicia desde el principio, como
  pide su documentación.
- **Sin duplicados**: cada movimiento de Plaid tiene un id; re-sincronizar no
  carga nada dos veces. Si un movimiento ya estaba cargado por screenshot o CSV
  (misma cuenta, fecha, monto y descripción), se toma como ése. Dos movimientos
  idénticos el mismo día (dos cargas de $50 en la misma estación) son dos.
  La descripción es la del banco (`original_description`), la misma que se ve en
  Chase.
- **Vincular una cuenta después**: los movimientos de cuentas no vinculadas se
  leen y se descartan, así que al vincular una nueva el CRM vuelve a pedirle a
  Plaid el historial (sin duplicar lo ya cargado).
- **Qué lista el email**: todo lo que entró al ledger de las cuentas vinculadas
  desde el email anterior, cualquiera sea la fecha del movimiento. El script
  confirma después de mandar; si el envío falla, el email siguiente repite esos
  movimientos. No se pierde ninguno y no se repite ninguno ya enviado.
- **El primer email** arranca desde lo que había en el ledger al vincular las
  cuentas: no manda la historia entera.
- **Sync now** en el panel sincroniza en el momento, sin mandar email.

## Probar sin datos reales (Sandbox)

```bash
PLAID_CLIENT_ID=... PLAID_SECRET=<secret de Sandbox> node scripts/plaid-sandbox-check.mjs
```

Corre todo el flujo contra el **Sandbox real de Plaid** (banco de prueba, API
real) con una base en memoria: conectar, vincular, sincronizar, verificar el
signo de cada movimiento contra lo que mandó Plaid, re-sincronizar sin duplicar,
simular que el banco pide volver a iniciar sesión y desconectar. No toca la base
del CRM ni Production. (En el contenedor de Claude hace falta
`NODE_USE_ENV_PROXY=1` para que Node salga por el proxy.)

Para probar el panel con datos falsos: `PLAID_ENV=sandbox` y el secret de Sandbox
en Vercel; en la ventana de Plaid, usuario `user_good` y clave `pass_good`.

## Cuando algo falla

| Se ve | Qué es | Qué hacer |
|---|---|---|
| **Needs reconnect** en el panel y ⚠ en el asunto del email | El banco pide volver a iniciar sesión (Plaid: `ITEM_LOGIN_REQUIRED`, consentimiento vencido…). | **Reconnect** en el panel: se abre Plaid sobre **la misma** conexión (no gasta otra). Al terminar se pone al día solo. |
| **Sync error** | Plaid no respondió o rechazó la llamada. El mensaje dice por qué. | Si es `INVALID_API_KEYS`, revisar `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV` (el secret tiene que ser del mismo entorno). Si es pasajero, se arregla solo: el cursor no avanza mientras falle. |
| "this account is no longer shared…" | La cuenta ya no está en la conexión (se destildó en Chase o se cerró). | **Reconnect** y volver a elegirla, o desvincularla con "Don't import". |
| No llega el email y Google avisa que falló el script | El script no pudo hablar con el CRM o no hay destinatarios. | El aviso de Google dice el motivo. 401 = `SECRET` distinto de `BANK_DIGEST_SECRET`. |
| Chase no aparece en la ventana de Plaid | El acceso OAuth a Chase todavía no está habilitado en la cuenta de Plaid. | Dashboard de Plaid → estado de las instituciones OAuth. |

**Disconnect** borra la conexión también del lado de Plaid (`/item/remove`),
desvincula las cuentas y borra el token. Lo ya importado queda en Bancos. En el
Trial, esa conexión no se recupera.

## Dónde está cada cosa

| Pieza | Archivo |
|---|---|
| Reglas puras (signo, qué se importa, el email) | `src/bankFeedData.js` · tests en `scripts/test-bank-feed-data.mjs` |
| Plaid + Supabase | `lib/bankFeed.mjs` · tests en `scripts/test-bank-feed.mjs` (Plaid simulado) y `scripts/plaid-sandbox-check.mjs` (Sandbox real) |
| Endpoint | `api/bank-analyze.mjs` (acciones `feed_*`, `digest_*`) + rewrite `/api/bank-digest` en `vercel.json` |
| Panel | `src/bankFeed.jsx`, dentro de Bancos → Cuentas |
| Email | `scripts/bank-digest-email.gs` (Apps Script) |
| Migración | `scripts/setup-bank-feed.mjs` (SQL en `BANK_FEED_SQL`) |

## Historia

La primera versión (#157) usaba **Teller**. Teller avisó en julio de 2026 que
daba de baja su API y ya no acepta registros, así que nunca llegó a conectarse.
El email, el panel, las reglas de importación y el script de Gmail quedaron
iguales; cambió sólo la parte que habla con el banco.
