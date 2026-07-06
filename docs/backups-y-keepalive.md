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
Empieza a correr solo una vez que este branch se mergee a la rama por
defecto. Podés dispararlo a mano en **GitHub → Actions → Supabase
keep-alive → Run workflow**.

> Hoy el proyecto recibe cientos de requests por hora, así que en la
> práctica no se pausaría igual. Esto es un seguro para épocas de poco
> uso (vacaciones, feriados largos, etc.).

---

## 2. Backup automático de la base

**Qué es:** el plan Free **no** incluye backups automáticos. El workflow
[`supabase-backup.yml`](../.github/workflows/supabase-backup.yml) hace un
`pg_dump` completo **una vez por día** y lo guarda como *artifact* de
GitHub, descargable por **30 días**.

### Setup (una sola vez): crear el secret `SUPABASE_DB_URL`

1. En el dashboard de Supabase: **Project Settings → Database →
   Connection string** y copiá la opción **URI**.
   Va a verse así:
   ```
   postgresql://postgres.szkmktxziojzgfjkomua:TU_PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```
   Reemplazá `TU_PASSWORD` por la contraseña de la base (la que pusiste
   al crear el proyecto; si no la recordás, la reseteás en esa misma
   pantalla).

2. En GitHub: **Settings → Secrets and variables → Actions → New
   repository secret**.
   - **Name:** `SUPABASE_DB_URL`
   - **Value:** la connection string completa del paso anterior.

3. Listo. El backup corre solo cada día. Para probarlo ya:
   **Actions → Supabase backup → Run workflow**.

> Mientras el secret no exista, el workflow **no falla**: simplemente se
> saltea el dump y deja un aviso.

### Cómo restaurar un backup

1. Descargá el `.dump` desde la corrida en la pestaba **Actions**.
2. Restaurá con `pg_restore` (por ej. a un proyecto nuevo o local):
   ```bash
   pg_restore --no-owner --no-privileges \
     --dbname "postgresql://postgres:PASSWORD@HOST:5432/postgres" \
     noborders-backup-XXXX.dump
   ```

> **Importante:** el artifact vive 30 días. Si querés retención más larga,
> descargá periódicamente algún dump y guardalo fuera de GitHub, o
> conviene pasar el proyecto a **plan Pro** (incluye backups diarios
> gestionados con point-in-time recovery).

---

## 3. Sobre los "21 errores" de Postgres del dashboard

En el panel de Supabase (Home → últimos 60 min) aparecían ~21 errores de
Postgres. **No pude verlos desde el código** — hay que mirar el mensaje
real. En la enorme mayoría de los proyectos con RLS bien cerrado (como
este, donde `scripts/setup-rls.mjs` sacó el acceso `anon`), esos errores
son **`permission denied` / RLS denials**: peticiones que llegan sin
sesión válida y la base las rechaza. Eso es **esperado y sano**, no un bug.

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
hace falta, los arreglamos en el código. Errores típicos que **sí**
valdría la pena corregir: columnas o tablas que no existen
(`column ... does not exist`), violaciones de constraint, o timeouts.
