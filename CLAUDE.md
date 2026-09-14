# No Borders Moving — Operations CRM

React (Vite) single-page CRM backed by Supabase. Main app: `src/App.jsx`; feature
modules: `src/bank.jsx`, `src/bol.jsx`, `src/expenses.jsx`, `src/messages.jsx`,
`src/suggestions.jsx`, `src/analytics.jsx`. Serverless endpoints live in `api/`.

## Language / i18n — REQUIRED for every new feature

The UI is bilingual (English/Spanish, user-selectable in Settings). The system
lives in `src/i18n.js`:

- **All UI source text is written in ENGLISH.** Never hardcode Spanish in JSX.
- When the user picks Spanish, a DOM pass swaps every known string using the
  `I18N_ES` dictionary (text nodes + `placeholder`/`title` attributes).
- **Any new user-visible string (label, button, header, placeholder, empty
  state, toast, tooltip) MUST get an entry in `I18N_ES`** in `src/i18n.js`.
  Translations use Argentine Spanish (voseo: "Elegí", "Agregá") and keep
  business terms in English (job, driver, broker, trip, storage, closing sheet,
  settlement, pads, BOL, CF, warehouse, live load).
- Strings the DOM pass can't reach — `window.alert` / `window.confirm` /
  `prompt`, interpolated template strings, text rendered inside SVG (charts,
  maps) — must use `tr(en, es)` (or `t(en)` for dictionary keys) imported from
  `src/i18n.js`.
- **Before committing UI work, run `npm run i18n:check`.** It scans `src/*.jsx`
  and fails if any user-visible string is missing from the dictionary or is
  hardcoded in Spanish. Fix everything it reports for the files you touched.

## Conventions

- Soft deletes: rows get `deleted_at`; filter with `notDel`. Undo/redo via
  `src/undo.js` and the Trash / History section. Restoring from the Trash
  goes through `restoreWithChildren` (a job brings back its extras and
  payments); add new parent→child edges to `CASCADE_CHILDREN` in `src/undo.js`.
- **Every Supabase write checks its result.** supabase-js resolves a failed
  mutation to `{ error }` instead of throwing, so a bare `await` swallows it.
  Wrap fire-and-forget writes with `dbFailed` from `src/db.js`:
  `if (dbFailed(await supabase.from("t").update(p).eq("id", id), "t")) return;`
  (reset any saving/busy flag before returning; `{ quiet: true }` for
  background loops). Never close a modal or reload over an unchecked write.
- Feature modules are self-contained (receive `supabase` + `session`), with
  pure/testable math split into sibling `*Data.js` files.
- One-time DB migrations live as SQL strings shown in setup banners and as
  scripts under `scripts/setup-*.mjs`.

## Commands

- `npm run dev` / `npm run build` — Vite dev server / production build.
- `npm run i18n:check` — i18n coverage audit (must pass for UI changes).
