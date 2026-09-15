# Motive (ex KeepTruckin) — GPS en vivo, historial y horas de HOS

Motive es el **segundo ELD** del CRM: convive con Verizon Connect, no lo
reemplaza. Cada truck está en uno o en el otro — el que tenga cargado su campo
de vinculación — y en el live map se distinguen por una **V** o una **M** dentro
del puntito. En **Fleet → Trucks** y en **Drivers** hay además una columna **ELD**
que dice el proveedor y el número con el que está vinculado.

Sin credenciales de Motive el CRM funciona exactamente como antes: los trucks de
Verizon siguen andando y los que no tienen ELD se cargan a mano con
**Update location**.

## Credenciales: alcanza con una

| Credencial | De dónde sale |
|---|---|
| **API key** (recomendado) | Motive → **Admin → Developers → API access** (`app.gomotive.com/en-US/#/admin/developers/api`). Hace falta ser admin de la cuenta. Viaja en cada llamada como `X-Api-Key`. |
| **OAuth access token** | Solo si la cuenta se integró por OAuth 2.0. Viaja como `Authorization: Bearer`. |

Si están las dos, **gana la API key**, porque no vence.

### La key no se crea sola: se pide por mail

El botón **Request API key** no genera nada. Abre un cartel que dice que hay que
escribirle a **apisupport@gomotive.com** explicando cómo la flota va a usar la
key, y que un representante lo revisa antes de habilitarla. Motive lo plantea
como protección contra accesos no autorizados a los datos de la flota.

O sea: **entre que se pide la key y que llega hay una espera que no depende de
nosotros.** Conviene pedirla apenas se decide la integración, no el día que se
quiere prender.

Lo que el mail tiene que decir, que es lo que el representante evalúa:

- Qué es lo que se está construyendo y para qué (acá: un CRM interno de la
  operación, no un producto que se revende).
- Qué datos se leen — vehicles, vehicle locations, users/drivers, HOS logs — y
  que es **solo lectura**: el CRM nunca escribe nada en Motive.
- Cada cuánto se consulta: el mapa sincroniza solo mientras alguien lo tiene
  abierto, una vez cada 5 minutos, y es **una sola llamada para toda la flota**.
- Dónde vive la key: como variable de entorno del lado del servidor, nunca en el
  browser.

Cuando llega, se carga en Vercel y listo. **No hay que pegarla en ningún lado del
código ni del repo.**

## Variables de entorno (Vercel)

Ninguna llega nunca al browser: el servidor autentica y el cliente solo ve las
posiciones ya guardadas en `trucks`.

```
MOTIVE_API_KEY=...
```

Opcionales:

```
MOTIVE_ACCESS_TOKEN=...    # en vez de la API key, si la cuenta usa OAuth
MOTIVE_API_BASE=...        # default https://api.gomotive.com
MOTIVE_WEBHOOK_SECRET=...  # solo si se usan webhooks (más abajo)
FLEET_TZ=America/New_York  # dónde termina un día de trabajo (antes VERIZON_TZ)
```

Mientras falte `MOTIVE_API_KEY` **y** `MOTIVE_ACCESS_TOKEN`, el CRM ni ofrece
Motive como opción: la mitad de Verizon sigue igual.

## El SQL que hay que correr una vez

Dos columnas nuevas:

```sql
alter table public.trucks  add column if not exists motive_vehicle_id text;
alter table public.drivers add column if not exists motive_driver_id text;
```

El CRM las crea solo donde Supabase expone un RPC `exec_sql`. Donde no, aparece
un banner en el live map con el botón **View SQL** y hay que correrlo a mano.
**Ojo**: un deploy que ya tenía Verizon andando pasa el chequeo viejo
(`last_lat` existe) pero le faltan estas dos, así que tienen su propio probe.

## Vincular trucks y drivers

En **Fleet → Trucks**, editá el camión: en *Live tracking* hay un selector
**ELD provider** con `Ninguno / Verizon Connect / Motive`, y debajo el campo del
proveedor elegido, que ofrece la lista real de vehículos en vez de pedir que
alguien copie un número a mano.

**Un truck está en un solo proveedor.** Al guardar, el campo del otro se limpia:
así nunca se consulta la misma posición dos veces ni queda a la vista un truck
que dice pertenecer a los dos. Lo mismo para drivers y su logbook.

Para vincular todo de una: **Reports → Conectar todo con …**. Hace una pasada por
cada proveedor configurado — lee los listados, vincula por coincidencia exacta de
nombre, trae 30 días de historial y después las horas del ELD. Un truck que ya
quedó en un proveedor no se lo lleva el siguiente.

El campo guarda el **número de vehículo** de Motive cuando lo hay (más legible),
pero el sync matchea también contra el **id interno**, así que cualquiera de los
dos anda si se pega a mano. Los **drivers** sí guardan el id numérico: el
endpoint `/v1/hos_logs` no filtra por otra cosa. Si igual se cargó un nombre, el
sync lo resuelve contra el roster antes de pedir nada.

## Qué trae, y por qué endpoints

| Qué | Endpoint | Notas |
|---|---|---|
| Posición en vivo | `/v1/vehicle_locations` | **Una sola llamada para toda la flota**, al revés de Reveal que es una por vehículo. |
| Listado de vehículos | `/v1/vehicles` | Para llenar `motive_vehicle_id`. |
| Listado de drivers | `/v1/users?role=driver` | Los que tienen logbook. |
| Horas de HOS | `/v1/hos_logs` | Segmentos de duty status → `driver_hos_days`. |
| Historial de GPS | descubierto (ver abajo) | Hasta 30 días → `truck_pings`. |

