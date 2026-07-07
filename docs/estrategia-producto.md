# Estrategia de producto: convertir el sistema en un software vendible

> Documento de trabajo — julio 2026. Objetivo: definir cómo transformar el sistema interno de No Borders en un producto que se pueda vender a otras compañías, qué modelo de negocio conviene, a quién apuntar y qué hay que cambiar en el código para lograrlo.

---

## 1. Resumen ejecutivo

**La tesis: no venderlo como "CRM genérico", sino como software vertical para empresas de moving & storage.**

Lo que construimos no es un CRM de ventas (no tiene leads, deals ni pipeline comercial). Es algo más valioso para un nicho específico: una **plataforma de operaciones completa para empresas de mudanzas y almacenamiento** — dispatching, jobs con su ciclo de vida completo, ocupación de warehouses por pies cúbicos, drivers/trucks/trips, BOL con firma electrónica, settlements con brokers, billing mensual de storage, cobranzas y analytics con IA.

Competir contra HubSpot o Pipedrive como CRM genérico sería entrar al mercado más saturado del software con un producto que no tiene las features básicas de ese mercado. En cambio, en el nicho de moving & storage el producto **ya resuelve el caso exacto** que una empresa como la nuestra necesita, con vocabulario del rubro incluido (FADD, CF, BOL, brokers, closing sheets).

**Recomendación en una línea:** vender primero **instancias white-label a empresas de mudanzas/storage en USA** (se puede empezar casi ya, financia el desarrollo), y con 3-5 clientes validados invertir en la versión **SaaS multi-tenant** con suscripción mensual.

---

## 2. Qué es el producto hoy

### Features vendibles (ya construidas y probadas en producción real)

| Módulo | Qué hace | Valor para el comprador |
|---|---|---|
| Dispatching + Calendar | Agenda y asignación de jobs a drivers | El corazón operativo diario |
| Jobs | Ciclo completo: Scheduled → Picked up → In storage → Out for delivery → Delivered, con historial de eventos | Trazabilidad de cada mudanza |
| Storage | Unidades/bauleras y warehouses con ocupación por CF | Saber qué espacio hay y qué genera plata |
| Storage Billing | Ciclos de facturación de 30 días, morosos, recordatorios por WhatsApp | Ingresos recurrentes que hoy muchos manejan en Excel |
| BOL | Bill of Lading digital con templates, firma vía DocuSign en pickup/delivery | Reemplaza papel; requisito legal del rubro |
| Brokers + Settlements | Closing sheets, saldos con brokers (Allied, Atlas, etc.) | Dolor real de todo carrier que trabaja con brokers |
| Extras + Comisiones | Cargos extra por job y comisiones a drivers/reps | Automatiza cuentas que generan conflictos |
| Payments | Registro de cobranzas (cash, Zelle, Venmo, check) y quién tiene la plata | Control de caja distribuida |
| Trips / Live Load | Planificación de viajes con sugerencias de IA | Optimización de rutas y cargas |
| Legal & Compliance | Vencimientos de documentos de empresa y flota | Evita multas |
| Chat interno | Canales + DMs estilo Slack, en tiempo real | Un sistema menos que pagar |
| Analytics + IA | Dashboards y análisis con Claude | Diferenciador de marketing fuerte |
| Usuarios y permisos | Roles admin/member con permisos por sección (ver/editar/crear), aplicados en la base de datos (RLS) | Seguridad seria, poco común en software de este nicho |

### Lo que le falta para ser un producto (gap técnico)

