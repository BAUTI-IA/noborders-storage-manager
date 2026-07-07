# ELDs en el CRM — Verizon Connect + Motive

Los camiones aparecen en el mapa de **Trips / Live Load** con su posición
GPS real, sacada directamente de los ELDs de la flota. Soportamos los dos
proveedores que usamos: **Verizon Connect Reveal** y **Motive**
(ex KeepTruckin). Cada camión puede estar vinculado a uno u otro (o a los
dos: gana la lectura más reciente).

## Cómo funciona

1. La función serverless [`api/eld-sync.mjs`](../api/eld-sync.mjs) consulta
   los APIs de Verizon y Motive, matchea cada vehículo con el camión del
   CRM y guarda `last_lat / last_lng / last_location / last_status /
   eld_source` en la tabla `trucks` de Supabase.
2. El workflow [`eld-sync.yml`](../.github/workflows/eld-sync.yml) la llama
   **cada ~10 minutos** (GitHub Actions puede demorar el cron unos minutos;
   para tracking operativo alcanza de sobra).
3. Supabase **Realtime** ya empuja los cambios de `trucks` a todas las
   pestañas abiertas: el mapa se mueve solo, sin recargar.
4. En el mapa también hay un botón **🛰️ Sync ELD** para forzar una
   sincronización al instante, y el formulario de ubicación manual sigue
   funcionando como override (queda marcado como "Manual").

## Setup (una sola vez)

### 1. Credenciales de Verizon Connect Reveal

El API REST de Reveal usa un **usuario de API** (distinto del login web) más
un **App ID**:

1. En Reveal: **Admin → Usuarios** (o pidiéndolo a soporte de Verizon
   Connect) creá/pedí un usuario habilitado para el **REST API** y anotá su
   usuario y contraseña.
2. Pedí también el **atmosphere App ID** de la cuenta (soporte lo entrega
   junto con el acceso API).
3. En Vercel (**Settings → Environment Variables** del proyecto) cargá:
   - `VERIZON_REVEAL_USERNAME`
   - `VERIZON_REVEAL_PASSWORD`
   - `VERIZON_REVEAL_APP_ID`
   - `VERIZON_REVEAL_BASE_URL` *(opcional; default
     `https://fim.api.us.fleetmatics.com`)*

### 2. Credenciales de Motive

1. En el dashboard de Motive: **Admin → API Keys → New API Key** (alcanza
   con permiso de lectura de vehículos / ubicaciones).
2. En Vercel cargá:
   - `MOTIVE_API_KEY`
   - `MOTIVE_BASE_URL` *(opcional; default `https://api.gomotive.com`)*

> Se puede configurar **uno solo** de los dos proveedores: el otro
> simplemente se saltea.

### 3. Secreto del cron

1. Inventá una clave larga y aleatoria (ej. `openssl rand -hex 24`).
2. Cargala **dos veces**:
   - En Vercel como `ELD_SYNC_KEY`.
   - En GitHub (**Settings → Secrets and variables → Actions**) como
     `ELD_SYNC_KEY`, junto con `APP_URL` (la URL pública del CRM,
     ej. `https://tu-crm.vercel.app`).
3. Verificá que en Vercel ya existan `SUPABASE_SERVICE_ROLE_KEY` y
   `SUPABASE_URL` (las mismas que usa `api/admin-users.mjs`).

> ⚠️ Como siempre: ninguna de estas claves va en el código ni en el
> frontend. Solo variables de entorno de Vercel y secrets de GitHub.

### 4. Columnas nuevas en la base

Si el CRM no las crea solo al entrar (banner naranja en Trips), corré el
setup SQL desde el botón **View SQL** del CRM, que ahora incluye:

```sql
alter table public.trucks add column if not exists motive_vehicle_id text;
alter table public.trucks add column if not exists eld_source text;
```

### 5. Vincular cada camión

En **Trucks → editar camión → sección "ELD / GPS"**:

- **Verizon**: poné el **Vehicle Number** tal como figura en Reveal.
- **Motive**: poné el **id** o el **number** del vehículo en Motive. Si el
  VIN del camión está cargado en el CRM y coincide con el de Motive, se
  matchea solo sin completar nada.

Después tocá **🛰️ Sync ELD** en el mapa: el toast dice cuántos camiones se
actualizaron y cuántos vehículos del ELD quedaron sin vincular.

## Probarlo / diagnosticar

- **Manual desde la UI**: botón 🛰️ Sync ELD en Trips → Live map.
- **Manual desde GitHub**: Actions → *ELD location sync* → Run workflow.
- **Por curl**:
  ```bash
  curl -X POST -H "x-eld-sync-key: $ELD_SYNC_KEY" https://TU-CRM/api/eld-sync
  ```
  La respuesta incluye, por proveedor, si respondió bien
  (`"ok (N vehicles)"`) o el error exacto, la lista de camiones
  actualizados y los vehículos sin vincular.

Errores típicos:

| Síntoma | Causa probable |
|---|---|
| `Reveal /token respondió 401` | Usuario/contraseña de API incorrectos (ojo: es el usuario **de API**, no el del sitio web). |
| `Reveal ... respondió 403` | Falta el App ID o el usuario no tiene el rol REST API habilitado. |
| `Motive ... respondió 401` | `MOTIVE_API_KEY` inválida o revocada. |
| Camión no se mueve en el mapa | No está vinculado: revisá la sección ELD / GPS del camión y el listado `unmatched` de la respuesta. |
| `No pude leer trucks: ... motive_vehicle_id` | Falta correr el setup SQL (paso 4). |
