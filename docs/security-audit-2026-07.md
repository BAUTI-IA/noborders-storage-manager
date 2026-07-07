# Informe de auditoría de seguridad — Julio 2026

Auditoría completa de la app (frontend React, endpoints serverless en `api/`,
scripts de setup de Supabase, workflows de GitHub y dependencias), con las
correcciones ya aplicadas en este mismo branch.

## Resumen

| # | Severidad | Hallazgo | Estado |
|---|-----------|----------|--------|
| 1 | 🔴 Crítica | `/api/analyze` sin autenticación: proxy abierto a la API de Anthropic (cualquiera podía quemar tu crédito de API) | ✅ Corregido |
| 2 | 🔴 Crítica | Buckets `bol-generated` y `bol-templates` **públicos**: los BOLs con nombres, direcciones, teléfonos y montos de clientes eran legibles por cualquiera con la URL | ✅ Corregido (código) + ⚠️ requiere correr un script |
| 3 | 🔴 Alta | Buckets `compliance-docs`, `payment-docs` y `closing-sheet-docs` públicos: fotos de cheques, money orders y documentos de compliance accesibles sin login | ✅ Corregido (código) + ⚠️ requiere correr un script |
| 4 | 🔴 Alta | XSS almacenado en las ventanas de impresión (Extras por driver/rep y Closing Sheets): un nombre de cliente como `<img onerror=...>` ejecutaba JavaScript con acceso a la sesión | ✅ Corregido |
| 5 | 🟠 Alta | Webhook de DocuSign aceptaba payloads **sin verificar la firma HMAC** si `DOCUSIGN_CONNECT_HMAC` no estaba configurada (permitía marcar BOLs como firmados o pisar PDFs firmados) | ✅ Corregido (ahora falla cerrado) + ⚠️ configurar la variable |
| 6 | 🟠 Alta | `/api/bol-analyze` y `/api/trip-suggestions` salteaban la autenticación si faltaba `SUPABASE_SERVICE_ROLE_KEY` (fallaban "abierto") | ✅ Corregido (fallan cerrado) |
| 7 | 🟠 Media | `supabase-js` y `jszip` cargados en runtime desde CDNs (esm.sh / jsdelivr): riesgo de supply chain — si el CDN se compromete, ejecuta código con tu sesión | ✅ Corregido (bundleados localmente) |
| 8 | 🟠 Media | Sin headers de seguridad HTTP (CSP, HSTS, X-Frame-Options, etc.) | ✅ Corregido (`vercel.json`) |
| 9 | 🟠 Media | `/api/geocode` sin autenticación: relay abierto de geocoding bajo tu identidad ante Nominatim | ✅ Corregido |
| 10 | 🟡 Media | Dependencias vulnerables: `d3-color` (ReDoS, high) y `esbuild`/`vite` (dev server, moderate) | ✅ Corregido (`npm audit`: 0 vulnerabilidades) |
| 11 | 🟡 Baja | `admin-users`: validación de entradas floja (email sin validar, `permissions`/`full_name` sin sanear) en escrituras hechas con service role | ✅ Corregido |
| 12 | 🟡 Baja | Sin rate limiting en los endpoints que gastan crédito de IA | ✅ Mitigado (limiter en memoria por usuario) |

Lo que ya estaba **bien** y se mantuvo: RLS por sección con `has_perm()` en todas
las tablas del CRM (sin acceso `anon`), autorización server-side real en
`admin-users` y `docusign-send` (rol verificado contra `profiles`, nunca contra
el payload), `bol-signed` privado con URLs firmadas, la publishable key en el
frontend (es pública por diseño), comparación HMAC en tiempo constante, y la
validación server-side de las sugerencias de la IA de trips.

---

## Detalle de las correcciones

### 1. Autenticación obligatoria en toda la API (`lib/auth.mjs`)
Nuevo helper compartido `requireUser()`: verifica el JWT de Supabase del caller
y **falla cerrado** — si al servidor le falta `SUPABASE_SERVICE_ROLE_KEY` o
`SUPABASE_URL`, responde 500 en vez de saltear el chequeo. Aplicado a
`/api/analyze`, `/api/bol-analyze`, `/api/trip-suggestions` y `/api/geocode`.
Incluye un rate limiter en memoria por usuario (mejor esfuerzo por instancia):
10 llamadas de IA cada 5 minutos, 120 geocodificaciones por minuto.

Además: tope de 20.000 caracteres al prompt de `/api/analyze` y de ~6 MB a la
imagen de `/api/bol-analyze` (control de costos aunque el caller esté logueado).