- **Multi-tenancy**: hoy es una sola empresa por instalación. No existe el concepto de organización/tenant; el proyecto de Supabase está hardcodeado (`src/App.jsx:13`) y el nombre "No Borders Moving" también (`src/App.jsx:2612`).
- **Branding configurable**: nombre, logo y los templates de mensajes de WhatsApp están escritos en el código.
- **Cobro por suscripción**: no hay Stripe ni ningún sistema de billing SaaS (los módulos de "payments" son contabilidad interna del negocio de mudanzas, no procesan pagos).
- **Onboarding self-service**: hoy dar de alta una empresa requiere correr scripts a mano contra Supabase.
- **Migraciones gestionadas**: el schema se crea con scripts one-time (`scripts/setup-*.mjs`), no hay versionado de migraciones para actualizar N instalaciones.
- **Configuración por empresa**: warehouses, reglas de comisiones y textos están hardcodeados como lógica de No Borders.
- **i18n**: la UI mezcla inglés con documentación en español; un producto necesita elegir y hacerlo bien (idealmente ES/EN switchable — es una ventaja en el mercado hispano).

---

## 3. Mercado objetivo: evaluación y recomendación

### Opción A — Empresas de moving & storage en USA (recomendada)

- **Fit del producto: perfecto.** Es literalmente el mismo negocio. Cero adaptación funcional.
- **Mercado:** miles de moving companies chicas y medianas en USA (el rubro está muy fragmentado). Muchas operan con Excel, papel y WhatsApp — exactamente donde estaba No Borders antes de este sistema.
- **Competencia:** SmartMoving, Supermove, MoveitPro, Elromco. Cobran caro (generalmente USD 300-700+/mes), apuntan a empresas medianas/grandes, y ninguna está pensada para el operador hispano. Ahí hay un hueco claro: **el segmento chico/mediano y el mercado hispano de moving en USA** (que es enorme — gran parte de la industria es operada por latinos).
- **Ventaja única:** "lo construimos para operar nuestra propia empresa" es el mejor pitch posible. No es software diseñado por programadores que nunca cargaron un camión.

### Opción B — Logística y almacenamiento en general

- Fit parcial: dispatching, fleet y storage sirven, pero brokers/BOL/settlements son específicos de moving. Requiere generalizar bastante.
- Mercado más grande pero competencia mucho más pesada (TMS establecidos).
- **Veredicto:** no como punto de entrada. Es una expansión natural para más adelante (self-storage puro es el vecino más cercano: el módulo de storage + billing ya cubre gran parte).

### Opción C — CRM genérico para PyMEs

- Fit malo: no hay pipeline de ventas, ni email marketing, ni las features que definen la categoría. Habría que construir un producto distinto.
- Competencia brutal (HubSpot, Pipedrive, Zoho, decenas más, muchos gratis).
- **Veredicto: descartada.** Sería regalar la ventaja competitiva (el conocimiento profundo del nicho) para pelear donde somos más débiles.

**Recomendación:** empezar por la opción A con foco en operadores chicos/medianos e hispanos, y tener la B (self-storage primero) como segunda etapa de expansión.

---

## 4. Modelo de negocio: evaluación y recomendación

### Modelo 1 — Licencia + instancia dedicada por cliente ("white-label")

Cada cliente recibe su propia copia: un proyecto Supabase + un deploy en Vercel con su branding.

- ✅ **Se puede vender casi ya**: los cambios necesarios son chicos (ver Fase 0 del roadmap).
- ✅ Facturación inicial fuerte: setup fee (instalación, carga de datos, capacitación) + fee mensual de mantenimiento.
- ✅ Aislamiento total de datos entre clientes (argumento de venta, además).
- ✅ Cada venta valida el producto y financia el desarrollo del SaaS.
- ❌ No escala: cada cliente suma trabajo manual de deploy, actualización y soporte. Techo práctico: ~10-20 clientes.
- ❌ Actualizar features en N instancias a mano se vuelve una pesadilla sin migraciones versionadas.

### Modelo 2 — SaaS multi-tenant con suscripción mensual

Un solo deploy, todas las empresas en la misma base con aislamiento por `org_id` + RLS.

- ✅ Escala de verdad: el costo marginal de un cliente nuevo tiende a cero.
- ✅ Suscripción recurrente = valuación de empresa de software, no de servicio.
- ✅ Onboarding self-service posible (prueba gratis → tarjeta → cliente).
- ❌ Requiere el refactor más grande del roadmap (multi-tenancy sobre un monolito de 831 KB).
- ❌ Construirlo **antes** de validar demanda es el error clásico: meses de ingeniería para un producto que quizás nadie compra.

