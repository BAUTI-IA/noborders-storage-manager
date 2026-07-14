# Verizon Connect (Reveal) — GPS en vivo de los camiones

El mapa **Live Load** puede traer las posiciones GPS reales desde Verizon Connect
Reveal. La conexión la hace la función serverless `api/verizon-sync.mjs` (las
credenciales viven en Vercel, nunca en el navegador ni en el código).

## Credenciales necesarias

| Variable | Qué es | Dónde se consigue |
|---|---|---|
| `VERIZON_APP_ID` | App ID de la app creada en el Developer Portal | developer.verizonconnect.com → My Apps → tu app → Security → App ID |
| `VERIZON_USERNAME` | Usuario **REST de integración** de Reveal | Reveal → Marketplace/Admin → "API and webhook integrations" (o pedirlo a soporte). ⚠️ No es el login web: el login web autentica pero no devuelve datos. |
| `VERIZON_PASSWORD` | Contraseña de ese usuario REST | Ídem |
| `VERIZON_BASE_URL` | (Opcional) URL base regional | Por defecto `https://fim.api.us.fleetmatics.com` (EE.UU.) |

## Configuración (una sola vez)

1. En **Vercel** → proyecto → *Settings* → *Environment Variables*, cargar
   `VERIZON_APP_ID`, `VERIZON_USERNAME` y `VERIZON_PASSWORD` (Production).
2. Verificar que `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya estén
   configuradas (las usan otras funciones como el webhook de DocuSign).
3. Redeploy.

> Ojo: si algún día cambia la contraseña de Reveal, hay que actualizar
> `VERIZON_PASSWORD` en Vercel o el sync deja de funcionar.

## Cómo se vinculan los camiones

El sync matchea cada camión activo del CRM con un vehículo de Verizon en este
orden:

1. **Verizon vehicle** (`trucks.verizon_vehicle_id`) — en Trucks → Edit hay un
   dropdown que lista la flota real de Verizon para elegir el vehículo.
2. **VIN** (si está cargado en ambos lados).
3. **Nombre**: exacto, por prefijo (`BT001` ↔ `BT001 - HINO Leon`) o por código
   (`BT013` ↔ `BT013LD-1750CF`).

Cuando un camión matchea por VIN o nombre, el vínculo se guarda solo (con el
`fleetItemId`, estable ante renombres). Los camiones sin match aparecen en la
nota debajo del mapa; para esos, elegí el vehículo en el dropdown del camión, o
renombrá el vehículo en Reveal para que empiece con el código (`BT004 - ...`).
Los vehículos que en Reveal se llaman `253700853_2025...` (número de serie del
equipo) no se pueden matchear automáticamente hasta renombrarlos o vincularlos
a mano.

## Diagnóstico

- `https://<deploy>/api/verizon-sync?debug=1` — corre el sync y devuelve el
  detalle técnico (vehículos que ve Verizon, rutas de ubicación probadas,
  errores crudos de la API).
- `https://<deploy>/api/verizon-sync?list=1` — solo la lista de vehículos
  (la usa el dropdown del formulario de camiones).

## Cómo funciona en la app

- En **Trips → Live map** hay un botón **⟳ Verizon** que sincroniza al toque.
- Además, mientras el mapa está abierto se auto-sincroniza cada 2 minutos.
- Cada sync actualiza `last_lat`, `last_lng`, `last_location` (dirección),
  `last_status` (en movimiento / detenido) y `last_location_at` de cada camión.
- La carga manual de ubicación ("Update location") sigue disponible como
  respaldo para camiones sin GPS de Verizon.

## Endpoints de Verizon que se usan

- `GET /token` — token de sesión (Basic auth con usuario/contraseña, dura ~20 min).
- `POST /fleetapi/v1/fleet-items/search` — flota (API nueva; paginada con
  `pageToken`, items con `fleetItemId`, `name`, `vin`, `esn`).
- Ubicación GPS: la ruta exacta de la Fleet API se auto-descubre probando las
  variantes conocidas (`/fleet-items/{id}/location`, `/locations/latest`,
  `/status`, batch `locations/search`, etc.) y se cachea la que responda. Como
  respaldo se intenta la API clásica (`GET /cmv/v1/vehicles`,
  `GET /rad/v1/vehicles/{n}/location|status`).

Todas las llamadas de datos llevan el header
`Authorization: Atmosphere atmosphere_app_id=<APP_ID>, Bearer <token>`.
