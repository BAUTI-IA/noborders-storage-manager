# Despacho a Carriers — arquitectura propuesta (para decidir)

> **Estado: propuesta.** Todavía no hay código. Este documento junta la
> arquitectura y las opciones para discutir con los socios. Cuando se elija el
> camino, la implementación arranca de acá.

No Borders también trabaja como **broker**: le da jobs a carriers externos. Hoy
eso no vive en el CRM: no hay tabla de carriers, el job no dice a quién se le
dio, y no hay saldo entre compañías. La idea:

1. **Todo despacho sale del CRM**, por mail, WhatsApp o ambos, con el rate y lo
   que el carrier tiene que cobrarle al cliente.
2. Una **casilla dedicada** (`dispatch@…`) recibe la documentación cuando el
   carrier termina (BOL firmado, comprobante del cobro). La IA la lee, la vincula
   al job y propone la actualización: entregado, CF final y monto cobrado.
3. El CRM **calcula solo el saldo** con cada carrier: si cobró más de lo que le
   corresponde, nos debe la diferencia; si cobró menos, se la debemos.
4. Una pestaña **Carriers** muestra todos los jobs despachados y lo que debe
   cada carrier.

---

## Lo que ya existe y se reutiliza

| Pieza | Dónde | Cómo se usa acá |
|---|---|---|
| La cuenta, al revés | `sheetCalc` en `src/appData.js:52` (Settlements / `closing_sheets`) | Ahí somos el carrier y Allied/Atlas el broker: `net = carrierFee − deducciones − bolCollected`. La cuenta del carrier es la misma con los roles invertidos. |
| Saldos con aging | `src/aparData.js` (`buildReceivables` / `buildPayables`) | Ya mete closing sheets con `net > 0` en cobrar y `net < 0` en pagar. El carrier entra igual, como `source: "carrier"`. |
| Gmail → CRM | `scripts/gmail-to-pipeline.gs` → `/api/inbound-email` → `inboundEmail` en `api/agent-hub.mjs:163` | Mismo patrón (Apps Script cada 5 min, secreto compartido, dedupe por `message_id`). Falta traer los **adjuntos**: hoy sólo manda el texto. |
| Mail saliente | `scripts/bank-digest-email.gs` | El CRM arma el mail, Apps Script lo manda y confirma con un ACK. Es el único camino de salida de mail que existe. |
| Extracción con IA | `lib/leads.mjs` (`EXTRACT_SCHEMA`, `json_schema` cerrado) y `lib/agent.mjs` (PDF/imagen como bloques) | Mismo patrón para leer el BOL y el comprobante, con un prompt que ignora instrucciones dentro del mail. |
| Hoja de despacho | `waLink` en `src/App.jsx:2834`, `offer()` en `src/pipeline.jsx:379` | El texto de la orden ya existe. `offer()` guarda `offered_to/offered_rate` en `job_leads`. |
| Lista de carriers | `pipeline_settings.settings.carriers` (`src/pipelineData.js:55`) | Hoy es texto libre. Se reemplaza por la tabla `carriers`. |
| Registrar el cobro | `record_payment` en `lib/recipes.mjs:197` | Sincroniza `bol_collected`, deja audit en `action_log` y se puede deshacer. |
| Plata en mano | `payments.cash_with_whom` | Hoy marca qué driver tiene el efectivo. Para un carrier: el cliente pagó, la plata la tiene el carrier hasta liquidar. |
| Avisos | `notifyTeam` en `lib/customerLine.mjs:123` | Aviso por Telegram de docs nuevos, diferencias y saldos vencidos. |

**Restricciones:**
- `api/` está en el tope de **12 funciones** del plan Hobby. Todo lo nuevo entra como acciones dentro de `api/agent-hub.mjs`, más un rewrite en `vercel.json`.
- Vercel corta los bodies en **4.5 MB**. Los adjuntos no pasan por la función: Apps Script los sube directo a Storage con una URL firmada que le da el CRM.
- Hobby permite **un solo cron**. El polling de la casilla lo hace Apps Script.

