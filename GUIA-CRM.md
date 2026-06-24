# 📦 No Borders Moving — Guía del CRM de Operaciones

Bienvenido/a. Esta guía te explica cómo usar el sistema en el día a día. Está pensada para que en 10 minutos puedas operar sin dudas. Cualquier cosa que cargues se actualiza **en vivo** para todos al instante (no hace falta recargar la página).

---

## 1. Cómo entrar

1. Abrí el link del sistema en el navegador (Chrome de la compu o el celu).
2. Iniciá sesión con tu **email y contraseña**. Si no tenés cuenta, pedísela al encargado.
3. Listo. Vas a entrar directo a la pantalla de **Dispatching**.

---

## 2. El menú de la izquierda

Todo se navega desde la barra lateral. Está dividida en tres bloques:

**OPERATIONS**
- **🚚 Dispatching** — el tablero principal del día (pickups, deliveries, estado de cada job). **Acá vas a estar el 80% del tiempo.**
- **📦 Storage** — las unidades alquiladas y los warehouses propios (Indiana / New Jersey).
- **📋 Jobs** — todos los trabajos con su detalle completo (activos y entregados).
- **🤝 Brokers** — los brokers (Allied, Atlas, Mayflower, etc.) y lo que se les debe.

**FLEET**
- **🧑‍✈️ Drivers** — lista de choferes y cuántos jobs tiene cada uno.
- **🚛 Trucks** — (próximamente).

**BUSINESS**
- **💵 Billing** — el cobro mensual de storage a los clientes.
- **📊 Analytics** — gráficos y recomendaciones con IA.
- **⚙️ Settings** — configuración y datos de la cuenta.

> Si al lado de **Dispatching** ves un número rojo, son jobs que necesitan tu atención hoy.

---

## 3. Dispatching (el tablero del día)

Es la pantalla más importante. De arriba hacia abajo:

### 3.1 Barra de métricas
Te dice el pulso del día de un vistazo:
- **Pickups hoy** / **Deliveries hoy** — cuántos hay que levantar o entregar hoy.
- **FADD overdue** (rojo) — jobs con la fecha de entrega ya vencida.
- **FADD esta semana** (naranja) — entregas que vencen dentro de 7 días.
- **En storage** — cuántos jobs están guardados.
- **Balance pickup / delivery pendiente** (verde) — plata por cobrar al levantar y al entregar.
- **Billing overdue** (rojo) — cobros de storage vencidos.

### 3.2 Banner de alerta (rojo)
Si aparece arriba en rojo, son jobs urgentes: **FADD vencido** o un pickup/delivery de **hoy sin chofer asignado**. Tocá el chip para abrir el job. Lo podés cerrar con la **×**.

### 3.3 Sub-pestañas de la tabla
- **Todos** — todo lo activo.
- **Pick ups hoy** — solo los que se levantan hoy.
- **Deliveries hoy** — solo los que se entregan hoy.
- **En storage** — lo que está guardado.
- **Sin FADD** — jobs a los que les falta cargar la fecha de entrega (¡completalos!).

### 3.4 Las columnas (qué significa cada una)
- **Estado** — en qué etapa está el job (ver punto 3.6).
- **Job #** — número del trabajo. Tocalo para abrir el detalle completo.
- **Tipo** — Full / Direct / Broker (ver punto 4.1).
- **Broker** — la empresa para la que se hace el trabajo (o "—" si es cliente directo).
- **Cliente** — nombre del cliente.
- **FADD** — fecha en que se puede entregar, **con colores** (ver punto 3.5).
- **Pickup** — fecha + dirección de dónde se levanta.
- **Delivery** — fecha + dirección de dónde se entrega.
- **CF** — volumen en pies cúbicos.
- **Sticker** — color del sticker + número de lote.
- **Driver** — chofer asignado.
- **Bal. pickup / Bal. delivery** — plata a cobrar en cada etapa.
- **Storage** — dónde está guardado (empresa + unidad, o warehouse).

### 3.5 FADD y sus colores
**FADD = First Available Delivery Date** (primera fecha posible de entrega). Manda la urgencia:
- 🔴 **Rojo / Overdue** — ya venció. Prioridad máxima.
- 🟠 **Naranja** — vence en 3 días o menos.
- 🟡 **Amarillo** — vence en 7 días o menos.
- 🟢 **Verde** — 8 días o más, tranquilo.
- ⚪ **"No FADD"** — falta cargar la fecha. Tocá el botón **"+ FADD"** en la fila para cargarla rápido.

### 3.6 Los 3 botones de acción (a la derecha de cada fila)
- **🗺️ Ruta** — abre Google Maps con la ruta del storage al cliente.
- **💬 WhatsApp** — abre WhatsApp con un mensaje **ya armado** (job, cliente, broker, pickup, delivery, FADD, volumen, sticker, storage y balances). Solo elegís el contacto del chofer y enviás.
- **→ (Avanzar)** — mueve el job a la **siguiente etapa**. El botón te dice a cuál (ej: "→ Picked up").

### 3.7 El flujo de estados (muy importante)
Cada vez que tocás **Avanzar**, el job avanza así:

```
Scheduled  →  Picked up  →  In storage  →  Out for delivery  →  Delivered
                          (solo si es Full)
```

- **Full**: Scheduled → Picked up → In storage → Out for delivery → Delivered
- **Direct / Broker**: Scheduled → Picked up → Out for delivery → Delivered (no pasa por storage)

Cuando lo marcás **Delivered**, sale automáticamente de las listas de activos.

---

## 4. Cargar y editar un trabajo (Job)

Para crear uno nuevo, tocá **"+ Nuevo job"** (arriba a la derecha en Dispatching o Jobs).

