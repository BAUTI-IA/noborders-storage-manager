# Agente de voz en tiempo real

El mismo agente del CRM, pero hablado. Abrís el chat flotante, tocás la pestaña
**🎙️ Voice**, apretás el micrófono y hablás normal: el audio va directo a un
modelo de voz a voz por un socket de baja latencia y te contesta en voz. Sirve
manejando, cargando un camión o caminando por el depósito — sin manos.

- **Consultar**: "¿Qué entregas hay esta semana?", "¿Cuánto debe todavía el job
  1201?", "¿Cuántas unidades libres quedan en Miami?"
- **Cargar / modificar**: "El camión 3 está saliendo de Ocala", "Imputale mil
  ochocientos en Zelle al job 1201", "Armá un trip con los jobs 1201 y 1198".
- **Interrumpirlo**: si se está yendo por las ramas, hablale encima y corta.

Antes de escribir cualquier cosa te lee el plan y espera un **"sí"** hablado (o
el botón **Confirm** del panel). Es la misma regla que por chat, WhatsApp y
Telegram, con la misma auditoría en **Trash / History**.

## Bilingüe

Español e inglés son los dos de primera clase, y el agente sigue al que habla —
si arrancás en español y metés una frase en inglés, cambia ahí mismo. Nunca
pregunta en qué idioma querés hablar.

Tres piezas hacen que funcione:

- **La transcripción autodetecta.** No hay idioma fijado (por eso se sacó
  `languages`), así que una frase mezclada se transcribe como se dijo. Si algún
  acento le cuesta, `VOICE_TRANSCRIBE_LANGUAGE` lo pinea.
- **El saludo sale en el idioma del CRM.** Es el único momento sin señal:
  todavía nadie habló. El panel manda el idioma que tenés elegido en Settings
  con cada pedido, y de ahí en adelante manda lo que decís vos.
- **El vocabulario del negocio queda en inglés**, aunque hable en español —
  job, broker, trip, storage, warehouse, live load, BOL, CF, closing sheet,
  settlement, pads. Es la misma convención que el resto del CRM (CLAUDE.md):
  traducir "job" a "trabajo" en voz alta suena mal y nadie habla así.

Un detalle que costó encontrar: el agente derivaba al castellano a mitad de una
conversación en inglés, justo después de una consulta. La causa era que las
instrucciones, el directorio del CRM y los resultados de las queries estaban
salpicados de castellano, y el modelo los leía de nuevo en cada turno y los
tomaba como pista de idioma. Ahora los ejemplos hablados van **en los dos
idiomas** (ninguno sesga), el directorio se generó en inglés como el resto del
código fuente, y la instrucción dice explícitamente que solo las palabras de la
persona definen el idioma — los datos no.

Y una segunda causa, que costó más: el equipo **habla inglés con acento
español**, y el modelo estaba leyendo el acento como un pedido de cambio de
idioma — derivaba un turno y volvía solo. Ahora la instrucción dice
explícitamente que el idioma se juzga por las PALABRAS y nunca por el acento, y
que cambiar es deliberado: hace falta una frase entera en el otro idioma, nunca
a mitad de un intercambio.

Como eso sigue siendo prompting y no una garantía, el panel tiene un **candado
de idioma** (`Auto` / `EN` / `ES`) al lado del transporte:

- En `Auto` sigue al que habla, que es lo que querés con un equipo bilingüe.
- Fijado, el modelo habla solo ese idioma pase lo que pase — y la transcripción
  también deja de adivinar, porque se le pasa el idioma.
- Se puede cambiar **en medio de una llamada**: no reconecta (perderías el hilo
  de la conversación), le manda una instrucción a la sesión viva, igual que los
  botones de Confirm / Cancel.

El panel en sí (botones, estados, métricas, mensajes de error) se traduce con el
sistema de siempre — `I18N_ES` y `tr()`. Lo que lee el **modelo** queda siempre
en inglés: son directivas de prompt, no copy de interfaz, y el modelo las dice
en el idioma de quien está hablando.

