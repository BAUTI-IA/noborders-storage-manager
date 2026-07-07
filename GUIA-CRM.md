# 📦 No Borders Moving — Guía del CRM de Operaciones

Bienvenido/a. Esta guía te explica cómo usar el sistema en el día a día. **Todo lo que cargás se actualiza en vivo para todos al instante** — no hace falta recargar la página.

> 💡 Consejo: leé primero las secciones **2 (Menú)**, **3 (Dispatching)** y **4 (Jobs)**. Con eso ya manejás el 80% del día. El resto lo consultás cuando lo necesites.

---

## 1. Cómo entrar y tu cuenta

1. Abrí el link del sistema en el navegador (Chrome de la compu o el celu).
2. Iniciá sesión con tu **email y contraseña**. La cuenta te la crea el encargado por invitación (te llega un mail).
3. Entrás directo a la pantalla de **Dispatching**.

**Permisos:** cada usuario tiene permisos por sección (**ver / editar / crear**). Si no ves un módulo o un botón, es porque tu cuenta no tiene ese permiso — pedíselo al encargado.

**Idioma:** en **Settings** podés elegir **🇺🇸 English** o **🇪🇸 Español** y cambiar tu nombre. El cambio de idioma es instantáneo para toda la app.

---

## 2. El menú de la izquierda

Todo se navega desde la barra lateral, dividida en cuatro bloques:

**OPERATIONS**
- **🚚 Dispatching** — el tablero principal del día. **Acá vas a estar la mayor parte del tiempo.**
- **📅 Calendar** — los pickups y deliveries en vista semanal o mensual.
- **🏬 Storage** — las unidades alquiladas y los warehouses propios (Indiana / New Jersey).
- **💼 Jobs** — todos los trabajos con su detalle completo.
- **💬 Chats** — el chat interno del equipo (grupos y mensajes directos).

**FINANZAS**
- **🏦 Brokers** — los brokers (Allied, Atlas, Mayflower, etc.) y lo que se les debe.
- **🧾 Storage Billing** — el cobro mensual de storage a los clientes.
- **📑 Settlements** — las closing sheets de los broker deliveries.
- **➕ Extras** — extras por job (shuttle, long carry, packing…) y las comisiones de drivers y reps.
- **💰 Payments** — todos los cobros: quién tiene la plata y qué se depositó.
- **👥 Clients** — los clientes y sus trabajos.

**FLEET**
- **🪪 Drivers** — los choferes, sus jobs y la plata que tienen en mano.
- **🚛 Trucks** — la flota de camiones y su capacidad.
- **🛣️ Trips / Live Load** — la carga en vivo de cada camión por viaje, con mapa y sugerencias de IA.

**BUSINESS**
- **📋 Legal & Compliance** — documentos legales de compañías, camiones y drivers, con vencimientos.
- **📊 Analytics** — el dashboard del negocio: rentabilidad, cashflow, brokers y recomendaciones con IA.
- **📄 BOL** — generar y firmar Bills of Lading sobre el PDF de cada compañía.
- **👤 Users** — (solo admins) usuarios, roles y permisos.
- **⚙️ Settings** — tu cuenta: nombre e idioma.

> Si al lado de un módulo ves un **número rojo**, son cosas que necesitan tu atención hoy (ej. FADD vencidos en Dispatching, mensajes sin leer en Chats, documentos vencidos en Compliance).

---

## 3. Dispatching (el tablero del día)

Es la pantalla más importante. De arriba hacia abajo:

### 3.1 Barra de métricas
El pulso del día de un vistazo: **Pickups hoy**, **Deliveries hoy**, **FADD overdue** (rojo), **FADD esta semana** (naranja), **En storage**, **Balance pickup/delivery pendiente** (verde) y **Billing overdue** (rojo).

### 3.2 Banners de alerta
- **Rojo** — jobs urgentes: **FADD vencido** o un pickup/delivery de **hoy sin chofer asignado**. Tocá el chip para abrir el job. Lo cerrás con la **×**.
- **Ámbar (duplicados)** — si el sistema detecta posibles jobs/pagos/storages duplicados, aparece un aviso con el botón **Revisar →**.