Motive publica v1, v2 y v3 de los endpoints de ubicación — v3 es para vehículos
con el Motive Vehicle Gateway — y cada cuenta contesta solo en los que su
hardware y su plan cubren. El código **no asume ninguno**: prueba las variantes
conocidas, se queda con la que contesta y la recuerda mientras el lambda esté
tibio. Un 403/404 significa "esa versión no"; cualquier otro error corta la
búsqueda porque es un problema real.

La ruta del **historial** no está documentada en el portal público, así que
además de la versión se descubre la forma de la ventana (`start_date` /
`start_time` / `from`). Una respuesta vacía no se toma como prueba de que la
forma sea la correcta.

### Horas: segmentos, no eventos sueltos

Reveal manda cambios de estado ("desde este instante el driver está DRIVING").
Motive manda **segmentos** con `start_time`, `end_time` y `type`. El normalizador
convierte cada segmento en su inicio y, cuando termina y hay un hueco antes del
siguiente, cierra con un `off_duty` sintético — si no, el descanso se facturaría
como horas on-duty. Después entra a la misma aritmética que Verizon
(`lib/eld.mjs`), que parte los turnos que cruzan medianoche y contempla los dos
días de DST al año.

`driver_hos_days` **nunca** pisa `driver_work_days`: esa es la nómina que carga
la oficina, y estas horas existen justamente para compararse contra ella.

## Rate limits

Motive no publica límites. Contesta **429 con `Retry-After`** cuando decide que
estás preguntando demasiado. El cliente respeta ese header, con un tope para no
quedarse dormido todo el presupuesto de la función. Como el sync en vivo es una
sola llamada para toda la flota, el polling del mapa sale barato; el 429 importa
sobre todo en el backfill.

El mapa sincroniza **solo mientras alguien lo tiene abierto**: una vez al entrar
y después cada 5 minutos, más el botón **Sync now**. Un solo `fleet=sync` corre
los dos proveedores.

## Webhooks de GPS (opcional)

En vez de preguntar cada 5 minutos, Motive puede empujar la posición:

```
POST https://<dominio>/api/motive-gps
```

Sale por un rewrite en `vercel.json` hacia `?fleet=webhook&provider=motive`, así
tiene una URL limpia sin gastar una de las 12 funciones del plan Hobby.

Como el formulario de webhooks de Motive no siempre deja mandar un header
propio, **el mismo secreto se acepta de tres formas**:

- `Authorization: Bearer <MOTIVE_WEBHOOK_SECRET>`
- `X-Webhook-Secret: <MOTIVE_WEBHOOK_SECRET>`
- `?token=<MOTIVE_WEBHOOK_SECRET>` en la URL

Las tres se comparan en tiempo constante. **Mientras falte
`MOTIVE_WEBHOOK_SECRET`, el endpoint rechaza todo** — nunca acepta posiciones
anónimas. Eso está cubierto por `scripts/test-webhook-auth.mjs`.

El polling y el webhook conviven sin pisarse: los dos escriben las mismas
columnas de `trucks`, y el más reciente gana.

## Si algo no anda

Lo primero, el botón **Check connection** abajo del live map (`fleet=diagnose`):
pregunta desde el servidor, por cada proveedor, qué puede alcanzar la cuenta —
auth, vehículos, GPS, listado de drivers y logbook — y muestra cada chequeo con
su badge V o M.

Para ver el payload crudo de un vehículo, cómo queda mapeado y qué endpoint
ganó:

```
GET /api/geocode?fleet=probe&provider=motive&vehicle=<id o número>
```

Devuelve `{ raw, mapped, endpoints }`. Si `mapped` viene `null`, las claves de
lat/lon no coinciden con ninguna de las que busca `mapLocation()` en
`lib/motive.mjs` y hay que agregarlas ahí. **La referencia de Motive está detrás
de un portal cerrado**, así que las formas que el código tolera salen de la
documentación pública y de lo que se sabe del payload; `probe` es cómo se
confirma contra una cuenta real el primer día.

Tests del auth, el descubrimiento de versión, la paginación y todo el mapeo (sin
red, con `fetch` stubbeado):

```
node scripts/test-motive.mjs
```

Errores típicos:

- **401 en todo** → la API key está mal o fue revocada.
- **403 en todo** → la key existe pero no tiene los scopes de ese dato.
- **`checked: 0`** → ningún truck tiene cargado un vehículo de Motive.
- **"Motive does not list a vehicle X"** → el truck apunta a algo que el listado
  de la flota no menciona: casi siempre un VIN pegado donde va el número.

## Dónde vive el código

- `lib/motive.mjs` — llamadas a Motive, descubrimiento de versión, paginación,
  mapeo del payload y los syncs a `trucks`, `truck_pings` y `driver_hos_days`.
- `lib/eld.mjs` — lo que comparten los dos proveedores: la aritmética de horas
  por día, los límites del día local con DST, y la escritura de `truck_pings`.
  Una segunda copia de esa cuenta se iba a desincronizar, y el día que pase,
  la nómina y el ELD dejan de coincidir sin que nadie pueda explicar por qué.
- `api/geocode.mjs` — expone `fleet=status|sync|vehicles|drivers|probe|diagnose|hours|backfill`
  con `provider=verizon|motive`. Las acciones que escriben corren **los dos**
  proveedores por default: cada una solo toca los trucks vinculados a ella, así
  que correr los dos es el mismo trabajo más un no-op.
- `src/eldData.js` — la tabla de proveedores (letra, nombre, campos), compartida
  por `App.jsx` y `reports.jsx` sin que uno importe al otro.
- `src/App.jsx` — el selector de proveedor en los formularios, los badges V/M en
  el mapa y en las tablas, y el panel de vinculación.

Columnas que escribe: `last_lat`, `last_lng`, `last_location`,
`last_location_at`, `last_status` en `trucks`; `truck_pings`; `driver_hos_days`.