---

## Núcleo (igual en las tres opciones)

### Tablas nuevas

Las cinco tablas comparten estas reglas:
- llevan `deleted_at` (soft delete);
- tienen su entrada en `TABLE_ACL` / `SOFT_DELETE_TABLES` (`lib/acl.mjs`);
- `carrier_dispatches` es hija de `carriers` en `CASCADE_CHILDREN` (`src/undo.js`);
- se crean con un script `scripts/setup-carriers.mjs`.

| Tabla | Campos clave |
|---|---|
| `carriers` | `name`, `mc_number`, `dot_number`, `email`, `whatsapp`, `contact`, `insurance_expires`, `default_rate_per_cf`, `payment_terms`, `language`, `active` |
| `carrier_dispatches` | `job_number` (→ `storage_jobs`), `carrier_id`, `rate_type` (`per_cf`/`flat`), `rate_per_cf`, `flat_rate`, `est_cf`, `final_cf`, `extras`, `expected_collect`, `collected`, `collected_method`, `status`, `channel`, `token`, `sent_at`, `accepted_at`, `delivered_at`, `settled_at` |
| `carrier_inbox` | `channel` (`mail`/`wa`/`portal`), `from`, `subject`, `body`, `message_id` (único), `attachments` (rutas en el bucket privado `carrier-docs`), `dispatch_id` (cuando se vincula), `extraction` (jsonb: job, CF final, cobrado, método, fecha, firmas, confianza, alertas), `review_status`, `reviewed_by` |
| `carrier_payments` | `carrier_id`, `direction` (`in` = nos paga / `out` = le pagamos), `amount`, `method`, `date`, `ref`, `bank_transaction_id`, `allocations` |
| `carrier_adjustments` | `carrier_id`, `dispatch_id`, `amount` (con signo), `reason` (claim, daño, pads, cancelación), `notes` |

**Estados del despacho:**

```
enviado → aceptado → en_curso → entregado → docs → verificado → liquidado
                                                 ↘ disputa
```

### La cuenta

Va en `src/carrierData.js`, puro y testeado en `scripts/test-carrier-data.mjs`.

```
le_corresponde = rate × CF_final (o flat) + extras_del_carrier
neto_job       = cobró_el_carrier − le_corresponde      (> 0 nos debe · < 0 le debemos)
saldo          = Σ neto_job (verificados) + Σ ajustes − pagos recibidos + pagos hechos
```

Ejemplo: 950 CF × $2.60 = $2,470 le corresponden. El carrier cobró $3,180 (el
balance después del depósito que cobramos nosotros), así que nos debe $710. Si
el cliente nos pagó casi todo con tarjeta y el carrier cobró $780 sobre $2,100,
le debemos $1,320.

Cuando se aprueba un despacho, el cobro también se registra como pago del job
(`cash_with_whom` = el carrier). Así el saldo del cliente queda en cero y la
plata figura en manos del carrier hasta liquidar.

### Alertas

- Lo cobrado es menor que lo esperado: el cliente quedó debiendo.
- El CF final difiere más de ±10% del estimado.
- Faltan firmas en el BOL.
- El job figura entregado y pasaron 48 h sin docs.
- El despacho no se aceptó en 24 h.
- Hay saldo vencido.
- El seguro o la autoridad del carrier están vencidos: esto **bloquea el despacho**.

### UI

`src/carriers.jsx` es una sección de Finance, cableada como `apar`:
- `NAV` en `src/App.jsx:3782`;
- `PAGE_META` en `:3858`;
- el bloque de render.

Tiene cuatro vistas:

| Vista | Qué muestra |
|---|---|
| **Saldos** | Uno por carrier, con aging. |
| **Despachos** | Filtrable por carrier. |
| **Docs para revisar** | Lo que leyó la IA al lado del adjunto, con *Aprobar*, *Corregir* y *Disputa*. |
| **Pagos y ajustes** | Pagos en los dos sentidos y ajustes. |

En el detalle del job aparece un botón **Despachar**. Todo string nuevo lleva su entrada en `I18N_ES` y tiene que pasar `npm run i18n:check`.

