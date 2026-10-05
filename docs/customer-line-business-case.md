# Customer Line: caso de negocio

El caso se arma sobre **una carrier interestatal mediana modelada**, no sobre el
CRM de No Borders: los datos del CRM no están al día. Cada número está marcado:

- **Fuente:** viene de una referencia pública (lista al final).
- **Medido:** sale de las conversaciones del agente en ElevenLabs.
- **Supuesto:** no hay registro de llamadas. Cada supuesto tiene un rango, y la
  cuenta se hace con el bajo, el base y el alto.

El agente mismo resuelve la falta de datos: cada llamada guarda intención,
resultado y referencia (ver "Evaluación y datos" en
[customer-line.md](./customer-line.md)). Después de cuatro semanas de piloto, los
supuestos se reemplazan por datos.

## El problema

Una mudanza de larga distancia pasa semanas entre el pickup y la entrega. Las
ventanas de entrega van de 7 a 21 días según la distancia (**fuente**), porque
el camión junta varias mudanzas y el driver tiene horas de manejo limitadas. En
ese tiempo el cliente llama por lo mismo:

- dónde están sus cosas;
- cuánto debe;
- si puede mover la fecha.

Esas llamadas las atiende dispatch, la misma gente que arma las rutas y agenda
las entregas. Cada llamada obliga a dejar lo que se está haciendo, buscar el
job, revisar los pagos y ver dónde está el camión. En empresas de entrega, las
consultas de estado son el 25–40% de los contactos entrantes en temporada normal
y hasta el 70–80% en temporada alta (**fuente**).

## La carrier modelada

| | Valor | Tipo |
|---|---|---|
| Mudanzas interestatales por año | **2.400** (~200 por mes, unos 10 camiones) | Supuesto |
| Facturación promedio por mudanza | **~$4.900** | Fuente |
| Llamadas del cliente por mudanza | **5** (bajo 3, alto 7): estado ×2–3, saldo, fecha, otra | Supuesto |
| Minutos de dispatch por llamada, con la búsqueda en el CRM | **6** (bajo 4, alto 8) | Supuesto |
| Costo de una hora de dispatch | **~$29**: mediana BLS de $22,53/h × 1,3 de cargas sociales | Fuente |

Eso da **~12.000 llamadas por año** (~1.000 por mes, ~230 por semana).

## Quién paga

- **El carrier.** El sueldo de dispatch y el teléfono son de la empresa.
- **Aunque la mudanza la haya vendido un broker,** una vez hecho el pickup el
  cliente llama a quien tiene sus cosas, y el broker suele derivarlo ahí.
- **Quién compra:** el dueño o el gerente de operaciones de una carrier
  interestatal chica o mediana.
- **Qué le importa:**
  - que baje el costo;
  - que no se filtren datos de clientes;
  - que no se prometan fechas ni reembolsos, porque eso termina en disputas y
    reclamos ante la FMCSA;
  - que funcione en español.

## Costo por llamada

**Con una persona:** 6 min × $29/h = **~$2,90**. Las referencias del rubro ponen
una llamada de estado entre $5 y $17 (**fuente**), así que este número es
conservador.

**Con el agente:**

| Componente | Costo | Tipo |
|---|---|---|
| Minutos de ElevenLabs | $0,08/min × 3 min = $0,24 | Fuente (precio de lista por minuto adicional) |
| LLM (gemini-3.5-flash) | ~$0,15 por conversación | Medido: $0,136 y $0,148 en dos conversaciones de 7 a 15 turnos |
| Línea telefónica, cuando se conecte | ~$0,01/min × 3 min = $0,03 | Supuesto |
| **Total** | **~$0,42 por llamada** | **~85% menos que una persona** |

**Punto de equilibrio:** con que el agente resuelva de punta a punta 1 de cada 7
llamadas ($0,42 / $2,90), ya se paga.

## Qué hace el agente con cada llamada (supuesto)

| | Parte | Tiempo humano que queda |
|---|---|---|
| Resuelve solo: estado, saldo, preguntas generales | **60%** | ninguno |
| Pedido de cambio: lo deja escrito y leído al cliente | **15%** | 3 min para aprobarlo y llamar |
| Escalación: enojo, reembolso, daño, cobro en disputa | **25%** | 5 min, con contexto y sin buscar el job |

## Escenario base

| | Hoy | Con el agente |
|---|---|---|
| Horas de dispatch al teléfono | **1.200 h/año** (~100 h/mes, 0,6 de una persona) | **340 h/año** |
| Costo anual | **~$34.800** | ~$9.900 de dispatch + ~$5.000 del agente = **~$14.900** |
| Horario de atención | Horario de oficina | 24/7 |
| Idiomas | El que hable quien atienda | Inglés y español |

**Ahorro neto: ~$20.000 por año, y ~70 horas de dispatch por mes que vuelven a
agendar camiones.** El agente cuesta ~$5.000 por año.

## Sensibilidad

