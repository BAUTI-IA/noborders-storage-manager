// GENERADO por scripts/build-guide-index.mjs — no editar a mano.
// Fuente: docs/guia-crm.html + docs/crm-guide-en.html, que actualiza el workflow
// semanal .github/workflows/weekly-guide.yml. Regenerar con: npm run guide:index
export const GUIDE = {
  "es": [
    {
      "id": "cover",
      "title": "Operations",
      "text": "No Borders Moving & Storage\n\n## Operations\nCRM\n\nGuía de uso para el equipo\n\n📘 Manual práctico · Dispatching · Storage · Billing\n\nVersión 1.0 · Uso interno\n\nEn 10 minutos operás sin dudas 🚚"
    },
    {
      "id": "intro",
      "title": "› Antes de empezar",
      "text": "## › Antes de empezar\n\nLo esencial para usar el sistema en el día a día.\n\nEste es el sistema con el que gestionamos pickups, deliveries, storage y cobros . Lo importante:\n\n- Todo es en vivo: si un compañero carga o cambia algo, lo ves al instante, sin recargar la página.\n\n- Se usa desde el navegador (computadora o celular). No hay que instalar nada.\n\n- Tu pantalla de trabajo es Dispatching. Ahí vas a estar el 80% del tiempo.\n\n## Contenido\n\n| 1 · Acceso | Cómo entrar al sistema\n\n| 2 · El menú | Las secciones de la barra lateral\n\n| 3 · Dispatching | El tablero del día (lo más importante)\n\n| 4 · Crear un job | Tipos de trabajo y carga de datos\n\n| 5 · Storage | Unidades alquiladas y warehouses\n\n| 6 · Brokers & Drivers | Empresas y choferes\n\n| 7 · Billing | Cobro mensual de storage al cliente\n\n| 8 · Tips + Glosario | Reglas de oro y términos clave"
    },
    {
      "id": "acceso",
      "title": "1 Acceso",
      "text": "## 1 Acceso\n\nIniciar sesión.\n\n- Abrí el link del sistema en el navegador.\n\n- Ingresá con tu email y contraseña (si no tenés cuenta, pedísela al encargado).\n\n- Entrás directo a Dispatching ."
    },
    {
      "id": "menu",
      "title": "2 El menú de la izquierda",
      "text": "## 2 El menú de la izquierda\n\nTodo se navega desde la barra lateral, dividida en tres bloques.\n\n| Sección | Para qué sirve\n\n| 🚚 Dispatching | Tablero del día: pickups, deliveries y estado de cada job. Tu pantalla principal.\n\n| 📦 Storage | Unidades alquiladas y warehouses propios (Indiana / New Jersey) con ocupación.\n\n| 📋 Jobs | Todos los trabajos con detalle completo (activos y entregados).\n\n| 🤝 Brokers | Brokers (Allied, Atlas, Mayflower…) y balance pendiente de cada uno.\n\n| 🧑‍✈️ Drivers | Choferes y cuántos jobs tiene cada uno (se cargan solos).\n\n| 💵 Billing | Cobro mensual de storage a los clientes.\n\n| 📊 Analytics | Gráficos de la operación + recomendaciones con IA."
    },
    {
      "id": "dispatching",
      "title": "3 Dispatching — el tablero del día",
      "text": "## 3 Dispatching — el tablero del día\n\nLa pantalla más importante. De arriba hacia abajo: métricas → alertas → pestañas → tabla.\n\n## Las columnas, una por una\n\n| Columna | Qué muestra\n\n| Estado | Etapa del job (Scheduled → Picked up → In storage → Out for delivery → Delivered).\n\n| Job # | Número del trabajo. Tocalo para abrir el detalle completo.\n\n| Tipo | Full / Direct / Broker (ver sección 4).\n\n| Broker · Cliente | Empresa para la que se trabaja y nombre del cliente.\n\n| FADD | Fecha posible de entrega, con colores según urgencia.\n\n| Pickup · Delivery | Fecha + ciudad de dónde se levanta y dónde se entrega.\n\n| CF · Sticker · Lot | Volumen (pies cúbicos), color de sticker y número de lote.\n\n| Driver | Chofer asignado.\n\n| Bal. pickup / delivery | Plata a cobrar en cada etapa.\n\n## 🎨 Colores del FADD\n\nFADD = First Available Delivery Date (primera fecha posible de entrega). Manda la prioridad.\n\nOverdue Ya venció — prioridad máxima.\n\n3 días Vence en 3 días o menos.\n\n7 días Vence en 7 días o menos.\n\n14 días 8 días o más — tranquilo.\n\nNo FADD Falta cargar la fecha.\n\n## ⚡ Los 3 botones de acción\n\n🗺️ Ruta Abre Google Maps con la ruta storage → cliente.\n\n💬 WhatsApp Abre WhatsApp con el mensaje ya armado para el chofer.\n\n→ Avanzar Mueve el job a la siguiente etapa. El botón te dice a cuál.\n\n## El flujo de estados\n\nCada vez que tocás Avanzar , el job pasa a la siguiente etapa:\n\nScheduled\n→\nPicked up\n→\nIn storage\n→\nOut for delivery\n→\nDelivered\n\nImportante: los Direct y Broker NO pasan por In storage (van Picked up → Out for delivery). Al marcar Delivered , el job sale solo de las listas de activos."
    },
    {
      "id": "jobs",
      "title": "4 Crear y editar un trabajo",
      "text": "## 4 Crear y editar un trabajo\n\nTocá “+ Nuevo job” (arriba a la derecha en Dispatching o Jobs).\n\n## Full\nPickup → storage → delivery. Se guarda en el medio.\n\n## Direct\nPickup → delivery. Directo, sin guardar.\n\n## Broker delivery\nSolo delivery: la mercadería ya está, únicamente se entrega.\n\n## Qué se carga\n\n- Dónde se guarda — tildá una o varias unidades y/o warehouses (un job puede ocupar varios lugares).\n\n- Datos del job — Job #, Cliente, Tipo, Estado, Broker, Driver, FADD, Volumen (CF), Lot #, color de Sticker.\n\n- Pickup y Delivery — fecha, dirección, ciudad, estado, zip y el balance a cobrar en cada etapa.\n\n- Billing de storage — si al cliente se le cobra mensual por guardar (ver sección 7).\n\nEditar después: tocá el Job # para abrir el detalle y hacé clic en casi cualquier dato para cambiarlo en el momento (FADD, cliente, driver, direcciones, balances…). También está el botón Editar para el formulario completo."
    },
    {
      "id": "storage",
      "title": "5 Storage — unidades y warehouses",
      "text": "## 5 Storage — unidades y warehouses\n\nLa sección Storage tiene una pestaña por lugar: Storage Units , 🏭 Indiana y 🏭 New Jersey .\n\n## Storage Units\n\nAdentro, dos sub-pestañas:\n\n- Unidades — los lockers físicos con su barra de ocupación . Si falta, tocá “Set capacity” .\n\n- Jobs en unidades — qué hay guardado en cada locker (una fila por unidad).\n\n## Cargar / importar\n\n“+ Unidad” para una unidad nueva. También podés Importar desde WhatsApp pegando el mensaje o subiendo el .zip del chat. El gate code se copia con un clic."
    },
    {
      "id": "brokers,drivers",
      "title": "6 Brokers & Drivers",
      "text": "## 6 Brokers & Drivers\n\n## 🤝 Brokers\n\nLista de brokers con contacto, teléfono y email. Por cada uno ves cuántos jobs tiene y el balance pendiente . Podés agregar, editar o eliminar . Al cargar un job, elegís el broker de la lista.\n\n## 🧑‍✈️ Drivers\n\nLista de choferes. Se cargan solos a medida que los asignás en los jobs. Ves cuántos jobs activos y entregados tiene cada uno."
    },
    {
      "id": "billing",
      "title": "7 Billing — cobro de storage al cliente",
      "text": "## 7 Billing — cobro de storage al cliente\n\nAlgunos clientes pagan un mensual por guardar su mercadería (se negocia caso por caso). El sistema lo maneja solo.\n\n## Activarlo en el job\n\nEn el formulario, sección Billing de storage : tildá “Cobrar al cliente” , cargá la tarifa mensual , elegí si el 1.er mes es gratis y revisá la fecha de inicio (se calcula sola, pero es editable).\n\n## Cobrar y recordar\n\nMarcar pagado registra la fecha. 💬 Recordatorio abre WhatsApp con un mensaje al cliente listo para enviar. Lo vencido pasa a Overdue automáticamente."
    },
    {
      "id": "tips",
      "title": "8 Reglas de oro & glosario",
      "text": "## 8 Reglas de oro & glosario\n\n## 🎯 Las 4 reglas del día\n\n1. Mirá Dispatching y atacá el FADD en rojo/naranja primero .\n\n2. Que ningún pickup/delivery de hoy quede sin chofer .\n\n3. Avisá al chofer siempre con el botón 💬 WhatsApp del job (ya va con todos los datos).\n\n4. Avanzá el estado apenas pasa cada etapa, así el tablero refleja la realidad.\n\n## Glosario rápido\n\n| Término | Qué significa\n\n| FADD | First Available Delivery Date — primera fecha posible de entrega.\n\n| CF | Cubic Feet — volumen en pies cúbicos.\n\n| Lot # | Número de lote del sticker de la mercadería.\n\n| Sticker | Color / etiqueta que identifica la carga.\n\n| Full / Direct / Broker | Tipos de job: con storage / directo / solo entrega.\n\n| Broker | Empresa para la que se hace el trabajo (Allied, Atlas…).\n\n| Balance | Plata a cobrar (en el pickup o en el delivery).\n\n| Billing | Cobro mensual al cliente por guardar su mercadería.\n\n| Gate code | Código para entrar a la unidad de storage."
    }
  ],
  "en": [
    {
      "id": "cover",
      "title": "Operations",
      "text": "No Borders Moving & Storage\n\n## Operations\nCRM\n\nTeam user guide\n\n📘 Practical manual · Dispatching · Storage · Billing\n\nVersion 1.0 · Internal use\n\nUp and running in 10 minutes 🚚"
    },
    {
      "id": "intro",
      "title": "› Before you start",
      "text": "## › Before you start\n\nThe essentials to run the system day to day.\n\nThis is the system we use to manage pickups, deliveries, storage and billing . The key things:\n\n- Everything is live: if a teammate adds or changes something, you see it instantly — no need to reload the page.\n\n- It runs in the browser (computer or phone). Nothing to install.\n\n- Your work screen is Dispatching. That's where you'll spend 80% of your time.\n\nNote: a few buttons and labels in the app are still in Spanish — this guide shows them exactly as they appear on screen, with the English meaning in parentheses.\n\n## Contents\n\n| 1 · Access | How to sign in\n\n| 2 · The menu | The sidebar sections\n\n| 3 · Dispatching | The daily board (the most important part)\n\n| 4 · Create a job | Job types and data entry\n\n| 5 · Storage | Rented units and warehouses\n\n| 6 · Brokers & Drivers | Companies and drivers\n\n| 7 · Billing | Monthly storage billing to the client\n\n| 8 · Tips + Glossary | Golden rules and key terms"
    },
    {
      "id": "acceso",
      "title": "1 Access",
      "text": "## 1 Access\n\nSigning in.\n\n- Open the system link in your browser.\n\n- Sign in with your email and password (no account yet? ask your manager).\n\n- You land directly on Dispatching ."
    },
    {
      "id": "menu",
      "title": "2 The left-hand menu",
      "text": "## 2 The left-hand menu\n\nEverything is navigated from the sidebar, split into three blocks.\n\n| Section | What it's for\n\n| 🚚 Dispatching | The daily board: pickups, deliveries and the status of every job. Your main screen.\n\n| 📦 Storage | Rented units and owned warehouses (Indiana / New Jersey) with occupancy.\n\n| 📋 Jobs | All jobs with full detail (active and delivered).\n\n| 🤝 Brokers | Brokers (Allied, Atlas, Mayflower…) and each one's pending balance.\n\n| 🧑‍✈️ Drivers | Drivers and how many jobs each one has (they populate automatically).\n\n| 💵 Billing | Monthly storage billing to clients.\n\n| 📊 Analytics | Operation charts + AI recommendations."
    },
    {
      "id": "dispatching",
      "title": "3 Dispatching — the daily board",
      "text": "## 3 Dispatching — the daily board\n\nThe most important screen. Top to bottom: metrics → alerts → tabs → table.\n\n## The columns, one by one\n\n| Column | What it shows\n\n| Estado (Status) | Job stage (Scheduled → Picked up → In storage → Out for delivery → Delivered).\n\n| Job # | The job number. Tap it to open the full detail.\n\n| Tipo (Type) | Full / Direct / Broker (see section 4).\n\n| Broker · Cliente (Customer) | The company the job is for, and the customer's name.\n\n| FADD | Earliest possible delivery date, color-coded by urgency.\n\n| Pickup · Delivery | Date + city of where it's picked up and where it's delivered.\n\n| CF · Sticker · Lot | Volume (cubic feet), sticker color and lot number.\n\n| Driver | Assigned driver.\n\n| Bal. pickup / delivery | Money to collect at each stage.\n\n## 🎨 FADD colors\n\nFADD = First Available Delivery Date (the earliest date it can be delivered). It drives priority.\n\nOverdue Already past due — top priority.\n\n3 days Due within 3 days.\n\n7 days Due within 7 days.\n\n14 days 8 days or more — relax.\n\nNo FADD Date not set yet.\n\n## ⚡ The 3 action buttons\n\n🗺️ Ruta Opens Google Maps with the storage → customer route. (Ruta = Route)\n\n💬 WhatsApp Opens WhatsApp with the message already filled in for the driver.\n\n→ Advance Moves the job to the next stage. The button tells you which.\n\n## The status flow\n\nEach time you tap Advance , the job moves to the next stage:\n\nScheduled\n→\nPicked up\n→\nIn storage\n→\nOut for delivery\n→\nDelivered\n\nImportant: Direct and Broker jobs do NOT go through In storage (they go Picked up → Out for delivery). When you mark it Delivered , the job leaves the active lists automatically."
    },
    {
      "id": "jobs",
      "title": "4 Create and edit a job",
      "text": "## 4 Create and edit a job\n\nTap “+ Nuevo job” (= New job), top right in Dispatching or Jobs.\n\n## Full\nPickup → storage → delivery. It's stored in between.\n\n## Direct\nPickup → delivery. Straight through, no storage.\n\n## Broker delivery\nDelivery only: the goods are already here, you just deliver them.\n\n## What you fill in\n\n- Where it's stored — tick one or more units and/or warehouses (a job can occupy several places).\n\n- Job data — Job #, Customer, Type, Status, Broker, Driver, FADD, Volume (CF), Lot #, Sticker color.\n\n- Pickup and Delivery — date, address, city, state, zip and the balance to collect at each stage.\n\n- Storage billing — whether the client is charged monthly for storage (see section 7).\n\nEdit later: tap the Job # to open the detail and click almost any field to change it on the spot (FADD, customer, driver, addresses, balances…). There's also an Editar (Edit) button for the full form."
    },
    {
      "id": "storage",
      "title": "5 Storage — units and warehouses",
      "text": "## 5 Storage — units and warehouses\n\nThe Storage section has one tab per place: Storage Units , 🏭 Indiana and 🏭 New Jersey .\n\n## Storage Units\n\nInside there are two sub-tabs:\n\n- Unidades (Units) — the physical lockers with their occupancy bar. If it's empty, tap “Set capacity” .\n\n- Jobs en unidades (Jobs by unit) — what's stored in each locker (one row per unit).\n\n## Add / import\n\n“+ Unidad” (+ Unit) for a new unit. You can also Import from WhatsApp by pasting the message or uploading the chat .zip. The gate code copies with one click."
    },
    {
      "id": "brokers,drivers",
      "title": "6 Brokers & Drivers",
      "text": "## 6 Brokers & Drivers\n\n## 🤝 Brokers\n\nList of brokers with contact, phone and email. For each one you see how many jobs they have and the pending balance . You can add, edit or delete . When creating a job, pick the broker from the dropdown.\n\n## 🧑‍✈️ Drivers\n\nList of drivers. They populate automatically as you assign them in jobs. You see how many active and delivered jobs each one has."
    },
    {
      "id": "billing",
      "title": "7 Billing — charging storage to the client",
      "text": "## 7 Billing — charging storage to the client\n\nSome clients pay a monthly fee to store their goods (negotiated case by case). The system handles it automatically.\n\n## Turn it on in the job\n\nIn the form, Storage billing section: tick “Charge the client” , enter the monthly rate , choose whether the 1st month is free , and review the start date (auto-calculated, but editable).\n\n## Collect & remind\n\nMark as paid records the date. 💬 Reminder opens WhatsApp with a message ready to send to the client. Past-due items flip to Overdue automatically."
    },
    {
      "id": "tips",
      "title": "8 Golden rules & glossary",
      "text": "## 8 Golden rules & glossary\n\n## 🎯 The 4 rules of the day\n\n1. Check Dispatching and tackle the red/orange FADD first .\n\n2. Make sure no pickup/delivery for today is left without a driver .\n\n3. Always notify the driver with the job's 💬 WhatsApp button (it already includes all the data).\n\n4. Advance the status as soon as each stage happens, so the board reflects reality.\n\n## Quick glossary\n\n| Term | What it means\n\n| FADD | First Available Delivery Date — the earliest date the job can be delivered.\n\n| CF | Cubic Feet — volume in cubic feet.\n\n| Lot # | Lot number from the sticker on the goods.\n\n| Sticker | Color / label that identifies the load.\n\n| Full / Direct / Broker | Job types: with storage / straight through / delivery only.\n\n| Broker | The company the job is for (Allied, Atlas…).\n\n| Balance | Money to collect (at pickup or at delivery).\n\n| Billing | Monthly fee charged to the client for storing their goods.\n\n| Gate code | Code to get into the storage unit."
    }
  ]
};
