# Workflow del CRM — No Borders Moving

> **Qué es este documento.** La guía (`Guia-CRM-NoBorders.pdf`) explica **qué hace cada
> pantalla**. Esto explica **quién toca qué, cuándo y en qué orden**. Son cosas
> distintas: el CRM no está desordenado por falta de pantallas — está desordenado
> porque nunca se fijó la rutina. Esto es la rutina.

---

## 1. Las tres reglas que ordenan todo

Si el equipo cumple sólo estas tres, el 80% del desorden desaparece.

**Regla 1 — Un dato, un dueño.**
Cada número se carga **una sola vez**, en la pantalla que lo posee. Todo lo demás
lo deriva el sistema. Si cargás la misma plata en dos lados, no tenés dos
registros: tenés dos versiones de la verdad y ninguna sirve.

**Regla 2 — El estado se avanza el mismo día que pasa.**
Un pickup que se hizo el martes y se marcó el viernes hace que el tablero mienta
tres días. El botón **→ (Avanzar)** de Dispatching se toca cuando el chofer avisa,
no cuando hay tiempo.

**Regla 3 — La plata se carga donde se cobra, en el momento.**
El pago se registra cuando entra, con **quién lo tiene físicamente**. No "después
lo cargo". Ese "después" es el agujero por donde se pierde el cash.

---

## 2. Mapa de dueños — qué pantalla manda sobre cada dato

Esta tabla es la que corta las discusiones de "¿dónde se carga esto?".

| Dato | Se carga SOLO en | Se refleja automáticamente en |
|---|---|---|
| Alta y datos del job | **+ Nuevo job** / detalle del job | Dispatching, Jobs, Calendar, Analytics |
| Estado del job | **Dispatching → Avanzar** | Todo el tablero, Trips, brief diario |
| FADD, driver, sticker, CF | **Detalle del job** (clic sobre el campo) | Dispatching, alertas, Trips |
| Asignación a un viaje | **Trips** (o el campo Trip del job) | Dispatching, manifest de WhatsApp |
| Cobro de un cliente | **Payments** (o desde el job) | AP/AR, Analytics, brief, Drivers |
| Cobro de un BOL | **Settlements** | Se sincroniza solo con Payments |
| Extras y comisiones | **Extras** (o desde el job) | Payments, AP/AR, perfil del driver/rep |
| Cobro mensual de storage | **Se genera solo** (billing activo en el job) | Storage Billing, AP/AR |
| Gastos de campo (cash del driver) | **Field Expenses** | Banks → Conciliación, P&L |
| Facturas fijas (alquiler, seguro, software) | **AP/AR → bills** | AP/AR, P&L |
| Movimientos del banco | **Banks** (screenshot o CSV) | Conciliación, P&L |
| Documentos que vencen | **Legal & Compliance** | Alerta roja + badge del menú |
| Daños e incidentes | **Claims** | ⚠ en el job y en el trip, brief |

**Las dos únicas cosas que se cargan dos veces por diseño** (y el sistema las
cruza a propósito, para detectar diferencias):
- Lo que cobró el chofer (Payments) **vs.** lo que entró al banco (Banks → Conciliación).
- Lo que dice el GPS que hizo el camión (Reports) **vs.** lo que se le pagó al chofer.

Si esas dos no cierran, hay algo para mirar. Todo lo demás que aparezca cargado
dos veces es un error.

---

## 3. Los cinco roles y su pantalla casa

Nadie tiene que ver las 29 secciones. Cada persona vive en **una** pantalla y
visita las otras cuando la rutina se lo pide.

| Rol | Pantalla casa | Entra al CRM para… |
|---|---|---|
| **Dispatcher** | 🚚 Dispatching | que ningún job de hoy quede sin chofer y ningún FADD se venza |
| **Back office / Cobranzas** | 💰 Payments + 📒 AP/AR | que la plata cobrada llegue al banco y la deuda baje |
| **Fleet manager** | 🛣️ Trips + 🪪 Drivers | que los camiones estén cargados, legales y en ruta |
| **Contabilidad** | 🏛️ Banks | que cada movimiento esté categorizado y verificado |
| **Dueño / Manager** | 📊 Analytics + brief diario | decidir: qué jobs tomar, qué broker conviene, dónde se pierde plata |

> ⚙️ **Esto ya se configura en el CRM**: en **Users**, cada persona tiene permisos
> por sección. Hoy están casi todos con todo prendido — por eso el menú se ve
> gigante para todos. Ver §7.

---

## 4. El ciclo de vida de un job, de punta a punta

Ocho etapas. Cada una con **dueño**, **pantalla** y **qué se rompe si te la saltás**.