### Recomendación: dos fases

1. **Fase comercial 1 (ahora → primeros 3-5 clientes):** vender instancias dedicadas. Precio orientativo: setup USD 1.500-3.000 + USD 200-400/mes. Objetivo: probar que empresas ajenas pagan, aprender qué configuración necesita cada una (eso define qué debe ser configurable en el SaaS).
2. **Fase comercial 2 (con demanda probada):** construir la versión multi-tenant y migrar. Los clientes de la fase 1 pasan a ser el plan "Enterprise/dedicado" (algunos preferirán quedarse en instancia propia — cobrarles premium por eso).

Esta secuencia convierte la debilidad actual (single-tenant) en un modelo de negocio válido para arrancar, en lugar de un bloqueante.

---

## 5. Pricing (propuesta inicial)

Referencia de mercado: los competidores del nicho cobran entre USD 100 y 700+ por mes según tamaño; casi todos cobran extra por firma electrónica y SMS.

| Plan | Precio orientativo | Incluye |
|---|---|---|
| **Starter** (SaaS futuro) | USD 149/mes | Hasta 3 usuarios, 50 jobs/mes, módulos core |
| **Pro** (SaaS futuro) | USD 299/mes | Hasta 10 usuarios, jobs ilimitados, BOL + firma, analytics IA |
| **Dedicado / White-label** (vendible hoy) | Setup USD 1.500-3.000 + USD 250-400/mes | Instancia propia, branding, carga inicial de datos, soporte directo, capacitación |

Notas:
- Cobrar por **usuarios + volumen de jobs** (no por features clave — que todos vean el valor completo).
- La firma DocuSign y la IA tienen costo variable por uso: incluir una cuota y cobrar excedentes, o pasar el costo (DocuSign se puede reemplazar más adelante por firma propia para mejorar margen).
- En la fase white-label, los costos de infra por cliente (Supabase Pro ~USD 25/mes + Vercel + Anthropic) quedan cubiertos de sobra por el fee mensual.

---

## 6. Roadmap técnico

### Fase 0 — Poder vender instancias ya (semanas, no meses)

1. **Branding a configuración**: extraer nombre de empresa (`src/App.jsx:2612`), logo y textos de los templates de WhatsApp (`src/App.jsx:1700-1970`) a una tabla `company_settings` o a env vars.
2. **Quitar fallbacks hardcodeados** del proyecto Supabase en `src/App.jsx:13-14` — que `VITE_SUPABASE_URL`/`VITE_SUPABASE_KEY` sean obligatorias por deploy.
3. **Script de provisioning**: un comando que corra todos los `scripts/setup-*.mjs`/`.sql` en orden contra un proyecto Supabase nuevo (hoy tienen el project ref hardcodeado — parametrizarlo).
4. **Checklist de alta de cliente**: crear proyecto Supabase → correr provisioning → deploy Vercel con env vars → crear admin → cargar datos iniciales → capacitación. Documentado para que sea repetible en horas.
5. Generalizar los workflows de GitHub (`supabase-keepalive.yml`, `supabase-backup.yml`) para que funcionen por instancia.

### Fase 1 — Producto instalable serio (en paralelo con los primeros clientes)

1. **Settings de empresa en DB**: warehouses (hoy Indiana/New Jersey son datos de No Borders), reglas de comisiones (extra CF, long carry, shuttle — hoy lógica hardcodeada), moneda, zona horaria.
2. **Migraciones versionadas** (Supabase CLI / archivos numerados) para poder actualizar todas las instancias con un comando. Esto es lo que evita que N instancias se vuelvan inmanejables.
3. **i18n ES/EN** de la interfaz — diferenciador para el mercado hispano.
4. Empezar a **partir `src/App.jsx`** (831 KB) en módulos por página. No hace falta hacerlo de golpe: cada feature nueva sale a su propio archivo, y se van extrayendo páginas al tocarlas.