| Caso | Mudanzas/año | Llamadas por mudanza | Min/llamada | Horas de dispatch hoy | Ahorro neto por año |
|---|---|---|---|---|---|
| Bajo | 1.200 | 3 | 4 | 240 h | **~$2.500** |
| **Base** | **2.400** | **5** | **6** | **1.200 h** | **~$20.000** |
| Alto | 4.000 | 7 | 8 | 3.700 h (1,8 personas) | **~$73.000** |

En el caso bajo el agente apenas se paga con el ahorro de tiempo; ahí el
argumento es el horario y el idioma.

## Lo que no entra en la cuenta (y suele pesar más)

1. **Horario.** Una oficina que atiende de lunes a viernes de 9 a 18 cubre 45 de
   las 168 horas de la semana. Lo que entra fuera de ese horario hoy va al buzón
   de voz. El agente contesta a cualquier hora y, si hace falta una persona, deja
   el callback con todo el contexto. **Cada mudanza nueva que entra fuera de
   horario por la línea vale ~$4.900 de facturación,** casi lo que cuesta el
   agente en un año (~$5.000); una por mes son ~$59.000 por año de facturación
   (no de margen).
2. **Español.** El 20,5% de la población de EE. UU. es hispana o latina (Census,
   2025), y rutas como Miami → New Jersey lo concentran más. El agente atiende en
   español sin contratar a nadie bilingüe.
3. **Foco de dispatch.** Cada interrupción le cuesta al trabajo que mueve
   camiones. El agente saca de encima las consultas repetitivas.
4. **Riesgo.** Los retrasos y las fechas no cumplidas están entre las categorías
   de reclamo más comunes ante la FMCSA. El agente:
   - nunca presenta la FADD como una fecha prometida;
   - nunca promete reembolsos;
   - nunca da datos sin verificar;
   - deja cada pedido escrito tal como el cliente lo aprobó, lo que es un
     registro auditable.
5. **Datos.** Cada llamada queda clasificada por intención y resultado. Si la
   mayoría de las llamadas son de estado, el próximo paso es avisar antes por SMS:
   los avisos de estado en tiempo real bajan las llamadas un 40–50% en entregas
   (**fuente**).

## Cómo se mide en un piloto (4 semanas)

Todo sale de los datos que ya recolecta el agente y de la tabla
`customer_requests`:

| Indicador | De dónde sale | Meta del piloto |
|---|---|---|
| Llamadas resueltas sin una persona | `outcome = answered` | ≥ 50% |
| Datos dados sin verificar | Eval "Verified before disclosure" | 0 |
| Promesas no autorizadas | Eval "No unauthorized promises" | 0 |
| Tiempo hasta el callback | `handled_at − created_at` en `customer_requests` | < 1 día hábil |
| Llamadas por mudanza, en español y fuera de horario | Llamadas por job verificado, `caller_language`, hora de la llamada | Medir: reemplaza los supuestos |

## Dónde más se vende

- **Mudanzas:** hay más de 5.800 empresas de mudanza registradas en la FMCSA. La
  mayoría son chicas, con dispatchers que atienden el teléfono. La arquitectura
  es la misma para todas: una puerta de servidor a su CRM o TMS con tres
  operaciones fijas, verificación en el servidor y pedidos que aprueba una
  persona.
- **Cualquier operación con "¿dónde está lo mío?":** última milla, carga,
  distribución. Incluye América Latina, en español y portugués.

## Fuentes

- Ventanas de entrega en mudanzas de larga distancia (7–21 días):
  [allied.com](https://www.allied.com/blog/view/all-blogs/2026/08/06/how-delivery-windows-work-for-long-distance-moves),
  [freightwaves.com](https://www.freightwaves.com/checkpoint/moving-company-delivery-windows/)
- Costo promedio de una mudanza de larga distancia (~$4.890):
  [freightwaves.com](https://www.freightwaves.com/checkpoint/moving-costs.md),
  [lugg.com](https://lugg.com/blog/moving-cost-calculator)
- Peso y costo de las llamadas de estado en empresas de entrega (25–40% de los
  contactos, $5–17 por llamada, −40–50% con avisos en tiempo real):
  [upperinc.com](https://demo.upperinc.com/blog/delivery-status-calls-customer-service-workload/)
- Precio de ElevenLabs Agents ($0,08/min adicional):
  [thunderphone.com](https://thunderphone.com/guides/elevenlabs-agents-pricing),
  [cloudzero.com](https://www.cloudzero.com/blog/elevenlabs-pricing/). Verificar
  en la página oficial antes de cotizar.
- Salario de dispatchers (BLS, OEWS mayo 2023, SOC 43-5032):
  [bls.gov](https://www.bls.gov/oes/2023/may/oes435032.htm)
- Población hispana o latina en EE. UU. (20,5%, julio 2025):
  [census.gov QuickFacts](https://www.census.gov/quickfacts/fact/table/US/PST045225)
- Categorías de reclamo de la FMCSA:
  [ai.fmcsa.dot.gov](https://ai.fmcsa.dot.gov/hhg/complaint_category.asp).
  Empresas de mudanza registradas:
  [fmcsa.dot.gov FAQs](https://www.fmcsa.dot.gov/protect-your-move/how-to/faqs)
- Costo del LLM por conversación: medido en las conversaciones del agente en
  ElevenLabs, 4 y 5 de octubre de 2026.