### Etapa 0 — Decidir si el job se toma
**Dueño:** quien atiende al broker · **Pantalla:** 🧮 Job Calculator

El broker llama con el precio ya puesto: la única pregunta es tomarlo o no.
Cargás origen, destino, CF, precio y condiciones de acceso, y sale el semáforo con
el margen real. **Con el broker todavía en el teléfono.**

*Si te la saltás:* tomás jobs que no dejan plata y te enterás tres meses después en Analytics.

### Etapa 1 — Dar de alta el job
**Dueño:** quien lo vendió / back office · **Pantalla:** **+ Nuevo job**

Tipo (**Full** / **Direct** / **Broker delivery**), cliente, broker, CF, direcciones,
**balances de pickup y delivery**, y si el cliente paga storage mensual →
tildar **billing activo** ahí mismo.

*Si te la saltás:* el job vive en storage sin facturarse. Hoy el brief mide esa
fuga todos los días y la muestra en dólares por mes.

### Etapa 2 — Poner fecha y asignar
**Dueño:** dispatcher · **Pantalla:** Dispatching → **Calendar** y 🛣️ **Trips**

Cargar **FADD**, fecha de delivery, driver y meterlo en un **trip**. La barra de
capacidad del trip te dice si el camión aguanta.

*Si te la saltás:* el job aparece en "No FADD" / "No trip" y nunca se agenda solo.

### Etapa 3 — Pickup
**Dueño:** dispatcher + chofer · **Pantalla:** Dispatching

Mandar el 💬 **WhatsApp** al chofer (sale con todos los datos, o el manifest del
trip entero), y al confirmar: **Avanzar → Picked up**. Si cobró en el pickup →
se carga el pago **en el momento** (Etapa 6).

### Etapa 4 — En storage *(sólo jobs Full)*
**Dueño:** dispatcher · **Pantalla:** 🏬 Storage

**Avanzar → In storage**, con **unidad o warehouse** y **sticker (color + lote)**.
El billing mensual se genera solo cada 30 días y se marca **overdue** al vencer.

*Si te la saltás:* mercadería sin ubicación física registrada. Cuando haya que
sacarla, alguien la va a buscar a mano.

### Etapa 5 — Delivery
**Dueño:** dispatcher + chofer · **Pantalla:** 🛣️ Trips

**Avanzar → Out for delivery**, manifest al chofer, y **Mark delivered** por stop.
Cuando se entregan todos los stops, el trip se cierra solo.

### Etapa 6 — Cobrar
**Dueño:** quien cobra + back office · **Pantalla:** 💰 Payments

Monto, concepto, método y — lo importante — **quién tiene la plata físicamente**.
Cash, cheque o money order quedan "en circulación" hasta que se marque el
depósito. Lo digital se marca depositado solo.

*Si te la saltás:* la plata existe en el bolsillo de alguien y no en ningún
sistema. Es el agujero más caro de todos.

### Etapa 7 — Depositar y cerrar
**Dueño:** back office · **Pantallas:** Payments → **En circulación**, 📑 Settlements, ➕ Extras

Depositar lo que está en circulación (el botón 💬 **Pedir depósito** ya arma el
WhatsApp), cerrar la **closing sheet** del broker y cargar los **extras** con sus
comisiones.

### Etapa 8 — Conciliar
**Dueño:** contabilidad · **Pantallas:** 🏛️ Banks → Conciliación, 📒 AP/AR

Subir el movimiento del banco, categorizar, **verificar** (lo verifica una persona
distinta de la que categorizó) y cruzar contra Payments y Expenses. AP/AR muestra
el neto: cuánto te deben y cuánto debés, envejecido 0-30 / 31-60 / 61-90 / 90+.

---

## 5. Las rutinas — el corazón del workflow

### ☀️ Apertura del día — Dispatcher, 08:00, 15 minutos

1. **Leer el brief** que llegó al grupo de Telegram (sale automático todos los
   días): agenda de hoy, deuda cobrable, fugas de storage, FADD vencidos, claims.
2. Abrir **Dispatching → Today**. Los cinco números de arriba, en este orden:
   - **FADD overdue** (rojo) → lo primero, siempre.
   - **Unmanned today** → jobs de hoy sin chofer ni trip. **Esto no puede quedar en más de 0 al final de la apertura.**
   - **Pickups hoy** y **Deliveries hoy** → confirmar con cada chofer por WhatsApp.
   - **To schedule** → deliveries con FADD ≤ 7 días que todavía no tienen fecha.
3. Bajar al panel **Needs attention** y vaciarlo de arriba hacia abajo:
   `No driver today` → `No trip assigned` → `No FADD` → `No delivery date` → `Sticker unassigned`.
