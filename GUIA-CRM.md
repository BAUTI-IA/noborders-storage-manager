# 📦 No Borders Moving — Guía del CRM de Operaciones

Bienvenido/a. Esta guía te explica cómo usar el sistema en el día a día. En 15 minutos vas a poder operar sin dudas. **Todo lo que cargás se actualiza en vivo para todos al instante** — no hace falta recargar la página.

> 💡 Consejo: leé primero las secciones **2 (Menú)**, **3 (Dispatching)** y **4 (Jobs)**. Con eso ya manejás el 80% del día. El resto lo consultás cuando lo necesites.

---

## 1. Cómo entrar

1. Abrí el link del sistema en el navegador (Chrome de la compu o el celu).
2. Iniciá sesión con tu **email y contraseña**. Si no tenés cuenta, pedísela al encargado.
3. Listo. Entrás directo a la pantalla de **Dispatching**.

---

## 2. El menú de la izquierda

Todo se navega desde la barra lateral, dividida en cuatro bloques:

**OPERATIONS**
- **🚚 Dispatching** — el tablero principal del día. **Acá vas a estar la mayor parte del tiempo.**
- **📅 Calendario** — los pickups y deliveries en vista semanal o mensual.
- **🏬 Storage** — las unidades alquiladas y los warehouses propios (Indiana / New Jersey).
- **💼 Jobs** — todos los trabajos con su detalle completo.

**FINANZAS**
- **🏦 Brokers** — los brokers (Allied, Atlas, Mayflower, etc.) y lo que se les debe.
- **🧾 Billing** — el cobro mensual de storage a los clientes.
- **📑 Settlements** — las closing sheets de los broker deliveries.
- **🤝 Carriers** — los jobs que le damos a carriers externos y lo que nos debe (o le debemos a) cada uno.
- **➕ Extras** — extras por job (shuttle, long carry, packing…) y las comisiones de drivers y reps.
- **💰 Payments** — todos los cobros: quién tiene la plata y qué se depositó.
- **👥 Clientes** — los clientes y sus trabajos.

**FLEET**
- **🪪 Drivers** — los choferes, sus jobs y la plata que tienen en mano.
- **🚛 Trucks** — la flota de camiones y su capacidad.
- **🛣️ Trips / Live Load** — la carga en vivo de cada camión por viaje.

**BUSINESS**
- **📊 Analytics** — gráficos y recomendaciones con IA.
- **⚙️ Settings** — configuración de la cuenta.

> Si al lado de un módulo ves un **número rojo**, son cosas que necesitan tu atención hoy (ej. FADD vencidos en Dispatching, trips activos en Trips).

---

## 3. Dispatching (el tablero del día)

Es la pantalla más importante. De arriba hacia abajo:

### 3.1 Barra de métricas
El pulso del día de un vistazo: **Pickups hoy**, **Deliveries hoy**, **FADD overdue** (rojo), **FADD esta semana** (naranja), **En storage**, **Balance pickup/delivery pendiente** (verde) y **Billing overdue** (rojo).

### 3.2 Banner de alerta (rojo)
Si aparece arriba en rojo, son jobs urgentes: **FADD vencido** o un pickup/delivery de **hoy sin chofer asignado**. Tocá el chip para abrir el job. Lo cerrás con la **×**.

### 3.3 Sub-pestañas de la tabla
- **Todos** — todo lo activo.
- **Pick ups hoy** / **Deliveries hoy** — solo los de hoy.
- **En storage** — lo que está guardado.
- **On hold** — jobs en espera.
- **Sin trip asignado** — jobs que todavía no están en ningún viaje (ver punto 11).
- **Sin FADD** — jobs a los que les falta la fecha de entrega (¡completalos!).

### 3.4 Las columnas
Estado · Job # · Tipo · Broker · Rep · Cliente · FADD · Pickup · Delivery · CF (volumen) · Sticker (color + lote) · Driver · **Trip** (en qué viaje va, o "— Sin asignar —") · Bal. pickup · Bal. delivery · Storage · Acciones.