Una excepción conocida: los mensajes de permiso denegado vienen de
`lib/agentWrite.mjs` y `lib/acl.mjs`, que están en castellano y los comparten
todos los canales (chat, Telegram, WhatsApp). Al modelo no le molesta — los lee
y los dice en inglés — pero el chip rojo del panel los muestra tal cual.
Traducirlos es un cambio aparte, que toca al agente de texto también.

## Cómo funciona

```
navegador ──(WebRTC o WebSocket: audio en los dos sentidos)──► modelo de voz
    │                                                              │
    │   function call: crm_lookup / crm_ask / crm_plan / …  ◄───────┘
    ▼
POST /api/agent-hub {action:"voice_tool"} ──► lib/voice.mjs ──► lib/agent.mjs
```

El modelo de voz **no tiene acceso al CRM**. Pone la conversación: escucha,
decide cuándo terminó tu turno, habla. Todo lo que toca datos vuelve como una
llamada a función que el navegador reenvía a `/api/agent-hub`, donde se
resuelve con **tu** JWT de Supabase y **tus** permisos del CRM (`lib/acl.mjs`).
El navegador es un caño: aunque alguien lo modifique, no puede ampliar lo que
tiene permitido.

La clave de OpenAI nunca sale del servidor. El navegador recibe un
`client_secret` efímero (`ek_…`, 10 minutos) atado a una configuración de sesión
que armamos nosotros: instrucciones, herramientas, voz y detección de turno
quedan fijadas al emitirlo.

### Herramientas que ve el modelo

| Herramienta | Para qué | Costo |
|---|---|---|
| `crm_lookup` | Un `SELECT` de solo lectura. El camino rápido para un dato concreto. | 1 ida y vuelta |
| `crm_ask` | Le pasa la pregunta al agente de texto (análisis multi-paso, deuda real, settlements). | lento: es otro agente entero |
| `crm_plan` | Propone un cambio. **No escribe nada**: devuelve el plan para leerlo en voz alta. | — |
| `crm_confirm` | Ejecuta el plan que ya leyó. Solo después de un sí explícito. | — |
| `crm_cancel` | Descarta el plan pendiente. | — |

A quien no tiene permisos de escritura en el CRM la sesión se le emite **sin**
`crm_plan` / `crm_confirm` / `crm_cancel`: no puede pedir lo que no existe.

La voz usa su propia clave de conversación (`voice:<email>`), separada de la del
chat escrito (`app:<email>`). Un plan armado por chat nunca se ejecuta con un
"sí" hablado, ni al revés.

## Latencia

Lo que se siente es el hueco entre que terminás de hablar y arranca la
respuesta. Lo que hacemos para achicarlo:

- **El token se pide al abrir el panel**, no al hablar; emitirlo además calienta
  los caches de esquema y directorio del agente.
- **El directorio del CRM viaja dentro de las instrucciones** (brokers, drivers,
  trucks, trips abiertos, storages con sus ids), así que resolver "el broker
  Full Value" cuesta cero consultas.
- **El esquema va recortado** a un presupuesto de caracteres, tablas calientes
  primero; las que no entran quedan nombradas para que sepa que existen.
- **Detección de turno semántica** con `eagerness: high`: corta cuando la frase
  cerró, no cuando hay silencio.
- **Barge-in** (`interrupt_response`): si hablás encima, se calla.
- **Relleno hablado antes de cada herramienta** ("Dejame ver…"): la consulta
  corre mientras habla, así que el silencio desaparece.
- **Se mide todo y se muestra** en la barra del panel: `conn` (abrir la sesión),
  `reply` (fin de tu frase → primera palabra suya), `p50` (mediana de la
  sesión), `tool` (última llamada al CRM).

## Corte por inactividad

Mientras el panel está conectado el micrófono **sigue transmitiendo, hable
alguien o no**, y el silencio se factura como cualquier otro audio. Un panel
abierto y olvidado gasta hasta que alguien se avive. Que el `client_secret`
venza a los 10 minutos no lo corta: eso solo impide abrir sesiones nuevas, la
que ya está abierta sigue.

Así que a los **2 minutos sin que nadie hable** corta sola y lo dice en el
panel. Los últimos 20 segundos aparece una cuenta regresiva abajo, y cualquier
cosa que alguien diga la resetea. Nunca corta con una consulta o una respuesta
en vuelo: ahí la persona está esperando, no ociosa.