4. Si aparece el cartel amarillo de 🔍 **duplicados**, resolverlo ahí mismo (son 30 segundos y evitan cobrar dos veces).

### 🔄 Durante el día — Dispatcher

- Cada vez que un chofer avisa → **Avanzar** el estado. En el momento.
- Cada cobro que entra → cargarlo en **Payments** con quién tiene la plata.
- Todo lo operativo por **💬 Chats** (queda en el job y lo ve el resto), no por WhatsApp personal.

### 🌙 Cierre del día — Dispatcher, 17:30, 10 minutos

1. **Dispatching → Today**: que todo lo de hoy esté en su estado real.
2. Lo que no se hizo → reprogramar o **On hold** (con la razón en el job).
3. Mañana ya cubierto: pickups y deliveries de mañana con chofer y trip asignados.

### 💵 Cierre de plata — Back office, todos los días, 20 minutos

1. **Payments → alerta roja**: cash recibido hace **más de 7 días sin depositar**. Botón 💬 **Pedir depósito**.
2. **Payments → En circulación**: cuánto tiene cada persona en mano, desglosado.
3. **AP/AR**: que la deuda real del día baje respecto de ayer (el brief lo muestra como delta).

### 📅 Lunes — Fleet manager, 30 minutos

- **Legal & Compliance**: documentos vencidos o que vencen en ≤ 7 días (badge del menú).
- **Trucks / Drivers**: capacidades y vínculos al día.
- **Reports**: cruce GPS vs. lo que se pagó de sueldo. Donde no coincide, hay algo que mirar.
- **Claims**: que ninguno quede en `open` más de una semana sin pasar a `investigating`.

### 📆 Viernes — Cobranzas, 45 minutos

- **AP/AR → Receivables**: atacar la columna **90+** primero, después 61-90.
- **Storage Billing → Overdue**: recordatorio por WhatsApp (el botón ya lo arma).
- **Settlements → Open**: cerrar las closing sheets de la semana.
- **Extras**: cargar los extras de la semana y mandar el resumen a cada driver y rep (📋 Copiar / 🖨️ PDF).

### 🗓️ Cierre de mes — Contabilidad + Dueño, medio día

1. **Banks**: bandeja en cero — todo categorizado **y verificado**.
2. **Banks → Conciliación**: ¿cuadra contra Payments y Expenses?
3. **Banks → P&L** y **Analytics**: margen por broker, por estado, por driver.
4. **AP/AR**: foto del neto del mes.
5. **Suggestions**: leer lo que propuso el equipo y responder. (Si nadie responde, nadie vuelve a escribir.)

---

## 6. Las alertas y quién las apaga

Cada alerta del sistema tiene un dueño y un plazo. Sin esto, las alertas se
vuelven paisaje.

| Alerta | Dónde aparece | Dueño | Plazo |
|---|---|---|---|
| FADD vencido | Dispatching (rojo) | Dispatcher | **Mismo día** |
| Job de hoy sin chofer / sin trip | Dispatching → Unmanned | Dispatcher | Antes de las 09:00 |
| Sin FADD / sin fecha de delivery | Needs attention | Dispatcher | 48 h |
| Sticker sin asignar | Needs attention | Dispatcher | Al entrar a storage |
| Cash sin depositar +7 días | Payments (rojo) | Back office | 48 h |
| Storage billing overdue | Storage Billing | Cobranzas | Semanal |
| Job en storage sin billing activo | Brief diario | Back office | Semanal |
| Documento vencido / por vencer | Compliance + badge | Fleet manager | **Antes del vencimiento** |
| Claim abierto | ⚠ en job y trip | Fleet manager | 7 días para pasar a `investigating` |
| Posibles duplicados | Cartel amarillo | Quien lo ve | En el momento |

---

## 7. Lo que hoy está desordenado — y cómo lo ordenaría

Esto es diagnóstico sobre el CRM real, no teoría.

### 7.1 El menú tiene 29 secciones y todos ven las 29

Es la causa #1 de la sensación de desorden. El CRM **ya tiene permisos por
sección** (Users → permisos de view/edit/create) y **ya tiene rol de app**
(Driver / Back office / Master), pero están casi todos en "todo prendido".

**Propuesta:** usar lo que ya existe. Un dispatcher debería ver 6 ítems, no 29.

| Rol | Ve en el menú |
|---|---|
| Dispatcher | Dispatching · Trips · Storage · Chats · Clients · Claims |
| Back office | Dispatching · Payments · AP/AR · Billing · Settlements · Extras · Clients |
| Fleet | Trips · Trucks · Drivers · Compliance · Reports · Equipment |
| Contabilidad | Banks · AP/AR · Expenses · Payments |
| Dueño | Todo |