### 3.5 Las etiquetas de colores al lado del Job #
- ⚠️ — le falta el sticker.
- 🟧 **Cobro pendiente** — broker delivery entregado con BOL sin cobrar.
- 🟪 **Extras** — el job tiene extras cargados.
- 🟧 **Balance pendiente** — todavía hay plata por cobrar.
- 🟥 **Sin cobrar** — el job está **entregado pero no se cobró todo**. ¡Prioridad!

### 3.6 FADD y sus colores
**FADD = First Available Delivery Date** (primera fecha posible de entrega). Manda la urgencia:
- 🔴 **Rojo / Overdue** — ya venció. Prioridad máxima.
- 🟠 **Naranja** — vence en 3 días o menos.
- 🟡 **Amarillo** — vence en 7 días o menos.
- 🟢 **Verde** — 8 días o más, tranquilo.
- ⚪ **"No FADD"** — falta cargarla. Usá el botón **"+ FADD"** de la fila.

### 3.7 Los botones de acción (a la derecha de cada fila)
- **🗺️ Ruta** — abre Google Maps del storage al cliente.
- **💬 WhatsApp** — abre WhatsApp con un mensaje **ya armado** (job, cliente, broker, pickup, delivery, FADD, volumen, sticker, storage y balances). Si el job está en un trip, manda el **manifest completo del viaje**. Solo elegís el contacto y enviás.
- **→ (Avanzar)** — mueve el job a la **siguiente etapa** (el botón te dice a cuál).
- **🗑 Eliminar** — borra el job (ver punto 14).

### 3.8 El flujo de estados
Cada vez que tocás **Avanzar**, el job avanza así:

```
Scheduled → Picked up → In storage → Out for delivery → Delivered
                       (solo si es Full)
```
- **Full**: pasa por storage. **Direct / Broker**: no pasa por storage.

Cuando lo marcás **Delivered**, sale de las listas de activos.

---

## 4. Cargar y editar un trabajo (Job)

Para crear uno nuevo, tocá **"+ Nuevo job"** (arriba a la derecha en Dispatching, Jobs o Calendario).

> **¿Un broker te pasó un job por WhatsApp o por teléfono?** Usá **"+ Broker job"** (en Dispatching y en Jobs): es un formulario corto. Pegá el mensaje o la **captura** de WhatsApp (Ctrl+V), tocá **Read and fill in** y la IA completa los campos. Revisás y tocás **Save job**. Para un llamado, llenalo a mano. Ver punto 9.

### 4.1 Los 3 tipos de job
- **Full** — pickup → **storage** → delivery (se guarda en el medio).
- **Direct** — pickup → delivery (directo).
- **Broker delivery** — solo delivery (la mercadería ya está, solo se entrega).

> El formulario cambia según el tipo: muestra solo los campos que correspondan.

### 4.2 Campos del formulario
1. **Dónde se guarda** — tildá una o varias unidades alquiladas y/o warehouses.
2. **Datos del job** — Job #, Cliente, Tipo, Estado, Broker, Driver (uno o varios), FADD, Volumen (CF), Lot #, Color de sticker, Date in.
3. **Pickup** — fecha (o rango de fechas), dirección, ciudad, estado, zip y **balance a cobrar en pickup**.
4. **Delivery** — fecha, dirección, ciudad, estado, zip y **balance a cobrar en delivery**.
5. **Carrier / BOL** (si es broker delivery) — rate por CF, balance BOL, pads.
6. **Billing de storage** (ver punto 7) — si al cliente se le cobra por guardar.

> **Editar después:** tocá el **Job #** para abrir el detalle. Casi cualquier dato se edita **haciendo clic encima** (FADD, cliente, driver, direcciones, balances…). También está el botón **Editar** para el formulario completo.

---

## 5. Storage (unidades y warehouses)

