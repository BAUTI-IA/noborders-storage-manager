# Verizon Connect (Reveal) — GPS en vivo en el live map

Los camiones aparecen solos en **Fleet → Trips / Live Load → 🗺️ Live map**, con su
posición real y si están en movimiento o detenidos. Sin la integración el mapa
sigue funcionando igual que antes: las posiciones se cargan a mano con
**Update location**.

## Credenciales: hacen falta las dos

Reveal usa un auth de dos patas y rechaza cualquier llamada a la que le falte una:

| Credencial | De dónde sale |
|---|---|
| **Usuario + password de integración** | Reveal → ícono de usuario → **Marketplace** → *API Integrations* → **GET STARTED**. Verizon las manda por mail al *developer email* que cargues. Hace falta ser admin de la cuenta de Reveal. |
| **App ID** | Portal de developers (https://fim.us.fleetmatics.com) → **Apps** → crear una app y pedirle acceso a la API. El ID queda en *My Apps*. |

El flujo real: `GET /token` con `Authorization: Basic base64(usuario:password)`
devuelve un bearer token que dura ~20 minutos; después cada llamada va con
`Authorization: Atmosphere atmosphere_app_id=<App ID>, Bearer <token>`.

## Variables de entorno (Vercel)

Ninguna de estas llega nunca al browser — el token se pide y se usa del lado del
servidor, y el cliente solo ve las posiciones ya guardadas en `trucks`.

```
VERIZON_REST_USER=REST_...@....com
VERIZON_REST_PASSWORD=...
VERIZON_APP_ID=...
```

Opcional: `VERIZON_API_BASE` (default `https://fim.api.us.fleetmatics.com`), solo
si la cuenta no es de la región US.

Mientras falte cualquiera de las tres, el CRM no muestra el botón de sync y el
mapa se queda en modo manual.

## Vincular cada camión con su vehículo de Reveal

En **Fleet → Trucks**, editá el camión y completá **Verizon vehicle number**
(sección *Live tracking*) con el número tal cual figura en Reveal. Los camiones
sin ese número siguen andando a mano — útil para los que no tienen tracker.

Para ver la lista de vehículos que devuelve Reveal:
`GET /api/geocode?fleet=vehicles` con el JWT de Supabase en `Authorization`.

## Cómo actualiza

El mapa sincroniza **solo mientras alguien lo tiene abierto**: una vez al entrar y
después cada 5 minutos, más el botón **Sync now**. No hay cron porque el plan
Hobby de Vercel solo permite crons diarios, y porque no tiene sentido consultar
GPS que nadie está mirando.

Verizon pide no consultar la posición de un vehículo más de una vez cada 3–5
minutos. El intervalo del cliente y un throttle en el servidor
(`SYNC_MIN_INTERVAL_MS`) respetan ese piso.

## Webhooks de GPS (tiempo real)

En vez de que el CRM pregunte cada 5 minutos, Reveal puede empujar la posición
apenas cambia. El endpoint es:

```
POST https://<dominio>/api/verizon-gps
```

Sale por un rewrite en `vercel.json` hacia `?fleet=webhook`, así tiene una URL
limpia sin gastar una de las 12 funciones del plan Hobby.

Reveal no firma nada: se autentica con Basic Auth usando las credenciales que se
le dan al registrar el endpoint. Hay que inventar un usuario y password y
cargarlos en Vercel:

```
VERIZON_WEBHOOK_USER
VERIZON_WEBHOOK_PASSWORD
```

**Mientras falte cualquiera de las dos, el endpoint rechaza todo** — nunca acepta
posiciones anónimas.

Después se registra la URL desde Reveal: **Admin → Integrations**, en la
integración, el botón **SUBMIT ENDPOINTS**. Ahí van la URL y esas credenciales.

El polling cada 5 min y el webhook conviven sin pisarse: los dos escriben las
mismas columnas de `trucks`, y el más reciente gana.

### El schema no está documentado públicamente

`normalizeGpsEvents()` acepta un evento suelto, un array o un batch envuelto en
`Events`/`Items`, y busca el vehículo tanto en la raíz como anidado en `Vehicle`.
Si una entrega no matchea nada, el endpoint **loguea el body completo** en los
Runtime Logs de Vercel. Ese log es cómo se confirma el schema real la primera vez
que llega un evento de verdad.

Un evento cuyo vehículo no está vinculado a ningún camión cuenta como `unmatched`
y se descarta, no rompe la entrega.

## El mapa

Por defecto corre sobre Leaflet con tiles de OpenStreetMap (calles) y Esri World
Imagery (satélite), las dos sin API key.

Si se configura una key de Google, el mapa pasa a usar Google Maps — el mismo
look de Reveal, con satélite e híbrido:

```
GOOGLE_MAPS_BROWSER_KEY
```

**Es una key distinta de `GOOGLE_MAPS_API_KEY`**, la que usa `api/distance.mjs`.
Esa vive solo en el servidor y nunca sale; la del mapa la ejecuta el navegador y
queda a la vista de cualquiera que abra el CRM. Por eso:

- La key del mapa se pide en runtime a `?fleet=mapkey`, **con sesión iniciada**, en
  vez de compilarse con un `VITE_`: así no queda dentro de un asset público.
- Igual hay que **restringirla por HTTP referrer** en Google Cloud, al dominio del
  CRM. Lo anterior es una capa, no la única.
- Nunca reusar la key del servidor acá.

Si la key no está, o si Google no carga (facturación, restricción mal puesta), el
mapa cae solo a Leaflet. Nunca queda una pantalla sin mapa.

## Dónde vive el código

- `lib/verizon.mjs` — token cacheado, llamadas a Reveal, mapeo del payload y el
  sync a `public.trucks`.
- `api/geocode.mjs` — expone las acciones `fleet=status|sync|vehicles|probe`.
  Van pegadas al geocoder y no en una función nueva porque el plan Hobby limita
  el proyecto a 12 funciones serverless y `api/` ya está en el tope.
- `src/App.jsx` — el botón de sync, el polling y el campo del camión.

Columnas que escribe (ya existen en el setup SQL): `last_lat`, `last_lng`,
`last_location`, `last_location_at`, `last_status`, `verizon_vehicle_id`.

## Qué endpoint usa

Reveal reparte los datos de vehículos entre varios productos de API y no todas las
cuentas tienen activados los mismos, así que el código **no asume ninguno**: prueba
las rutas conocidas en orden y se queda con la que responda, recordándola mientras
el lambda esté tibio. Un 403/404 significa "ese producto no", cualquier otro error
corta la búsqueda porque es un problema real.

No hace falta averiguar en el portal cuál está activada. Si ninguna responde, el
error lo dice y ahí sí hay que pedir acceso a alguna API de ubicación en
**APIs → Request access** para la app.

## Si algo no anda

Los nombres de los campos que devuelve Reveal cambian entre versiones y cuentas,
así que `mapLocation()` lee la primera clave que encuentra en vez de asumir una.
Para ver el payload crudo de un vehículo, el mapeo y qué endpoint quedó elegido:

```
GET /api/geocode?fleet=probe&vehicle=<vehicle number>
```

Devuelve `{ raw, mapped, endpoints }`: `raw` es lo que mandó Verizon, `mapped` es
lo que se guardaría y `endpoints` cuál ruta ganó. Si `mapped` viene en `null`, las
claves de lat/lng no coinciden con ninguna de las que busca `mapLocation()` y hay
que agregarlas ahí.

Tests del handshake, el descubrimiento de endpoints y el mapeo (sin red, con
`fetch` stubbeado): `npm run test:verizon`.

Errores típicos:

- **401 en `/token`** → usuario o password de integración mal (son los del mail de
  Verizon, no los del portal de developers).
- **401 en las llamadas de datos** → falta el App ID o la app no tiene acceso
  aprobado a la API en el portal.
- **`checked: 0`** → ningún camión tiene cargado el *Verizon vehicle number*.