### 3.3 Sub-pestañas de la tabla
- **Todos** — todo lo activo.
- **Pick ups hoy** / **Deliveries hoy** — solo los de hoy.
- **En storage** — lo que está guardado.
- **On hold** — jobs en espera.
- **Sin trip asignado** — jobs que todavía no están en ningún viaje (ver punto 12).
- **Sin FADD** — jobs a los que les falta la fecha de entrega (¡completalos!).

Abajo hay un **buscador** (job #, cliente, driver, dirección…) y un filtro por **driver**.

### 3.4 Las columnas
Estado · Job # · Tipo · Broker · Rep · Cliente · FADD · Pickup · Delivery · CF (volumen) · Sticker (color + lote) · Driver · **Trip** (en qué viaje va, o "— Sin asignar —") · Bal. pickup · Bal. delivery · Storage · Acciones. La tabla se ordena por urgencia de FADD.

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
- **🗑 Eliminar** — borra el job (ver punto 19).

### 3.8 El flujo de estados
Cada vez que tocás **Avanzar**, el job avanza así:

```
Scheduled → Picked up → In storage → Out for delivery → Delivered
                       (solo si es Full)
```
- **Full**: pasa por storage. **Direct / Broker**: de Picked up salta directo a Out for delivery.

Cuando lo marcás **Delivered**, sale de las listas de activos.

---

## 4. Cargar y editar un trabajo (Job)

Para crear uno nuevo, tocá **"+ Nuevo job"** (arriba a la derecha en Dispatching, Jobs o Calendario).

### 4.1 Los 3 tipos de job
- **Full** — pickup → **storage** → delivery (se guarda en el medio).
- **Direct** — pickup → delivery (directo).
- **Broker delivery** — solo delivery (la mercadería ya está, solo se entrega).

> El formulario cambia según el tipo: muestra solo los campos que correspondan.

### 4.2 Campos del formulario
1. **Dónde se guarda** — tildá una o varias unidades alquiladas y/o warehouses.
2. **Datos del job** — Job #, Cliente, Tipo, Estado, Broker, Driver (uno o varios), FADD, **Volumen (CF) estimado del broker**, **Real CF (medido al cargar)**, Lot #, Color de sticker, Date in.
3. **Pickup** — fecha (o rango de fechas), dirección, ciudad, estado, zip y **balance a cobrar en pickup**.
4. **Delivery** — fecha, dirección, ciudad, estado, zip y **balance a cobrar en delivery**.
5. **Carrier / BOL** (si es broker delivery) — rate por CF, balance BOL, pads.
6. **Billing de storage** (ver punto 8) — si al cliente se le cobra por guardar.

### 4.3 CF real vs. estimado 📐
El broker manda un **estimado**; cuando el camión carga, medís el volumen real:
- Cargalo en el campo **"Real CF (medido al cargar)"** del formulario, en la fila **"Real CF (medido)"** del detalle, o con el botón rápido **"✏️ CF real"** que aparece en las listas y en los stops de un trip.
- **Toda la ocupación (units, warehouses y camiones) usa el CF real si está cargado**; si no, usa el estimado. En las listas lo ves con ✓ **real** (verde) o *est.* (gris).
- Si lo dejás vacío, vuelve al estimado.

### 4.4 El detalle del job
Tocá el **Job #** para abrirlo. Casi cualquier dato se edita **haciendo clic encima** (FADD, cliente, driver, direcciones, balances…). Además:
- **Botones de arriba:** Editar · **📄 Generate BOL** (salta a BOL con el job ya elegido) · 💬 WhatsApp · → Avanzar estado · 🗑 Eliminar.
- **Calendario:** banner que dice si el job está en el calendario, con botones para agregarlo, editar la fecha de pickup o sacarlo. También un **Calendar status** (color) manual: Active / On hold / Cancelled / Long haul / Delivered.
- **Carrier Settlement:** la closing sheet vinculada (clic para ir a Settlements), carrier fee, balance BOL, cobrado y botón **Record payment**.
- **Extras:** la lista de extras con montos, comisiones y **+ Agregar extra**.
- **Payments:** esperado / cobrado / saldo del job, los extras cobrados y pendientes, la plata **"A cuenta (sin imputar)"** con botón **Asignar**, y **+ Agregar pago**.

---

## 5. Storage (unidades y warehouses)

Pestañas de arriba: **Storage Units**, **🏭 Indiana** y **🏭 New Jersey**. Botones: **Importar WhatsApp**, **+ Unidad** y **+ Job a unidad**.

### 5.1 Storage Units (unidades alquiladas)
Dos sub-pestañas:
- **Unidades** — la lista de lockers (empresa, dirección, unidad, gate code, vencimiento de pago) con barra de **ocupación** (CF usado vs. capacidad; si falta, botón **"Set capacity"**). Hay botón para **copiar el gate code** con un clic, y una vista **🗺️ Mapa** de EE.UU.: tocás un estado y filtra las unidades de ese estado.
- **Jobs en unidades** — qué trabajo está guardado en cada unidad.

**Driver que abre la unit:** a cada unidad le podés asignar el **driver que la abre** (dropdown en el formulario de la unidad; se ve en el detalle como "Driver que abre"). Ojo: es distinto del driver del job.

### 5.2 Warehouses propios (🏭 Indiana / 🏭 New Jersey)
Cada uno con barra de **ocupación** grande (verde <70%, ámbar 70-90%, rojo >90%), botón para **editar capacidad**, **+ Job a este warehouse** y la tabla de jobs adentro (Job #, cliente, lote, sticker, volumen, driver, FADD, estado).

### 5.3 Cargar o importar unidades
**"+ Unidad"** para cargar a mano. O **Importar WhatsApp**: pegás el mensaje del grupo (o subís el .zip del chat exportado), tocás **Previsualizar**, destildás lo que no quieras e **Importás**. Detecta nombre, empresa, size, dirección, unit # y gate code.

---

## 6. Calendario

Vista de **pickups y deliveries** en formato semana o mes. Cada evento tiene color según el **Calendar status** del job y se puede tocar para abrir el job. Útil para ver la carga de trabajo de la semana de un vistazo.

---

## 7. Chats (el mensajero interno) 💬

Un chat estilo Messenger para el equipo. Bandeja a la izquierda, conversación a la derecha.

- **Grupos** (ej. `general`, `dispatch`) — los ve **todo el equipo**.
- **Mensajes directos (DM)** — privados entre vos y un compañero.
- **Nueva conversación:** botón **✏️** arriba de la bandeja → buscás a la persona (DM) o creás un **grupo** con nombre.
- **Activos ahora:** la tira de arriba muestra quién está **online** (puntito verde); tocás el avatar y le escribís directo.
- **No leídos:** cada chat muestra un globito azul con la cantidad; el total aparece en el badge de **Chats** en el menú. Se marca leído al abrir.
- **Enviar:** Enter manda, Shift+Enter hace salto de línea. Podés **borrar tus propios mensajes** (✕ al pasar el mouse). El canal `general` no se puede eliminar.
- Es chat de **texto** (sin adjuntos ni menciones por ahora).

---

## 8. Storage Billing (cobro de storage al cliente)

Algunos clientes pagan un mensual por guardar. El sistema lo maneja solo:

### 8.1 Activarlo en el job
En el formulario, sección **Billing de storage**: tildá **"Cobrar a este cliente por guardar"**, cargá la **tarifa mensual**, elegí si el **primer mes es gratis** (la fecha de inicio se calcula sola).

### 8.2 La página Storage Billing
Métricas (Total pendiente, Overdue, Vence esta semana, Cobrado este mes) y pestañas (Todos / Pendientes / Overdue / Pagados). El sistema **genera solo** el cobro de cada ciclo de 30 días y marca **overdue** los vencidos. Por cada cobro: **Marcar pagado** y **💬 Recordatorio** (WhatsApp al cliente listo para enviar).

---

## 9. Brokers y Clientes

- **Brokers** — lista con contacto, teléfono y email. Por cada uno ves **cuántos jobs** y el **balance pendiente** total. Podés agregar, editar o eliminar. Al cargar un job, elegís el broker de la lista.
- **Clients** — la lista de clientes; tocá uno para ver sus trabajos.

---

## 10. Settlements (closing sheets de broker)

Para los **broker deliveries**: cada closing sheet agrupa jobs de un broker y lleva la cuenta de la plata.

- **Métricas y pestañas** (Open / Settled / Disputed / All).
- Cada sheet muestra: jobs incluidos, CF, **carrier fee**, **BOL cobrado**, pads, costos y el **net settlement** (si el broker te debe o vos le debés).
- En el detalle podés **registrar el cobro del BOL** (monto, método, fecha). Ese cobro se **sincroniza automáticamente con Payments** (ver punto 13) — no se carga la plata dos veces.
- Botón para **exportar la closing sheet a PDF**.

> Los jobs se **vinculan** a la closing sheet desde el detalle del job (sección Carrier Settlement), donde también la podés **mover** a otra sheet abierta.

---

## 11. Extras & Comisiones

Para cobrar y repartir los **extras** de cada job (extra CF, shuttle, long carry, stairs, packing, flight charge, other).

### 11.1 Las dos pestañas
- **🧑‍✈️ Drivers** — agrupado por chofer.
- **👤 Reps / Back office** — agrupado por rep/empleado.

### 11.2 Métricas arriba
Total de extras del mes, comisión de drivers (verde), comisión de reps (azul) y lo que queda para la empresa (ámbar).

### 11.3 Cómo cargar un extra (vista Drivers)
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

### 11.4 Reps / Empleados
Con el botón **"Reps / Empleados"** (arriba) cargás a los reps. Tocando el nombre de un rep ves su **perfil**: comisión por mes e historial completo de extras.

### 11.5 Cargar un extra desde el job
En el detalle del job, sección **Extras** → botón **"+ Agregar extra"**. También se crean solos al **imputar un pago** a un extra nuevo (ver 13.4).

---

## 12. Trips / Live Load (viajes por camión) 🛣️

Un **trip** asigna varios jobs a un camión y muestra la carga en tiempo real.

### 12.1 Arriba de la página
Métricas: **Trips activos**, **CF in transit**, **BOL in transit** ($ a cobrar en ruta) y **Delivered today**. Botones: **✨ Suggest trips (AI)** y **+ Trip**. Vistas: **🗺️ Live map / Active trips / Sin trip / All trips**.

### 12.2 Crear un trip
**"+ Trip"** → número automático (TRIP-001…), elegís **camión**, **driver**, fecha de salida, y **buscás y agregás jobs**. Mientras agregás, una **barra de capacidad** te muestra cuánto CF queda libre (usa el CF real si está medido). Reordenás las paradas con ↑ / ↓. Los trips nuevos arrancan en estado **Loading**; el estado se cambia siempre a mano (**Depart** → in transit, **Complete trip** → completed).

### 12.3 Sugerencias de IA ✨
El botón **✨ Suggest trips (AI)** analiza los jobs disponibles (desde dónde carga realmente cada uno: cliente, unidad o warehouse), los camiones libres y los trips que todavía tienen lugar, y te propone:
- **Trips nuevos** por camión libre y **agregados** a trips en carga, cada uno con su barra de ocupación y un recuadro **"💡 Why this trip"** con el razonamiento.
- Una lista de **jobs sin asignar** con el motivo.

Nada se crea solo: tocás **Review & create / Review & add** y se abre el modal normal del trip para que revises, elijas driver y confirmes.

### 12.4 La tarjeta de cada trip activo
Número (clic abre el detalle), estado, camión + driver + salida, **barra de capacidad** (verde <70%, ámbar 70-90%, rojo >90%), la lista de **stops** y los totales de CF y de plata a cobrar. Botones: **Manage Loads**, **Edit Trip**, **➕ Add stop**, **🗺️ View route**, **💬 Send manifest al driver** y **Depart**.

### 12.5 Stops: jobs + paradas custom
La lista de paradas es **una sola secuencia numerada** que mezcla:
- **Stops de job** — job, cliente, ruta, CF (✓real / est. con botón **✏️ CF real**), sticker, lote, FADD y balance BOL. Acciones: **✅ Mark delivered**, **📦 Drop at storage** (en tránsito) y **🔄 Handoff**.
- **Stops custom (sin job)** — para 🔧 mantenimiento, 🛠️ reparación, 🔍 inspección DOT, ⚖️ báscula, ⛽ combustible, 🛌 descanso, 🅿️ parking, 🚚 equipamiento, 🏢 oficina u 📋 otro. Se agregan con **➕ Add stop** (categoría + dirección y nota opcionales), se editan tocándolos o con **✏️**, se marcan **hechos ✅** y se borran con **✕**.

**Reordenar:** arrastrá con la **manija ⠿**. Al soltar, toda la secuencia (jobs + custom) se renumera 1..N.

### 12.6 Manage Loads (el detalle del viaje)
Además de lo anterior: **➕ Add job** (sumar un job existente), **🔼 Load from storage** (subir al camión un job que estaba guardado), **🆕 Unplanned pickup** (crear un job directo ya arriba del trip), **📦 Drop at storage** (bajar un job a una unidad/warehouse a mitad de viaje) y el **Trip log** con todos los eventos (quién y cuándo). Después de cada cambio, un banner verde ofrece **📲 Send update** al driver por WhatsApp.

Cuando está todo entregado aparece **"✅ All jobs delivered — mark trip as completed?"**; si quedan jobs sin entregar al completar, elegís a qué storage bajan.

### 12.7 Handoff entre drivers 🔄
Para pasar un job (o el trip completo) de un driver a otro: botón **🔄 Handoff** → elegís **qué se traspasa**, **a quién**, el **motivo** (mejor para esta entrega / cambio de camión / disponibilidad / otro) y una nota. El nuevo driver pasa a ser el **principal** del job (la plata en mano y las comisiones lo siguen). Queda registrado en el log del trip y en el historial del job, y el stop muestra la etiqueta 🧑‍✈️ con el nombre.

### 12.8 Live map 🗺️
Mapa de EE.UU. con la última ubicación de cada camión: verde **en movimiento**, rojo **detenido**, gris **sin datos**. A la izquierda, la lista de camiones con hora del último dato y link **Update location** (carga manual, listo para GPS de Verizon).

### 12.9 Manifest por WhatsApp
**💬 Send manifest to driver** arma el mensaje completo: trip, camión, driver, salida, carga total y % de capacidad, total a cobrar y la lista numerada de stops con dirección, FADD, CF, sticker, lote y balance.

---

## 13. Payments (cobros, efectivo y depósitos) 💰

El módulo que controla **toda la plata que entra, quién la tiene físicamente y qué se depositó**. Botones de arriba: **🏦 Bank accounts** y **+ Pago**.

### 13.1 Métricas arriba
Esperado del mes · Recibido (verde) · **En circulación / sin depositar** (rojo, incluye todo lo no depositado de cualquier mes) · Depositado (azul) · Pendiente de cobro (naranja) · CC fees (violeta).

> Los pagos **digitales** (Zelle, Venmo, tarjeta, wire…) se marcan **depositados automáticamente**. El **cash, cheques y money orders** quedan "en circulación" hasta que los deposites.

### 13.2 Alerta roja
Lista los pagos **recibidos pero NO depositados hace más de 7 días**: job, monto, método, **quién lo tiene** y los días que pasaron. ¡Esos hay que depositarlos!

### 13.3 Cargar un pago ("+ Pago")
- **Job** (lo buscás por número o cliente), fecha, **monto**, **concepto** (Job / Extra / CC Fee / Storage / **A cuenta** / Other), **descuento** + razón, **etapa** (At pick up / At delivery / Other).
- **Método**: cash, credit card, Zelle, Venmo, check, money order, PayPal, Cash App, wire, Apple Pay.
  - **Cheque**: tipo (cashier / personal / official), número de serie (avisa si está **duplicado**), banco, fecha y **foto del cheque**.
  - **Money order**: tipo (USPS / Western Union / MoneyGram / otro), serie, oficina y foto.
  - **Tarjeta**: opción de **cobrar el CC fee al cliente** (3% por defecto) — crea solo el pago del fee.
- **Recibido** (por quién y fecha). Si es físico: **¿quién tiene la plata?** (se autocompleta con el driver del job) y si ya se **depositó** (fecha + cuenta de banco).

### 13.4 Imputación por cargo ("✂️ Asignar a cargos") ✂️
Al cargar un pago de un job con saldos, podés **repartirlo entre los cargos**: el **balance del job** y cada **extra pendiente**, línea por línea. Cada línea muestra **"Pendiente: $X"** y el **restante** después de tu asignación. Lo que no asignás queda **"A cuenta"** (recibido pero sin aplicar). Con **+ Nuevo extra / otra línea** creás un cargo nuevo en el momento (y su comisión). Después, un pago a cuenta se aplica con el botón **Asignar** (en la tabla o en el detalle del job).

### 13.5 Vista "En circulación" (clave para el cash flow)
Agrupa la plata **por persona que la tiene**: total en mano, desglose (cash / cheques / money orders) y el detalle por job con los **días** que la tiene. Botones:
- **💬 Pedir depósito** — WhatsApp ya armado pidiéndole que deposite.
- **Depósito en lote:** tildá los pagos (o **Select all**), elegí **cuenta de banco** y fecha, y tocá **✓ Deposit N · $total** — se marcan todos depositados de una.

### 13.6 Cuentas de banco 🏦
Con **Bank accounts** administrás las cuentas (nombre, banco, tipo, últimos 4 dígitos, activa/inactiva). Las cuentas con pagos asociados no se pueden borrar — se desactivan.

### 13.7 Cash flow semanal (abajo)
Esperado, recibido, en circulación y depositado de la semana, más una **proyección** de cuánto habría depositado si se deposita todo lo que está en circulación.

### 13.8 Pagos desde el job
En el detalle del job, sección **Pagos**: ves esperado / recibido / saldo, el listado de pagos y **"+ Agregar pago"** (viene pre-cargado con el saldo y el driver).

> 🔄 **Sincronización automática:** registrar un cobro en **Settlements** crea/actualiza el pago en **Payments**, y viceversa. No se carga la plata dos veces.

---

## 14. Drivers y Trucks

- **Drivers** — lista de choferes (se cargan solos a medida que los asignás). Tocá uno para ver su **perfil**: plata **en circulación** (cash/cheques/money orders sin depositar), historial de pagos y depósitos, e historial de jobs.
- **Trucks** — la flota (nombre, patente, **capacidad en CF**) y la **ocupación actual** de cada camión si está en un trip.

---

## 15. BOL (Bill of Lading) 📄

Genera el BOL de cada job **sobre el PDF real de cada compañía** y maneja la firma del cliente. La pantalla principal lista los **templates** y tiene los botones **Documents**, **Generate BOL** y **+ New template**.

### 15.1 Templates (se arma una vez por compañía)
**+ New template** → nombre de la compañía → **Upload template PDF** (el formulario en blanco del broker/carrier). Después ubicás los campos sobre el PDF:
- **✨ Auto-detect (AI)** los coloca solo (editable después), o **+ Add field** para ponerlos a mano (arrastrás y estirás cada cajita).
- Cada campo se mapea a un dato del job (cliente, direcciones, fechas, cargos…), puede ser **fijo** o **preguntar al generar**, y hay tipos especiales: **checkbox**, texto fijo, servicio con nombre propio.
- Podés marcar cajas como **Firma / Inicial / Fecha** de **pickup** o **delivery** — esas se convierten en campos de firma de DocuSign.
- Guardás con **Save draft** o **Save & activate** (solo los activos se pueden usar).

### 15.2 Generar el BOL de un job
Desde el botón **Generate BOL** o directo desde el **detalle del job** (📄 Generate BOL). Pantalla partida: formulario a la izquierda, **vista previa del PDF en vivo** a la derecha.
- Elegís template y job (los datos se cargan solos, todo editable).
- **Calculadora de cargos**: base CF, rate/CF, fuel (% o $), **+ Extra CF**, **+ Charge**, **+ Discount**, servicios del template y checkboxes. Totales en vivo: grand total, deposit, **balance due** y el reparto **due at pickup / due at delivery** (editable).
- **✎ Add text on PDF**: tocás en cualquier lado del PDF y escribís — para agregar algo que el template no tiene, sin editar el template.
- **⬇ Download** para bajarlo, **Save draft** o **Save as final**. Los BOL guardados van a **Documents**, en la carpeta del broker del job.

### 15.3 Firma del cliente ✍️
Desde **Documents**, cada BOL muestra su estado de firma: *Generated → Pickup sent → Pickup signed → Delivery sent → Delivery signed → Completed ✓*.
- **Firmar pickup** — ingresás el **email del cliente** y le llega el mail de **DocuSign** para firmar. La copia firmada vuelve sola al sistema.
- **Firmar delivery** — una vez firmado el pickup, se manda la firma de delivery **sobre el documento que ya muestra la firma del pickup**.
- Si editás un BOL con pickup ya firmado, se guarda una **nueva versión que hereda la firma** (la copia firmada original queda archivada) y queda lista para firmar en delivery.
- Las copias firmadas se ven con los botones **PU ✍** y **DEL ✍**.

### 15.4 Documents (el archivo legal)
Carpetas 📁 **por broker** (+ "All BOLs" y "No broker"), buscador por cliente / job / compañía, y por cada BOL: **View**, **Reopen** (volver a abrirlo en el generador), firmar y **Delete** (con confirmación).

---

## 16. Legal & Compliance 📋

Los documentos legales de **Companies** (tus LLC/carriers), **Trucks** y **Drivers**, con control de vencimientos. El badge rojo del menú cuenta los documentos vencidos o que vencen en ≤7 días.

- **Métricas:** compañías activas, documentos vencidos (rojo), por vencer en 30 días (ámbar) y al día (verde). Banner rojo con el detalle de lo urgente.
- **Pestañas:** Companies · Trucks · Drivers · All documents.
- Cada compañía/camión/driver es una tarjeta con una **celda por tipo de documento** (Insurance, DOT, MC Authority, IFTA, IRP, W-9… / Registration, inspección anual… / CDL, medical card, MVR, drug test…). Cada celda muestra número y **"Vence [fecha] (N días)"**, y le podés **arrastrar la foto o el PDF** encima para subirlo.
- **Estados automáticos:** 🟢 al día (>30 días) · 🟠 por vencer (≤30) · 🔴 vencido · ⚪ sin fecha.
- **+ Company** y **+ Document** para cargar. **All documents** es la tabla completa con filtros por entidad, estado y ventana de vencimiento (≤7/30/60/90 días).

> Los camiones y drivers no se crean acá (vienen de Trucks y de los jobs); acá solo se cargan **sus documentos**.

---

## 17. Analytics (el dashboard del negocio) 📊

Arriba de todo: **período** (Este mes / 3M / 6M / 12M / YTD / Todo) y filtros por **estado** y **broker** (también se activan tocando el mapa o las barras). Cuatro pestañas:

- **Resumen** — KPIs con tendencia (cobrado, revenue neto después de brokers, jobs nuevos, CF movidos, margen de storage, por cobrar), la tarjeta de **Alertas** ("dónde estás perdiendo plata hoy": unidades con margen negativo, costo de vacantes, deuda >60 días, FADD vencidos…), cobrado por mes, jobs nuevos vs. entregados y ocupación de unidades. Abajo, el panel de IA con el botón **"Analizar con IA"**: manda la foto actual del dashboard y devuelve 4–6 recomendaciones concretas.
- **Rentabilidad Storage** — cuánto **pagás** por los storages vs. cuánto **cobrás**: margen por mes, **mapa de EE.UU.** por estado (rojo pierde / verde gana, clic filtra todo), margen y costo por empresa, **sangría de vacantes** (unidades alquiladas vacías) y la tabla **P&L por unidad** (pagás/mes, cobrás/mes, margen/mes; clic en una fila muestra los jobs adentro). Si a una unidad le falta el costo mensual, avisa "sin costo ⚠".
- **Revenue & Cashflow** — cobrado vs. pendiente, revenue neto vs. share de brokers, **antigüedad de deuda (AR aging)** (clic en una barra lista quién debe), $/CF y estadía promedio en storage.
- **Brokers & Operación** — ranking de brokers (jobs, bruto, share, neto, $/job, $/CF), **cumplimiento de FADD**, CF movidos por mes, top drivers y jobs por estado.

---

## 18. Users y Settings

- **Users** (solo admins) — invitar usuarios por email, rol **Admin** (acceso total) o **Member** con permisos **por sección** (ver/editar/crear, con "Select all" / "Clear"), editar, **activar/desactivar**, mandar **reset de contraseña** y eliminar cuentas desactivadas.
- **Settings** — tu cuenta: **nombre**, **idioma** (English/Español) y cerrar sesión.

---

## 19. Eliminar un job 🗑

Podés borrar un job desde el **detalle del job**, la lista de **Jobs** o **Dispatching** (ícono 🗑). Siempre pide **confirmación**. Al confirmar, borra el job y **limpia todo lo relacionado** (extras, pagos, lo desvincula de la closing sheet). ⚠️ **No se puede deshacer.**

---

## 20. Tips importantes

- ✅ **Todo es en vivo:** si un compañero carga algo, lo ves al toque sin recargar.
- 🔎 **Buscador:** en cada lista buscás por job #, cliente, driver, dirección, etc.
- 🎯 **Regla de oro del día:** mirá **Dispatching → FADD en rojo/naranja primero**, que ningún pickup/delivery de hoy quede **sin chofer**, y revisá las etiquetas 🟥 **Sin cobrar**.
- 💰 **Plata:** revisá la **alerta roja de Payments** (cash sin depositar +7 días) y la vista **En circulación**.
- 📐 **Medí el CF real** al cargar el camión — la ocupación de units, warehouses y trucks se calcula con eso.
- 📲 **Avisá al chofer** siempre con el botón **WhatsApp** (ya va con todos los datos o el manifest del trip).
- ✍️ **BOL firmado = job protegido:** generá el BOL desde el job y mandá la firma del pickup antes de cargar.
- 🔄 **Avanzá el estado** apenas pasa cada etapa. Así el tablero refleja la realidad.
- 📋 **Compliance:** si el badge rojo aparece, hay documentos vencidos o por vencer — no dejes que un camión salga con papeles vencidos.

---

## 21. Glosario rápido

| Término | Qué significa |
|---|---|
| **FADD** | First Available Delivery Date — primera fecha posible de entrega. |
| **CF** | Cubic Feet — volumen en pies cúbicos. |
| **Real CF** | El volumen medido al cargar (le gana al estimado del broker). |
| **Lot #** | Número de lote del sticker de la mercadería. |
| **Full / Direct / Broker** | Tipos de job (con storage / directo / solo entrega). |
| **Broker** | Empresa para la que se hace el trabajo (Allied, Atlas, etc.). |
| **Balance** | Plata a cobrar (en el pickup o en el delivery). |
| **BOL** | Bill of Lading — el documento del envío que firma el cliente. |
| **Closing sheet / Settlement** | Liquidación de un broker (lo que te debe o le debés). |
| **Extra** | Cargo adicional de un job (shuttle, long carry, packing…). |
| **Rep** | Empleado/vendedor interno que participa de un job. |
| **Comisión** | Lo que se lleva el driver o el rep de un extra. |
| **Trip / Live Load** | Viaje de un camión con varios jobs y su carga en vivo. |
| **Stop custom** | Parada del trip que no es un job (combustible, inspección…). |
| **Handoff** | Traspaso de un job (o trip) de un driver a otro, con motivo. |
| **En circulación** | Plata cobrada que alguien tiene en mano y todavía no depositó. |
| **A cuenta** | Pago recibido que todavía no se aplicó a ningún cargo. |
| **Imputar / Asignar** | Repartir un pago entre el balance del job y los extras. |
| **Banked / Depositado** | Plata que ya entró al banco. |
| **Billing** | Cobro mensual al cliente por guardar su mercadería. |
| **Gate code** | Código para entrar a la unidad de storage. |
| **DocuSign** | El servicio con el que el cliente firma el BOL desde su email. |

---

*Cualquier duda, escribile al encargado… o preguntá en el canal `general` de Chats. ¡A despachar! 🚚*