### 5.1 Storage Units (unidades alquiladas)
Dos sub-pestañas:
- **Unidades** — la lista de lockers (empresa, dirección, unidad, gate code, vencimiento de pago) con barra de **ocupación** (CF usado vs. capacidad). Si falta capacidad, tocá **"Set capacity"**. Hay botón para **copiar el gate code** con un clic.
- **Jobs en unidades** — qué trabajo está guardado en cada unidad.

### 5.2 Warehouses propios (🏭 Indiana / 🏭 New Jersey)
Cada uno con barra de **ocupación** grande (verde <70%, ámbar 70-90%, rojo >90%), botón para **editar capacidad**, **+ Job a este warehouse** y la tabla de jobs adentro.

### 5.3 Cargar una unidad nueva
**"+ Unidad"** (arriba a la derecha). También podés **importar desde WhatsApp** pegando el mensaje o subiendo el .zip del chat.

---

## 6. Calendario

Vista de **pickups y deliveries** en formato semana o mes. Cada evento tiene color según el estado y se puede tocar para abrir el job. Útil para ver la carga de trabajo de la semana de un vistazo.

---

## 7. Billing (cobro de storage al cliente)

Algunos clientes pagan un mensual por guardar. El sistema lo maneja solo:

### 7.1 Activarlo en el job
En el formulario, sección **Billing de storage**: tildá **"Cobrar a este cliente por guardar"**, cargá la **tarifa mensual**, elegí si el **primer mes es gratis** (la fecha de inicio se calcula sola).

### 7.2 La página Billing
Métricas (Total pendiente, Overdue, Vence esta semana, Cobrado este mes) y pestañas (Todos / Pendientes / Overdue / Pagados). El sistema **genera solo** el cobro de cada ciclo de 30 días y marca **overdue** los vencidos. Por cada cobro: **Marcar pagado** y **💬 Recordatorio** (WhatsApp al cliente listo para enviar).

---

## 8. Brokers

Lista de brokers con contacto, teléfono y email. Por cada uno ves **cuántos jobs**, el **balance pendiente** de sus jobs y el **Balance** con el broker: lo que falta cobrar (o pagar) de sus closing sheets **después de los pagos**. Si pagó de más, aparece **a cuenta**. Podés agregar, editar o eliminar. Al cargar un job, elegís el broker de la lista.

- En la ficha del broker cargá su **rate por CF** y su **cargo por pad** habituales: se completan solos al cargar un job de ese broker.
- **Statement** — el estado de cuenta del broker: sus sheets y sus pagos con el saldo corrido. Se imprime en PDF para mandárselo.
- **Record broker payment** — registrar un pago del broker (o uno que le hicimos). Ver punto 9.

---

## 9. Settlements (closing sheets de broker)

Para los **broker deliveries**: cada closing sheet agrupa jobs de un broker y lleva la cuenta de la plata.

- **Métricas y pestañas** (Open / Settled / Disputed / All).
- Cada sheet muestra: jobs incluidos, CF, **carrier fee**, **BOL cobrado**, pads, costos y el **net settlement** (si el broker te debe o vos le debés).
- En el detalle podés **registrar el cobro del BOL** (monto, método, fecha). ⚠️ **Importante:** ese cobro ahora se **sincroniza automáticamente con Payments** (ver punto 12).
- Botón para **exportar la closing sheet a PDF**.

> Los jobs se **vinculan** a la closing sheet desde el detalle del job — no se cargan datos dos veces.

### 9.1 Cargar la sheet desde el papel del broker ("✨ From document")
Subís el **PDF o la foto** de la closing sheet que mandó el broker. La IA lee el número de CS, cada línea (job, CF, rate, BOL, pads) y los descuentos, y busca cada job en el CRM. Después ves **lado a lado los números del broker y los del CRM** (lo que no coincide, en naranja), elegís con cuáles quedarte y tocás **Create closing sheet**. **Nada se guarda sin que confirmes.**

### 9.2 Marcar entregados
En el detalle de la sheet, **Mark N delivered** pasa a *delivered* todos los jobs de la sheet que todavía no lo estaban.

