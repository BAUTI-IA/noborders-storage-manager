# Carriers — jobs que le damos a carriers externos (somos el broker)

Cuando No Borders le da un job a otro carrier, todo pasa por el CRM:

1. **La orden sale del CRM.** Se manda por mail desde la casilla `dispatch@`, por
   WhatsApp o por los dos, con el rate y lo que el carrier tiene que cobrarle al
   cliente. El mail lleva el rate confirmation en PDF.
2. **El carrier responde a ese mismo mail.**
   - Para aceptar, contesta **ACCEPT**.
   - Cuando termina, manda el BOL firmado y la foto del cobro.
3. **El CRM lee la casilla solo.** La IA lee los documentos, encuentra el despacho y
   avisa por Telegram.
4. **Una persona aprueba en Carriers → Docs to review.** Con eso:
   - el job pasa a *delivered*;
   - el saldo del cliente queda en cero;
   - lo que el carrier cobró de más (o de menos) se suma a su saldo con nosotros.

Las pantallas, en orden: https://claude.ai/artifact/YKGnpkF8Q3faKLMcgYHhh5.
Las opciones que se discutieron: https://claude.ai/artifact/9andQMmZXZR1y9W6WReEbn.
Está construida la **fase 1, opción A**: Gmail más WhatsApp asistido.

---

## Setup (una sola vez)

### 1. Base de datos

```
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-carriers.mjs
```

Crea `carriers`, `carrier_dispatches`, `carrier_messages`, `carrier_payments`,
`carrier_adjustments` y el bucket **privado** `carrier-docs`. El RLS es por sección
(`carriers`), igual que el resto del CRM. Si preferís pegarlo en el SQL Editor:
`node scripts/setup-carriers.mjs --sql`.

### 2. Variables en Vercel

| Variable | Para qué |
|---|---|
| `CARRIER_MAIL_SECRET` | La clave que comparte el script de Google con el CRM. Se genera con `openssl rand -hex 32`. Sin ella, `/api/carrier-mail` contesta 503. |
| `CARRIER_TELEGRAM_CHAT_ID` | Opcional. El grupo que recibe el aviso de docs nuevos. Si falta, se usa `TELEGRAM_BRIEF_CHAT_ID`. |
| `APP_URL` | Opcional. Va en el aviso de Telegram para ir directo al CRM. |
| `CARRIER_EXTRACT_MODEL` | Opcional. Cambia el modelo que lee los documentos. Por defecto se usa el mismo que el Pipeline. |

Después de cargarlas, **redeploy**.

### 3. La casilla `dispatch@`

1. Crear la casilla: `dispatch@` en el dominio de la empresa (Google Workspace) o una
   Gmail aparte.
