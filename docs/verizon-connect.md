# Verizon Connect (Reveal) — GPS en vivo de los camiones

El mapa **Live Load** puede traer las posiciones GPS reales desde Verizon Connect
Reveal. La conexión la hace la función serverless `api/verizon-sync.mjs` (las
credenciales viven en Vercel, nunca en el navegador ni en el código).

## Credenciales necesarias

| Variable | Qué es | Dónde se consigue |
|---|---|---|
| `VERIZON_APP_ID` | App ID de la app creada en el Developer Portal | developer.verizonconnect.com → My Apps → tu app → Security → App ID |
| `VERIZON_USERNAME` | Usuario de login de Reveal | El email/usuario con el que entrás a Reveal |
| `VERIZON_PASSWORD` | Contraseña de ese usuario | La misma del login de Reveal |
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

El sync matchea cada camión activo del CRM con un vehículo de Reveal en este
orden:

1. **Verizon vehicle #** (`trucks.verizon_vehicle_id`) contra el *Vehicle
   Number* de Reveal — editable en Trucks → Edit → "Verizon vehicle #".
2. **VIN** (si está cargado en ambos lados).
3. **Nombre** del camión contra el *Name* o *Vehicle Number* de Reveal.

Cuando un camión matchea por VIN o nombre, el "Verizon vehicle #" se guarda
solo para la próxima vez. Los camiones sin match aparecen listados en la nota
debajo del mapa — ahí conviene cargarles el número a mano.

## Cómo funciona en la app

- En **Trips → Live map** hay un botón **⟳ Verizon** que sincroniza al toque.
- Además, mientras el mapa está abierto se auto-sincroniza cada 2 minutos.
- Cada sync actualiza `last_lat`, `last_lng`, `last_location` (dirección),
  `last_status` (en movimiento / detenido) y `last_location_at` de cada camión.
- La carga manual de ubicación ("Update location") sigue disponible como
  respaldo para camiones sin GPS de Verizon.

## Endpoints de Verizon que se usan

- `GET /token` — token de sesión (Basic auth con usuario/contraseña, dura ~20 min).
- `GET /cmv/v1/vehicles` — lista de vehículos de la cuenta.
- `GET /rad/v1/vehicles/{n}/location` — última posición GPS (lat/lng, dirección).
- `GET /rad/v1/vehicles/{n}/status` — estado (Moving / Idle / Stopped).

Todas las llamadas de datos llevan el header
`Authorization: Atmosphere atmosphere_app_id=<APP_ID>, Bearer <token>`.