### 9.3 Cerrar el saldo ("Record broker payment")
Está en Settlements, en el detalle de una sheet y en Brokers. Cargás monto, método, referencia y si **el broker nos pagó** o **le pagamos**. El pago se **reparte solo entre las sheets abiertas, de la más vieja a la más nueva** (se puede editar); lo que sobra queda **a cuenta**. Una sheet que queda cubierta pasa a **settled** sola, y el detalle muestra cuánto se pagó.

> El **BOL cobrado** de cada job ahora es el **total** de sus pagos (antes un segundo pago parcial pisaba al primero). AP / AR muestra de cada sheet **lo que falta**, no el neto entero.

Más detalle: `docs/broker-settlements.md`.

---

## 10. Extras & Comisiones

Para cobrar y repartir los **extras** de cada job (extra CF, shuttle, long carry, stairs, packing, flight charge, other).

### 10.1 Las dos pestañas
- **🧑‍✈️ Drivers** — agrupado por chofer.
- **👤 Reps / Back office** — agrupado por rep/empleado.

### 10.2 Métricas arriba
Total de extras del mes, comisión de drivers (verde), comisión de reps (azul) y lo que queda para la empresa (ámbar).

### 10.3 Cómo cargar un extra (vista Drivers)
Cada job muestra los **7 tipos de extra como filas**. Para activar uno, **tildá la casilla** y se habilita:
- **Monto** del extra.
- **Driver** que lo generó (se autocompleta con el del job, editable).
- **Generado por**: *Driver only*, *Driver + Rep* o *Rep only*.
- **Rep** (aparece solo si hay rep involucrado).
- **% de comisión** de driver y rep — se autocompletan según las reglas, pero los podés editar.

**Reglas automáticas de comisión:**
- Extra CF / Packing / Flight / Other → Driver only: driver 10%. Driver+Rep: 7% / 3%. Rep only: rep 10%.
- Long carry / Stairs → siempre driver 50% (la empresa se queda el 50%).
- Shuttle → Driver only: 10%. Driver+Rep: 7% / 3%. Rep only: rep 5%.

Abajo de cada chofer hay una fila **TOTAL** y una fila **COMISIÓN** (en amarillo, estilo Excel). Botones **📋 Copiar** y **🖨️ PDF** para mandarle el resumen a cada uno.

### 10.4 Reps / Empleados
Con el botón **"Reps / Empleados"** (arriba) cargás a los reps. Tocando el nombre de un rep ves su **perfil**: comisión por mes e historial completo de extras.

### 10.5 Cargar un extra desde el job
En el detalle del job, sección **Extras** → botón **"+ Agregar extra"**.

---

## 11. Trips / Live Load (carga en vivo por camión)

Un **trip** asigna varios jobs a un camión y muestra la carga en tiempo real.

### 11.1 Crear un trip
**"+ Trip"** → número automático (TRIP-001…), elegís **camión**, **driver**, fecha de salida, y **buscás y agregás jobs**. Mientras agregás, una **barra de capacidad** te muestra cuánto CF queda libre. Reordenás las paradas con ↑ / ↓.

### 11.2 Vista "Active trips"
Una tarjeta por camión activo: nombre + driver, **barra de capacidad** (verde <70%, ámbar 70-90%, rojo >90%), lista de **stops** (arrastrables para reordenar), con job, cliente, ruta, CF, sticker, FADD y balance. Por cada stop: **Mark delivered**. Totales de CF y de plata a cobrar.
- **💬 Enviar manifest al driver** — WhatsApp con la lista completa del viaje.
- **Salir** — marca el trip como "en tránsito".
- Cuando se entregan todos los jobs, el trip pasa solo a **completado**.

### 11.3 Trucks (camiones)
En **Trucks** cargás la flota (nombre, patente, **capacidad en CF**) y ves la **ocupación actual** de cada camión si está en un trip.

---

## 12. Payments (cobros, efectivo y depósitos) 💰

El módulo que controla **toda la plata que entra, quién la tiene físicamente y qué se depositó**.