El frontend ahora manda `Authorization: Bearer <token>` en todas las llamadas a
`/api/*` (antes `analyze` y `geocode` iban sin token).

### 2–3. Documentos con PII: de URLs públicas a URLs firmadas
- `src/bol.jsx`: el botón "View" de BOLs generados ahora abre una URL firmada
  de 120 segundos (antes, link público permanente).
- `src/App.jsx`: nuevos `DocLink` / `DocImg` + `resolveDocUrl()` — cualquier
  URL de Supabase Storage guardada en la base (incluidas las públicas viejas)
  se convierte en una URL firmada de 5 minutos al momento de verla. Aplica a
  documentos de compliance, fotos de cheques/money orders, docs de closing
  sheets y al visor de fotos de pagos.
- `scripts/setup-bol.mjs`: los buckets BOL se crean privados de ahora en más.
- **Nuevo** `scripts/setup-storage-security.mjs`: pone `public = false` en los
  6 buckets, elimina toda política `anon` de `storage.objects` y crea políticas
  solo-`authenticated` para los buckets creados a mano.

### 4. XSS almacenado en impresiones
`printDriverExtras`, `printRepExtras` y `exportCsPdf` interpolaban datos de la
base (cliente, job #, descripción, driver, broker…) directo en HTML que se
escribía con `document.write` en una ventana del mismo origen de la app. Ahora
todo pasa por `esc()` (escape HTML) y se eliminó el `<script>` inline de esas
ventanas (la impresión se dispara desde la ventana madre, compatible con la CSP).

### 5. Webhook DocuSign
`hmacOk()` devolvía `true` si la secret no estaba configurada. Ahora sin
`DOCUSIGN_CONNECT_HMAC` el webhook responde 500 y no procesa nada.

### 7. Supply chain
- `@supabase/supabase-js` se importa del paquete npm (estaba viniendo de
  `esm.sh` en runtime).
- `jszip` agregado a `package.json` e importado localmente (estaba viniendo de
  `cdn.jsdelivr.net` en runtime).
- La CSP nueva, además, bloquea cualquier script externo a futuro.

### 8. Headers de seguridad (`vercel.json`)
- **CSP**: scripts solo del propio origen; conexiones solo a Supabase y al CDN
  del mapa (topojson); sin objetos/embeds; `frame-ancestors 'none'`.
- HSTS (2 años), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
  restrictiva.

### 10. Dependencias
- `d3-color` forzado a ≥3.1.0 vía `overrides` (ReDoS).
- Vite 5 → 7 y `@vitejs/plugin-react` 4 → 5 (vulnerabilidad del dev server de
  esbuild). `npm audit`: **0 vulnerabilidades**. Build verificado.

---

## ⚠️ Pasos manuales pendientes (importantes)

El código ya está listo, pero hay 3 cosas que solo se pueden hacer desde tu
lado:

1. **Correr el script de storage (el más importante):**
   ```bash
   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-storage-security.mjs
   ```
   Hasta que no corras esto, los PDFs y fotos siguen siendo públicos. Corrélo
   **después** de deployar este branch (la app ya sabe abrir todo con URLs
   firmadas, así que no se rompe nada).

2. **Configurar `DOCUSIGN_CONNECT_HMAC` en Vercel** (si usás la firma de BOLs):
   en DocuSign Connect activá "Include HMAC", copiá la secret y cargala como
   variable de entorno. Sin esto, el webhook (correctamente) rechaza todo.

3. **En el dashboard de Supabase (Authentication → Settings):**
   - Deshabilitá el **signup público** si está habilitado (la app usa solo
     invitaciones); un usuario auto-registrado no tendría permisos por RLS,
     pero mejor que ni exista.
   - Activá **leaked password protection** y considerá exigir MFA para admins.

## Recomendaciones adicionales (no bloqueantes)

- Los backups diarios se suben como **artifacts de GitHub**: cualquiera con
  acceso de lectura al repo puede descargar la base entera. Mantené el repo
  privado y con colaboradores mínimos, o encriptá el JSON antes de subirlo.
- El rate limiting actual es en memoria (por instancia serverless). Si algún
  día hace falta un límite duro, usar Vercel Firewall / Upstash.
- Los datos de jobs (nombres de clientes) entran al prompt de la IA de trips;
  la respuesta ya se valida y recalcula server-side, así que una "inyección de
  prompt" a lo sumo genera sugerencias absurdas que el dispatcher descarta.
- Si en el futuro servís la app desde otro dominio de Supabase (custom domain),
  actualizá `connect-src`/`img-src`/`frame-src` en `vercel.json`.