**Costo: cero código.** Es configuración en Users.

### 7.2 Hay cuatro entradas de menú para una sola pantalla

Desde el rediseño de Dispatching, esa página ya tiene adentro **Today · Jobs ·
Calendar**. Pero el menú sigue mostrando además:

- **Jobs** — se superpone con Dispatching → Jobs (lo único propio es el archivo de `delivered`).
- **Pickup Calendar** y **Delivery Calendar** — no son pantallas: son atajos que
  redirigen a Dispatching → Calendar con un filtro puesto.

**Propuesta:** sacar los tres del menú. El calendario ya es una pestaña; el
archivo de entregados puede ser una pestaña más ("Archivo") dentro de Dispatching
→ Jobs. **29 → 26 ítems sin perder nada.**

### 7.3 El brief diario es la mejor pantalla del sistema y no está en el sistema

Todos los días se arma un brief con la agenda, la deuda cobrable, las fugas de
storage, los FADD vencidos, los claims **y hasta los mensajes de cobranza listos
para mandar** — con comparación contra ayer. Y se publica en Telegram, donde se
pierde entre mensajes.

**Propuesta:** una pantalla **🏠 Hoy** como primera del menú, que muestre ese
mismo brief adentro del CRM, con los chips clickeables. Es la pantalla de
apertura del día de §5, hecha producto. La lógica ya está escrita y probada
(`lib/brief.mjs`) — falta mostrarla.

### 7.4 "Finanzas" son 10 secciones para una sola pregunta

Hoy: Brokers · Billing · Settlements · Extras · Payments · AP/AR · Expenses ·
Banks · Claims · Clients. Nadie sabe por cuál empezar.

Pero **AP/AR ya es la suma de las otras** — se construyó justamente para eso.

**Propuesta:** AP/AR primero en el grupo, como portada del dinero, y el resto
debajo como el detalle al que se baja. Y mover **Clients** y **Brokers** fuera de
Finanzas: son directorio, no plata.

### 7.5 El menú propuesto

```
HOY
  🏠 Hoy                    ← nuevo: el brief adentro del CRM
  🚚 Dispatching            ← Today · Jobs · Calendar · Archivo
  🛣️ Trips / Live Load
  💬 Chats

OPERACIÓN
  🏬 Storage
  🧮 Job Calculator
  🧰 Equipment

DINERO
  📒 AP / AR                ← portada: cuánto me deben, cuánto debo
  💰 Payments
  🧾 Storage Billing
  📑 Settlements
  ➕ Extras
  💸 Field Expenses
  🏛️ Banks

FLOTA & LEGAL
  🪪 Drivers      🚛 Trucks
  📋 Compliance   📈 Reports    ⚠️ Claims

DIRECCIÓN
  📊 Analytics    🏦 Brokers    👥 Clients

⚙️ ADMIN  (al pie, colapsado)
  📄 BOL · 💡 Suggestions · 🗑️ Trash · 👤 Users · ⚙️ Settings
```

Con los permisos de §7.1 encima, un dispatcher ve **seis líneas**.

---

## 8. Cómo implementarlo

| Fase | Qué | Esfuerzo | Efecto |
|---|---|---|---|
| **1** | Configurar permisos por rol en **Users** | 1 hora, cero código | El más grande de todos |
| **2** | Adoptar las rutinas de §5 (una semana de insistir) | Cero código | El que hace que el resto sirva |
| **3** | Sacar Jobs / Pickup Calendar / Delivery Calendar del menú | Chico | Menú más limpio |
| **4** | Reagrupar el menú como §7.5 + grupo Admin colapsable | Chico | Menú más limpio |
| **5** | Pantalla **🏠 Hoy** con el brief adentro del CRM | Mediano | Apertura del día en una pantalla |

Las fases 1 y 2 no tocan una línea de código y son las que más ordenan. Las 3 a 5
son cambios de producto que se pueden hacer después, sin apuro.

---

## 9. La versión corta (para pegar en la pared)

- **Un dato, un dueño.** Se carga una vez, en su pantalla.
- **El estado se avanza el mismo día.**
- **La plata se carga cuando entra, con quién la tiene.**
- **Dispatcher:** abrí en Dispatching → Today. FADD rojo primero. Cero jobs sin chofer.
- **Back office:** cero cash de más de 7 días sin depositar.
- **Fleet:** cero documentos vencidos.
- **Todos:** si una alerta lleva más de una semana prendida, o la apagás o no era una alerta.
