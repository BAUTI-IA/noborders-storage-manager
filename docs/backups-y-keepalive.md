# Backups, keep-alive y salud de Supabase

Guía operativa del proyecto Supabase `noborders-storages`
(ref: `szkmktxziojzgfjkomua`). Todo esto surgió a raíz de un mail de
phishing que decía que el proyecto estaba "pausado" — era falso, el
proyecto está sano. Igual dejamos armadas las redes de seguridad reales.

---

## 1. Keep-alive (evitar que el proyecto Free se pause)

**Qué es:** los proyectos Free de Supabase se pausan solos tras **7 días
sin actividad**. El workflow [`supabase-keepalive.yml`](../.github/workflows/supabase-keepalive.yml)
toca la API del proyecto **cada 3 días** para que nunca se considere
inactivo.

**Setup:** ninguno. No usa secretos (la publishable key ya es pública).
Ya está activo. Podés dispararlo a mano en **GitHub → Actions → Supabase
keep-alive → Run workflow**.

> Hoy el proyecto recibe cientos de requests por hora, así que en la
> práctica no se pausaría igual. Esto es un seguro para épocas de poco
> uso (vacaciones, feriados largos, etc.).

---

## 2. Backup automático de la base (sin contraseña)

**Qué es:** el plan Free **no** incluye backups automáticos. El workflow
[`supabase-backup.yml`](../.github/workflows/supabase-backup.yml) corre el
script [`scripts/backup-json.mjs`](../scripts/backup-json.mjs), que exporta
**todas las tablas a JSON** usando la **service_role key** (no hace falta
la contraseña de Postgres), y sube el resultado como *artifact* de GitHub,
descargable por **30 días**. Corre **una vez por día**.

> Respalda los **datos** (las filas de cada tabla). El **esquema** (tablas,
> funciones, políticas RLS) ya está versionado en `scripts/*.sql`, así que
> entre las dos cosas tenés todo para reconstruir la base.

### Setup (una sola vez): crear el secret `SUPABASE_SERVICE_ROLE_KEY`

1. En Supabase: **Settings → API Keys**. Buscá la clave **`service_role`**
   (dice "secret"), hacé "Reveal" y **copiala**. No hay que resetear nada.

   > ⚠️ La service_role key salteа todas las políticas de seguridad (RLS).
   > Es secreta: nunca la pongas en el frontend ni la subas al repo. Acá
   > solo va como *secret* cifrado de GitHub Actions.

2. En GitHub: **Settings → Secrets and variables → Actions → New
   repository secret**.
   - **Name:** `SUPABASE_SERVICE_ROLE_KEY`
   - **Value:** la clave que copiaste.

3. Listo. El backup corre solo cada día. Para probarlo ya:
   **Actions → Supabase backup → Run workflow**.

> Mientras el secret no exista, el workflow **no falla**: simplemente se
> saltea el backup y deja un aviso.

### Cómo descargar / restaurar un backup

1. Descargá el artifact **`noborders-backup`** desde la corrida en la
   pestaña **Actions**. Adentro hay un `.json` por tabla y un
   `_manifest.json` con la cantidad de filas de cada una.
2. Para restaurar datos, se reinsertan esos JSON en la base (por ejemplo
   con un pequeño script que use la service key y haga `upsert` tabla por
   tabla, respetando el orden de las foreign keys). Si alguna vez hace
   falta, avisá y se arma el script de restore puntual.

> **Retención:** el artifact vive 30 días. Para retención más larga,
> descargá algún backup cada tanto y guardalo aparte, o pasá el proyecto a
> **plan Pro** (backups diarios gestionados con point-in-time recovery).

---

## 3. Sobre los "21 errores" de Postgres del dashboard

En el panel de Supabase (Home → últimos 60 min) aparecían ~21 errores de
Postgres. Hay que mirar el mensaje real. En la mayoría de los proyectos
con RLS bien cerrado (como este, donde `scripts/setup-rls.mjs` sacó el
acceso `anon`), esos errores son **`permission denied` / RLS denials**:
peticiones que llegan sin sesión válida y la base las rechaza. Eso es
**esperado y sano**, no un bug.

### Cómo ver el mensaje real

- **Dashboard → Logs → Postgres**, filtrando por errores; o
- **Dashboard → SQL Editor** y correr:
  ```sql
  select
    event_message,
    count(*) as veces
  from postgres_logs
  where parsed.error_severity in ('ERROR','FATAL','PANIC')
  order by veces desc
  limit 20;
  ```

Si copiás y pegás los mensajes que aparezcan, los diagnosticamos y, si
hace falta, los arreglamos en el código.