### 12.1 Métricas arriba
Esperado del mes · Recibido (verde) · **En circulación / sin depositar** (rojo) · Depositado (azul) · Pendiente de cobro (naranja) · CC fees (violeta).

### 12.2 Alerta roja
Lista los pagos **recibidos pero NO depositados hace más de 7 días**: job, monto, método, **quién lo tiene** y los días que pasaron. ¡Esos hay que depositarlos!

### 12.3 Pestañas
Todos / Pendientes / Recibidos / **En circulación** / Depositados.

### 12.4 Cargar un pago ("+ Pago")
- **Job** (lo buscás por número o cliente), fecha, **monto**, **concepto** (Job / Extra / CC Fee / Storage / Other), **método** (cash, check, zelle, venmo, etc.).
- Si es **cheque o money order**: número/ID y tipo (personal / cashier / business).
- **Descuento** + razón (opcional).
- **Etapa del pago**: At pick up / At delivery / Other (solo informativo).
- **Recibido** (por quién y fecha).
- Si es **cash, cheque o money order**: **¿quién tiene la plata?** (se autocompleta con el driver del job) + si ya se **depositó** (fecha + cuenta).
- Si es **digital** (Zelle, Venmo, etc.): se marca **depositado automáticamente**.

### 12.5 Vista "En circulación" (clave para el cash flow)
Agrupa la plata **por persona que la tiene**: total que tiene en mano, desglose (cash / cheques / money orders) y el detalle por job. Botón **💬 Pedir depósito** → WhatsApp ya armado pidiéndole que deposite.

### 12.6 Cash flow semanal (abajo)
Esperado, recibido, en circulación y depositado de la semana, más una **proyección** de cuánto habría depositado si se deposita todo lo que está en circulación.

### 12.7 Pagos desde el job
En el detalle del job, sección **Pagos**: ves esperado / recibido / saldo, el listado de pagos y **"+ Agregar pago"** (viene pre-cargado con el saldo y el driver).

> 🔄 **Sincronización automática:** registrar un cobro en **Settlements** crea/actualiza el pago en **Payments**, y viceversa. No se carga la plata dos veces.

---

## 13. Drivers (choferes)

Lista de choferes (se cargan solos a medida que los asignás). Tocá un chofer para ver su **perfil**:
- **En circulación** — cuánta plata (cash/cheques/money orders) tiene **en mano sin depositar**.
- **Historial de pagos** que recibió y cuándo los depositó.
- **Historial de jobs**.

---

## 14. Eliminar un job 🗑

Podés borrar un job desde:
- El **detalle del job** → botón rojo **"🗑 Eliminar job"**.
- La lista de **Jobs** → ícono 🗑 en la fila.
- **Dispatching** → acción **🗑 Eliminar** en la fila.

Siempre te pide **confirmación** ("¿Seguro que querés eliminar el job …? Esta acción no se puede deshacer."). Al confirmar, borra el job y **limpia todo lo relacionado** (extras, pagos, lo desvincula de la closing sheet). Aparece un cartelito **"Job … eliminado"**. ⚠️ **No se puede deshacer.**

---

## 15. Clientes y Analytics

- **Clientes** — la lista de clientes; tocá uno para ver sus trabajos.
- **Analytics** — gráficos de la operación y un botón **"Analizar con IA"** con recomendaciones automáticas.

---

## 16. Carriers (jobs que le damos a otros carriers) 🤝

Cuando le damos un job a otro carrier, **la orden sale siempre del CRM**.