### 4.1 Los 3 tipos de job
- **Full** — pickup → **storage** → delivery (se guarda en el medio).
- **Direct** — pickup → delivery (directo, sin guardar).
- **Broker delivery** — solo delivery (la mercadería ya está, solo se entrega).

### 4.2 Campos del formulario
1. **Dónde se guarda** — tildá una o varias unidades alquiladas y/o warehouses (un job puede ocupar varios lugares).
2. **Datos del job** — Job #, Cliente, Tipo, Estado, Broker, Driver, FADD, Volumen (CF), Lot #, Color de sticker, Date in.
3. **Pickup** — fecha, dirección, ciudad, estado, zip y **balance a cobrar en pickup**.
4. **Delivery** — fecha, dirección, ciudad, estado, zip y **balance a cobrar en delivery**.
5. **Billing de storage** (ver punto 7) — si al cliente se le cobra por guardar.

> **Editar después:** tocá el **Job #** para abrir el detalle. Podés **hacer clic en casi cualquier dato para editarlo en el momento** (FADD, cliente, driver, direcciones, balances, etc.). También está el botón **Editar** para abrir el formulario completo.

---

## 5. Storage (unidades y warehouses)

La sección **Storage** tiene una pestaña por lugar:

### 5.1 Storage Units (unidades alquiladas)
Adentro hay dos sub-pestañas:
- **Unidades** — la lista de los lockers físicos (empresa, dirección, unidad, gate code, vencimiento de pago, etc.) con una barra de **ocupación** (CF usado vs. capacidad). Si una unidad no tiene capacidad cargada, tocá **"Set capacity"**.
- **Jobs en unidades** — qué trabajo está guardado en cada unidad (una fila por unidad). Útil para saber **qué hay adentro de cada locker**.

> **Gate code:** en la lista de unidades hay un botón para **copiar el gate code** con un clic.

### 5.2 Warehouses propios (🏭 Indiana / 🏭 New Jersey)
Cada warehouse tiene su pestaña con:
- **Barra de ocupación** grande (% usado, CF usado / libre / total). Verde <70%, ámbar 70-90%, rojo >90%.
- **Editar capacidad** — cargá los pies cúbicos totales del warehouse.
- **+ Job a este warehouse** — agregar un trabajo directo a ese depósito.
- **Tabla de jobs** adentro: Job #, Cliente, Lot #, Sticker, Volumen, Driver, FADD y Estado.

### 5.3 Cargar una unidad nueva
Tocá **"+ Unidad"** (arriba a la derecha). También podés **importar desde WhatsApp** pegando el mensaje o subiendo el .zip del chat.

---

## 6. Brokers

Lista de los brokers con contacto, teléfono y email. Por cada uno ves **cuántos jobs** tiene y el **balance pendiente** total. Podés **agregar, editar o eliminar** brokers con los botones. Al cargar un job, elegís el broker de la lista desplegable.

---

## 7. Billing (cobro de storage al cliente)

Algunos clientes pagan un mensual por guardar la mercadería (se negocia caso por caso). El sistema lo maneja solo:

### 7.1 Activarlo en el job
En el formulario del job, sección **Billing de storage**:
- Tildá **"Cobrar a este cliente por guardar"**.
- Cargá la **tarifa mensual** ($).
- Elegí si el **primer mes es gratis** (Sí/No).
- La **fecha de inicio** se calcula sola (con mes gratis = date in + 30 días), pero la podés editar.

### 7.2 La página Billing
- **Métricas:** Total pendiente, Overdue (vencidos), Vence esta semana, Cobrado este mes.
- **Pestañas:** Todos / Pendientes / Overdue / Pagados.
- El sistema **genera solo** el cobro de cada ciclo de 30 días y marca como **overdue** los que se pasan de fecha.
- Por cada cobro: **Marcar pagado** (registra la fecha) y **💬 Recordatorio** (abre WhatsApp con un mensaje al cliente listo para enviar).

---

## 8. Drivers

Lista de choferes. Se cargan **solos** a medida que los asignás en los jobs. Ves cuántos jobs activos y entregados tiene cada uno.

---

## 9. Analytics

Gráficos de la operación (aperturas por mes, costos por empresa/estado, etc.) y un botón **"Analizar con IA"** que te da recomendaciones automáticas para mejorar y bajar costos.

---

## 10. Tips importantes

- ✅ **Todo es en vivo:** si un compañero carga algo, lo ves al toque sin recargar.
- 🔎 **Buscador:** en cada lista podés buscar por job #, cliente, driver, dirección, etc.
- 🎯 **Regla de oro del día:** mirá **Dispatching → FADD en rojo/naranja primero**, y que ningún pickup/delivery de hoy quede **sin chofer**.
- 📲 **Avisar al chofer** siempre con el botón **WhatsApp** del job (ya va con todos los datos).
- 🔄 **Avanzá el estado** apenas pasa cada etapa (levantado, guardado, en camino, entregado). Así el tablero refleja la realidad.

---

## 11. Glosario rápido

| Término | Qué significa |
|---|---|
| **FADD** | First Available Delivery Date — primera fecha posible de entrega. |
| **CF** | Cubic Feet — volumen en pies cúbicos. |
| **Lot #** | Número de lote del sticker de la mercadería. |
| **Sticker** | Color/etiqueta que identifica la carga. |
| **Full / Direct / Broker** | Tipos de job (con storage / directo / solo entrega). |
| **Broker** | Empresa para la que se hace el trabajo (Allied, Atlas, etc.). |
| **Balance** | Plata a cobrar (en el pickup o en el delivery). |
| **Billing** | Cobro mensual al cliente por guardar su mercadería. |
| **Gate code** | Código para entrar a la unidad de storage. |

---

*Cualquier duda, escribile al encargado. ¡A despachar! 🚚*