---

## Las tres opciones (cambia sólo el canal)

| | **A · Gmail + WhatsApp asistido** | **B · Todo por API** | **C · Portal del carrier** |
|---|---|---|---|
| Orden por mail | Apps Script manda desde `dispatch@` la cola que arma el CRM (patrón bank-digest) | Servicio de email (Postmark, Resend o similar) desde Vercel, al instante | Mail con link único |
| Orden por WhatsApp | `wa.me` armado: un toque para enviar, queda logueado | API de WATI con plantilla aprobada por Meta | Link por WhatsApp |
| Vuelta de docs | Apps Script lee `dispatch@` cada 1–5 min y sube los adjuntos con URL firmada; después avisa a `carrier_inbound` | Webhook inbound del proveedor de mail + WhatsApp entrante por `/api/wati-webhook` (ya existe) | El carrier sube las fotos y escribe lo cobrado; la IA sólo verifica |
| Vínculo mail → job | `dispatch+NB24107@` en Reply-To + `[NB-24107]` en el asunto; si no, la IA; si no, a mano | Dirección por job en dominio propio | Token por despacho (exacto) |
| Costo fijo | ~$0 (más centavos de IA por documento) | ~$15–50/mes más el costo de cada WhatsApp | ~$0 |
| Esfuerzo | Bajo | Medio (DNS y aprobación de plantillas) | Alto (página pública segura) |
| Riesgo | Mails sin código | Proveedores, secretos, plantillas | Adopción de los carriers |

**Recomendación:**

| Fase | Qué incluye |
|---|---|
| **1** | Núcleo + opción A. |
| **2** | Portal (C) con aceptación del rate (rate confirmation en PDF con `pdf-lib`; DocuSign opcional, ya integrado en `lib/docusign.mjs`), estado de cuenta semanal por carrier y cruce con Zelle/ACH en Bancos. |
| **3** | WhatsApp automático por WATI, si el volumen lo justifica. |

### Acciones nuevas (sin función nueva)

Todas viven en `api/agent-hub.mjs`.

| Acción | Para qué | Quién la llama |
|---|---|---|
| `carrier_inbound` | Recibe el mail ya parseado, crea `carrier_inbox`, entrega URLs firmadas para los adjuntos y, al confirmarse la subida, corre la extracción. | Apps Script, con secreto propio, mismo patrón que `inbound_email`. |
| `carrier_outbox` | Devuelve los mails de despacho pendientes y recibe el ACK. | Apps Script, mismo patrón que `bank-digest`. |
| `carrier_portal` | Ver la orden, aceptar y subir docs, autenticado por el token del despacho. | El portal (opción C). |

### Seguridad

- Sólo se procesan mails de direcciones cargadas en el carrier. El resto queda apartado, como los drops del Pipeline.
- Los adjuntos van al bucket **privado** `carrier-docs`. No repetir el acceso anónimo de `payment-docs`.
- La IA no aplica nada sola salvo que se active el auto-aprobar. Todo pasa por `action_log` y se puede deshacer.

---

## Decisiones pendientes (socios)

1. ¿Qué canal: A, B, C, o A ahora y C después?
2. ¿La IA puede aprobar sola cuando todo coincide (código, monto esperado, CF ±3%, firmas)?
3. ¿Quién cobra el depósito: siempre nosotros, o a veces el carrier?
4. ¿Rate por CF o fijo? ¿Se ajusta al CF final? ¿Hay mínimo?
5. ¿Cómo se reparten los extras (shuttle, long carry, packing)?
6. ¿Cada cuánto se liquida y por dónde (Zelle, ACH, cheque)?
7. ¿La casilla es `dispatch@` en Workspace o una Gmail aparte?
8. ¿Cuántos jobs por mes van a carriers? (define si vale la opción B)
9. ¿Alcanza con "ACCEPT" o exigimos el rate confirmation firmado?
10. ¿Los claims y daños se descuentan del saldo del carrier? ¿Quién los autoriza?
