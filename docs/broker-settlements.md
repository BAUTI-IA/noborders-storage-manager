# Brokers — los jobs que nos dan y el saldo con cada uno (somos el carrier)

Allied, Atlas y el resto nos pasan jobs casi siempre por **WhatsApp o por teléfono**.
Después liquidan con una **closing sheet**. El objetivo es cargar rápido, no tipear
dos veces y saber en todo momento cuánto nos debe cada broker.

## Setup (una sola vez)

```
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-broker-settle.mjs
```

La migración agrega:
- `broker_payments`: lo que nos pagó cada broker (o le pagamos), repartido entre sus
  sheets;
- `brokers.default_rate_per_cf` y `default_charge_per_pad`;
- `closing_sheets.document_path`;
- el bucket **privado** `settlement-docs`.

Los permisos son los de la sección **Settlements**.

## 1. Cargar un job de broker: "+ Broker job"

Está en Dispatching y en Jobs. Es un formulario corto:
- broker, job # del broker y cliente;
- dirección de delivery y FADD;
- CF, BOL balance, nuestro rate por CF y pads.

Arriba hay una caja:
- **Pegá el mensaje de WhatsApp**, o directamente **la captura** (Ctrl+V), y tocá
  **Read and fill in**. La IA completa los campos.
- Para un **llamado**, escribí ahí tus notas o llená el formulario a mano.

Al elegir el broker se completa su rate habitual (se carga en la ficha del broker). El
job se guarda como *broker delivery*, sin storage, y se abre el detalle para seguir
cargando lo que haga falta. La IA sólo **prellena**: no se guarda nada hasta tocar
**Save job**.

En el **Pipeline**, "+ New lead" ahora también acepta una captura de WhatsApp.

## 2. La closing sheet: "✨ From document"

En Settlements, subís el PDF o la foto de la closing sheet que mandó el broker.

1. La IA lee:
   - el número de CS, la fecha de carga y cada línea (job, CF, rate, BOL balance,
     cobrado, pads);
   - los descuentos (trip, labor, other fees, cargo por pad).
2. Cada línea se **vincula a un job** del broker que todavía no está en ninguna sheet,
   primero por número de job y si no por apellido.
3. Se muestran **lado a lado los números del broker y los del CRM**. Lo que no coincide
   aparece en naranja.
4. Por cada job elegís con qué números quedarte, y después **Create closing sheet**. El
   papel queda guardado con la sheet.

## 3. Marcar entregados

En el detalle de la sheet, **Mark N delivered** pasa a *delivered* todos los jobs de la
sheet que todavía no lo están. Cada job muestra su marca "delivered".

## 4. Cerrar el saldo

- **Record broker payment** está en Settlements, en el detalle de una sheet y en
  Brokers.
  - Se carga el monto, el método, la referencia y la dirección: *el broker nos pagó* o
    *le pagamos*.
  - El pago se **reparte solo entre las sheets abiertas, de la más vieja a la más
    nueva**, y el reparto se puede editar.
  - Lo que sobra queda **a cuenta** (crédito).
  - La sheet que queda cubierta pasa a *settled* sola.
- **Brokers**: la columna **Balance** es lo que falta después de los pagos, y
  **Statement** abre el estado de cuenta del broker (sheets y pagos con saldo corrido),
  imprimible en PDF.
- **AP / AR**: cada sheet muestra **lo que falta** (no el neto entero). Si se pagó en
  partes, se ve cuánto se pagó.

```
saldo con el broker = Σ lo que falta en cada sheet abierta − pagos a cuenta
lo que falta        = |neto de la sheet| − lo asignado de los pagos        (con el signo del neto)
```

Las sheets que se marcaron *settled* a mano antes de existir los pagos cuentan como
pagadas.

## Arreglo de paso: lo cobrado en las sheets

Antes, `bol_collected` guardaba **sólo el último pago** de un job: un segundo pago
parcial pisaba al primero, y la sheet mostraba de menos lo cobrado (y de más lo que
debía el broker). Ahora:
- guarda el **total** de los pagos recibidos del job;
- la sheet usa la misma regla de "cobrado" que el resto del CRM (`jobCollectedFor`);
- también la usan el PDF de la sheet y la tarjeta del job.

## Archivos

| Archivo | Qué es |
|---|---|
| `lib/brokerSettle.mjs` (`src/brokerSettleData.js`) | Saldo por broker, reparto de pagos, estado de cuenta. Tests: `scripts/test-broker-settle.mjs`. |
| `lib/brokerDocsData.mjs` (`src/brokerDocsData.js`) | Schemas de lectura, broker por nombre, vinculación de líneas con jobs. Tests: `scripts/test-broker-docs.mjs`. |
| `lib/brokerDocs.mjs` | Las llamadas a la IA. |
| `api/trip-suggestions.mjs` | Las acciones `broker_job_extract` y `settlement_extract`. Sólo leen. |
| `src/brokerDesk.jsx` | El job rápido, la sheet desde el documento, el pago del broker y el estado de cuenta. |
| `lib/brokerSettleSql.mjs`, `scripts/setup-broker-settle.mjs` | La migración. |