1. **Despachar** — en el detalle del job, pestaña **Money**, tarjeta **Carrier** → **Dispatch to carrier**. Elegís carrier, rate (por CF o fijo), lo que tiene que cobrarle al cliente y cómo mandarlo: **mail**, **WhatsApp** o los dos. El mail sale desde la casilla `dispatch@` con el **rate confirmation en PDF**. Con el seguro del carrier vencido no se puede despachar.
2. **El carrier responde a ese mail**: "ACCEPT" para aceptar, y al terminar manda el **BOL firmado y el comprobante del cobro**.
3. **El CRM lee la casilla solo**: la IA lee los documentos, los vincula al despacho y avisa por Telegram.
4. **Revisar** — en **Carriers → Docs to review** ves los archivos y lo que leyó la IA (CF final, cobrado, método, firmas). **Approve** → el despacho queda *Verified*, el job pasa a *delivered* y el saldo del cliente queda en cero.
   - ¿Te mandó los papeles por **WhatsApp** o en mano? En la tarjeta **Carrier** del job tocá **Enter result** (Cargar resultado), escribí el CF final y lo que cobró, y queda cerrado igual.
5. **Saldos** — la pestaña **Balances** muestra qué carrier nos debe y a cuál le debemos. Los pagos y ajustes (por ejemplo, un claim) se cargan en **Payments & adjustments**. También aparece en **AP / AR**.

> **La cuenta:** si el carrier cobró más que su rate (rate × CF + sus extras), **nos debe la diferencia**. Si cobró menos, se la debemos nosotros. Lo que cobra el carrier no entra en Payments: esa plata no llega a nuestro banco, sólo el neto.

Para dar de alta un carrier: **Carriers → Carriers → + Carrier** (mails desde los que escribe, WhatsApp, MC/DOT, vencimiento del seguro, rate habitual). Setup y detalle: `docs/carrier-dispatch.md`.

---

## 17. Tips importantes

- ✅ **Todo es en vivo:** si un compañero carga algo, lo ves al toque sin recargar.
- 🔎 **Buscador:** en cada lista buscás por job #, cliente, driver, dirección, etc.
- 🎯 **Regla de oro del día:** mirá **Dispatching → FADD en rojo/naranja primero**, que ningún pickup/delivery de hoy quede **sin chofer**, y revisá las etiquetas 🟥 **Sin cobrar**.
- 💰 **Plata:** revisá la **alerta roja de Payments** (cash sin depositar +7 días) y la vista **En circulación**.
- 📲 **Avisá al chofer** siempre con el botón **WhatsApp** (ya va con todos los datos o el manifest del trip).
- 🔄 **Avanzá el estado** apenas pasa cada etapa. Así el tablero refleja la realidad.

---

## 18. Glosario rápido

| Término | Qué significa |
|---|---|
| **FADD** | First Available Delivery Date — primera fecha posible de entrega. |
| **CF** | Cubic Feet — volumen en pies cúbicos. |
| **Lot #** | Número de lote del sticker de la mercadería. |
| **Full / Direct / Broker** | Tipos de job (con storage / directo / solo entrega). |
| **Broker** | Empresa para la que se hace el trabajo (Allied, Atlas, etc.). |
| **Balance** | Plata a cobrar (en el pickup o en el delivery). |
| **BOL** | Bill of Lading — el cobro del broker delivery. |
| **Closing sheet / Settlement** | Liquidación de un broker (lo que te debe o le debés). |
| **Carrier (externo)** | Otra empresa a la que le damos un job; cobra al cliente y nos liquida la diferencia. |
| **Dispatch / Despacho** | La orden que le mandamos a un carrier externo (D57). |
| **Rate confirmation** | El PDF con el rate y lo que el carrier tiene que cobrar. |
| **A cuenta** | Plata que un broker pagó de más y queda como crédito. |
| **Extra** | Cargo adicional de un job (shuttle, long carry, packing…). |
| **Rep** | Empleado/vendedor interno que participa de un job. |
| **Comisión** | Lo que se lleva el driver o el rep de un extra. |
| **Trip / Live Load** | Viaje de un camión con varios jobs y su carga en vivo. |
| **En circulación** | Plata cobrada que alguien tiene en mano y todavía no depositó. |
| **Banked / Depositado** | Plata que ya entró al banco. |
| **Billing** | Cobro mensual al cliente por guardar su mercadería. |
| **Gate code** | Código para entrar a la unidad de storage. |

---

*Cualquier duda, escribile al encargado. ¡A despachar! 🚚*