2. Entrar a [script.google.com](https://script.google.com) **logueado con esa casilla**.
3. Crear un proyecto nuevo y pegar `scripts/carrier-dispatch.gs`.
4. Completar `CRM_URL` (`https://TU-APP.vercel.app/api/carrier-mail`) y `SECRET`
   (= `CARRIER_MAIL_SECRET`).
5. Correr **`install`** una vez. Pide permiso para Gmail y para llamar al CRM, y crea
   un trigger cada 5 minutos.
6. Para probar a mano: **`run`**.

### 4. Permisos y carriers

- En **Users**, darle la sección **Carriers** a quien despacha (view / edit / create).
- En **Carriers → Carriers → + Carrier**, cargar cada carrier:
  - nombre, MC/DOT;
  - **mails** (todas las direcciones desde las que escriben, separadas por coma);
  - WhatsApp;
  - vencimiento del seguro;
  - rate por CF por defecto.
- **Con el seguro vencido no se puede despachar.**

---

## Cómo se usa

1. **Despachar.** En el detalle del job, pestaña **Money**, la tarjeta **Carrier** tiene
   **Dispatch to carrier**. Ahí se elige carrier, rate (por CF o fijo), CF estimado, lo
   que el carrier tiene que cobrar y los extras que le corresponden.
   - Lo que hay que cobrar viene precargado con lo pendiente del job.
   - Al confirmar se hace todo esto:
     - se crea el despacho (D57);
     - se genera el rate confirmation en PDF;
     - el mail queda en cola, y el script lo manda en menos de 5 minutos;
     - si se eligió WhatsApp, se abre `wa.me` con el mensaje armado.
2. **Aceptación.** Si el carrier responde "ACCEPT", el despacho pasa solo a
   *Accepted*. También se puede marcar a mano desde la tarjeta.
3. **Documentos.** El carrier responde el mail con el BOL y el comprobante. Entonces:
   - el script sube los adjuntos directo al bucket privado;
   - la IA los lee;
   - el despacho queda en *Docs to review*;
   - llega un aviso por Telegram.
4. **Revisión** (Carriers → Docs to review). A la izquierda están los archivos; a la
   derecha lo que leyó la IA (CF final, cobrado, método, fecha, firmas) en campos
   editables, con alertas si algo no cierra. Hay tres acciones:
   - **Approve**: el despacho pasa a *Verified* y el job a *delivered*;
   - **Mark disputed**;
   - **Discard**.
5. **Saldos y pagos.**
   - **Balances**: muestra qué carrier debe y a cuál le debemos.
   - **Payments & adjustments**: registra pagos en las dos direcciones y ajustes
     (por ejemplo, un claim a cargo del carrier).
   - El saldo de cada carrier también aparece en **AP / AR**.

### La cuenta

```
le corresponde al carrier = rate × CF final (o el fijo) + extras del carrier
neto del despacho         = lo que cobró el carrier − lo que le corresponde   (> 0 nos debe)
saldo del carrier         = Σ neto de despachos verificados + ajustes − pagos que nos hizo + pagos que le hicimos
```

Lo que cobra el carrier **no** se registra como fila de Payments: esa plata nunca
llega a nuestro banco, sólo el neto. Se suma a lo cobrado del job
(`jobCollectedFor` en `src/App.jsx`): el saldo del cliente queda en cero y la deuda
pasa al carrier. Así Payments y Bancos no quedan con plata "en circulación" que
nunca se deposita.

### Cómo un mail encuentra su despacho

`matchInbound` en `lib/carriers.mjs` prueba en este orden:
1. El código en la dirección: el Reply-To de la orden es `dispatch+cd57@…` y Gmail lo
   entrega en la misma casilla.
2. `[Job NB-24107 · D57]` en el asunto, por si lo reenvían.
3. El número de job en el asunto, el texto o lo que leyó la IA, entre los despachos
   abiertos de ese carrier.
4. El único despacho abierto del carrier.
5. Si nada coincide, queda *Not matched* y se asigna a mano en la revisión.

### Seguridad

- **Remitentes.** Sólo se procesan mails de las direcciones de un carrier, o del
  dominio propio del carrier si no es gratuito. El resto queda como `ignored` y nunca
  llega al modelo.
- **IA acotada.** La IA trabaja con un schema cerrado y el prompt aclara que los
  documentos son datos, no instrucciones. Lo que lee es una propuesta: la única
  acción automática es *Accepted* ante un "ACCEPT" corto.
- **Documentos privados.** Están en el bucket privado `carrier-docs` y el navegador los
  abre con links firmados de 2 minutos.

---

## Archivos

| Archivo | Qué es |
|---|---|
| `lib/carriers.mjs` (`src/carrierData.js`) | Cuentas, saldos, alertas, textos de mail y WhatsApp, vinculación, schema de lectura. Tests: `scripts/test-carrier-data.mjs`. |
| `lib/carrierMail.mjs` | La puerta del script: salida, ack, mensaje nuevo, finalize. Tests: `scripts/test-carrier-mail.mjs`. |
| `api/agent-hub.mjs` (`action=carrier_mail`) | La ruta (`/api/carrier-mail` en `vercel.json`). No suma una función nueva. |
| `scripts/carrier-dispatch.gs` | El script de Google de la casilla. |
| `lib/carriersSql.mjs`, `scripts/setup-carriers.mjs` | La migración. |
| `src/carriers.jsx` | La sección Carriers, la tarjeta del job y el modal de despacho, con el PDF. |

## Lo que viene (fases 2 y 3)

- Un portal del carrier: un link para aceptar el rate y subir los docs desde el celular.
- Cruce automático de los pagos de carriers con Bancos.
- WhatsApp automático por la API de WATI.
- La lista de carriers del Pipeline ("Offer to carrier") alimentada desde esta tabla.