La decisión vive en `src/voiceData.js` (`idleState`), separada del JSX para
poder testearla; los tiempos son `IDLE_HANGUP_MS` y `IDLE_WARN_MS`.

## Los dos transportes

El selector del panel cambia el transporte sin tocar nada más — el protocolo de
eventos es el mismo.

- **WebRTC** (por defecto): el audio va en Opus sobre RTP y lo maneja el
  navegador — jitter buffer, recuperación de paquetes perdidos y, lo que más
  importa en manos libres, **cancelación de eco** contra lo que el agente está
  diciendo. Los eventos viajan por un data channel.
- **WebSocket**: PCM16 crudo en base64 en los dos sentidos, capturado con un
  `AudioWorklet` y reproducido acá a mano. Más bajo nivel y más fácil de pasar
  por un proxy, pero **sin cancelación de eco: usá auriculares**.

## Configuración

Variables de entorno en Vercel (todas opcionales salvo la primera):

| Variable | Default | Qué hace |
|---|---|---|
| `OPENAI_API_KEY` | — | **Requerida.** La misma que ya usa la transcripción de audios. |
| `VOICE_MODEL` | `gpt-realtime` | Modelo de voz a voz. |
| `VOICE_VOICE` | `marin` | Voz: `marin`, `cedar`, `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`. |
| `VOICE_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | Solo llena la transcripción en pantalla; no frena la respuesta hablada. |
| `VOICE_TRANSCRIBE_LANGUAGE` | (vacío) | Default para todos: vacío = detección automática. Un código ISO (`es` / `en`) lo fija. El candado del panel lo pisa por sesión. |
| `VOICE_SPEED` | `1.05` | Velocidad al hablar (0.25–1.5). |
| `VOICE_SCHEMA_BUDGET` | `7000` | Caracteres de esquema que entran en las instrucciones. |
| `AGENT_WRITES_ENABLED` | `true` | En `false` la voz queda en solo lectura, igual que el resto de los canales. |

### Parámetros que un modelo no acepta

Qué knobs acepta cada modelo de voz varía, y la API contesta con un 400 que
nombra el path exacto (`session.audio.input.transcription.languages`). Como son
todos de afinado, `mintVoiceSession` **saca el parámetro rechazado y reintenta**
en vez de dejarte sin sesión: perdés un poco de pulido, no la feature. Lo que se
quitó viaja en el campo `dropped` de la respuesta del token (visible en la
pestaña Network) y queda en los logs de Vercel.

Lo único que nunca se saca es lo que hace que el agente sea el agente:
`instructions`, `tools`, `tool_choice`, `model` y `type`. Si el modelo rechaza
alguno de esos, la sesión falla — como corresponde.

No hace falta ninguna función nueva en Vercel: las dos acciones (`voice_token` y
`voice_tool`) viven dentro de `api/agent-hub.mjs`, que ya existía.

**Requiere HTTPS** (o `localhost`): sin eso el navegador no da acceso al
micrófono.

## Probarlo

```bash
node scripts/test-voice.mjs     # sesión, herramientas y permisos — sin red ni DB
npm run i18n:check              # el panel es UI: tiene que pasar
```

## Archivos

- `lib/voice.mjs` — instrucciones, catálogo de herramientas, emisión del
  `client_secret` y ejecución de cada llamada con los permisos del usuario.
- `src/voiceData.js` — la lógica pura del corte por inactividad.
- `src/voiceAgent.jsx` — los dos transportes, el audio, el manejo de eventos, las
  métricas y el panel. El orden de los globos sale de `conversation.item.added`
  / `.created` (que llegan en el orden real de la conversación y traen
  `previous_item_id`), NO del orden en que llega el texto: la transcripción de
  lo que decís corre asincrónica y termina después de que el agente ya empezó a
  contestar, así que ordenar por llegada pone la respuesta arriba de la
  pregunta.
- `api/agent-hub.mjs` — acciones `voice_token` y `voice_tool`.
- `lib/agent.mjs` — el cerebro compartido; la voz entra por `handleIncoming` con
  `readOnly` / `decision` / `detail`.
