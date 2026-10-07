# Notificaciones (🔔) y su copia por email

Cuando alguien taggea a un compañero en una nota de un job (`@nombre` o los
botones **Alert**), el CRM:

1. guarda la nota en el job (`job_events`);
2. crea una fila en `notifications` por cada taggeado → le aparece en la 🔔 del
   menú, en vivo (Realtime);
3. le manda **una copia por email** con la nota y un botón **Open the job**,
   que abre el CRM directo en ese job (tab Activity) y marca la notificación
   como leída.

El email es opcional: sin configurarlo, la 🔔 funciona igual.

| Pieza | Dónde |
| --- | --- |
| Campanita, envío de la notificación | `src/notifications.jsx` |
| Lógica de `@menciones` (pura, con tests) | `src/notificationsData.js` |
| Armado y envío del email | `lib/notifyEmail.mjs` |
| Endpoint | `api/admin-users.mjs`, `action: "notify_email"` |
| Tabla | `scripts/setup-notifications.mjs` |

## Configurar el email (una sola vez)

1. **Base:** en el SQL Editor de Supabase corré

   ```sql
   alter table public.notifications add column if not exists emailed_at timestamptz;
   ```

   (o el SQL completo de `scripts/setup-notifications.mjs`, que ya la incluye).
2. **Resend:** creá una cuenta en [resend.com](https://resend.com), agregá el
   dominio de la empresa en *Domains* y cargá los registros DNS que te pide
   hasta que quede *Verified*. Después creá una API key en *API Keys*
   (permiso *Sending access* alcanza).
3. **Vercel** → Project → Settings → Environment Variables (Production):

   | Variable | Ejemplo |
   | --- | --- |
   | `RESEND_API_KEY` | `re_…` |
   | `NOTIFY_EMAIL_FROM` | `No Borders CRM <crm@tudominio.com>` (el dominio verificado en el paso 2) |
   | `APP_URL` | `https://tu-crm.vercel.app` (ya la usan las invitaciones; sin ella el email sale sin botón) |

   Y hacé **Redeploy** para que las tome.
4. **Verificar:** abrí `https://<tu-crm>/api/admin-users` en el navegador; la
   línea `notify_email` tiene que decir `ok (from …)`. Después taggeá a alguien
   en una nota y debería recibir el email en segundos.

## Cómo se protege

- El navegador sólo dice *qué nota* acaba de guardar (`event_id`). El servidor
  manda únicamente las notificaciones de esa nota creadas por **quien llama**,
  de los **últimos 15 minutos** y que **nunca se mandaron** (`emailed_at`):
  repetir la llamada no reenvía nada ni puede apuntar a otra persona.
- Cada fila se marca antes de mandar, así dos llamadas a la vez no duplican; si
  Resend falla, la fila se desmarca y el error queda en los logs de Vercel
  (`[notify_email]`).
- No se manda a perfiles inactivos ni sin email (la 🔔 igual la tienen).
- El email sale en inglés, como los otros mensajes automáticos del equipo.