### Fase 2 — SaaS multi-tenant (cuando haya 3-5 clientes pagando)

1. **`org_id` en todas las tablas** + políticas RLS por tenant. La infraestructura de permisos existente (`has_perm()`/`is_admin()` en `scripts/setup-rls.mjs`) es una buena base: se extiende a `misma org + permiso de sección`.
2. **Stripe** para suscripciones (planes, trial, cobro automático, dunning).
3. **Onboarding self-service**: registro de empresa → org creada → invitar equipo → wizard de configuración inicial.
4. **Panel interno de administración de tenants** (altas, bajas, uso, soporte).
5. Migración asistida de las instancias white-label que quieran pasarse.

---

## 7. Go-to-market: cómo conseguir los primeros clientes

1. **No Borders como caso de éxito.** El pitch es la historia real: "operamos nuestra empresa de mudanzas con esto — X jobs por mes, Y warehouses — y lo construimos porque nada del mercado nos servía". Armar un one-pager y un video demo de 5 minutos con datos de ejemplo.
2. **Red existente**: los brokers con los que ya se trabaja (Allied, Atlas, etc.) conocen a decenas de carriers del mismo tamaño. Los drivers y colegas del rubro también. Las primeras 2-3 ventas salen de conocidos — y son las que más enseñan.
3. **Mercado hispano de moving en USA**: grupos de Facebook/WhatsApp del rubro, asociaciones, ferias como las de AMSA. Software del nicho con soporte en español prácticamente no existe.
4. **Instancia demo** con datos de ejemplo para mostrar en llamadas (un proyecto Supabase de demo que se resetea).
5. **Precio de founding customers**: descuento de por vida a los primeros 5 a cambio de feedback intensivo y testimonios.

---

## 8. Riesgos y decisiones abiertas

- **El monolito**: `App.jsx` de 831 KB hace que cada cambio sea riesgoso y que sea difícil sumar otro desarrollador. Mitigación: la extracción progresiva de la Fase 1 + tests en los flujos críticos antes del refactor multi-tenant.
- **Costos variables por cliente**: DocuSign y la API de Anthropic cobran por uso; hay que medir el costo real por cliente activo antes de fijar precios definitivos.
- **Soporte**: vender software a otros implica atender sus urgencias operativas (una mudanza no espera). Definir horario/canal de soporte y ponerlo en el contrato.
- **Contratos y datos**: términos de servicio, SLA, propiedad de los datos del cliente, y qué pasa si se dan de baja (exportación — el script `scripts/backup-json.mjs` ya es una base para esto).
- **Conflicto de interés percibido**: algunos prospectos son competidores de No Borders. Decidir si eso importa por mercado geográfico, y eventualmente separar el producto en una entidad/marca propia.
- **Marca**: elegir un nombre de producto que no sea "No Borders" (que es la mudadora) — decisión pendiente.

---

## 9. Próximos pasos concretos (en orden)

1. **Validar antes de programar**: mostrarle el sistema (demo con datos de ejemplo) a 2-3 empresas de mudanzas conocidas y preguntar sin vueltas: *¿pagarías? ¿cuánto? ¿qué te falta?*
2. Si hay 1-2 interesados reales → ejecutar la **Fase 0** del roadmap técnico (branding configurable + provisioning repetible).
3. Cerrar el **primer cliente white-label** con precio de founding customer y contrato simple.
4. Con el aprendizaje del primer cliente, ejecutar la **Fase 1** (settings en DB, migraciones, i18n).
5. Elegir **nombre y marca** del producto, armar landing page con el caso No Borders.
6. Con 3-5 clientes pagando → decidir e iniciar la **Fase 2** (SaaS multi-tenant con Stripe).

> Regla de oro de toda la movida: **cada etapa de inversión técnica se desbloquea con una validación comercial**, no antes. El código ya demostró que funciona operando No Borders; lo que falta demostrar es que otros pagan por él — y eso se prueba vendiendo, no programando.
