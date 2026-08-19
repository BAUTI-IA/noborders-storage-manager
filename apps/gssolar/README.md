# G&S Solar — Project & Revenue OS

Front-end prototype of the CRM for G&S Solar: a vertically integrated commercial
solar developer (rooftop, ground-mount, carport and community solar across NY,
NJ and MA).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # model unit tests
npm run build
```

## The governing rule

**A number is entered once, by the person who owns it, in the place where it is
used.** Every other view — dashboard, cost rollup, 25-year model — is a *view*
of that same number, never a copy.

Concretely: the seed file holds only **inputs**. Year-1 NOI, fair market value,
the tax credit and IRR are never stored; they are derived in `lib/model.ts` and
every screen reads them from there. The whole product shares one `Scenario`
object, so changing sun hours on a project detail moves the portfolio model and
the dashboard at the same time.

## Layout

| Path | What |
|---|---|
| `lib/types.ts` | Domain types |
| `lib/model.ts` | **Every economic figure.** Production → NOI → FMV → tax credit → IRR, plus the cost-to-build rollup |
| `lib/triggers.ts` | The trigger engine. All alerts come from here; none are hand-authored |
| `lib/seed.ts` | Deterministic mock portfolio: 35 projects, 60 leads, 25 POs, 40 expenses |
| `lib/model.test.ts` | 27 tests over the model |
| `components/ui.tsx` | Shared primitives |
| `screens/` | The five tabs |

### Notes on the model

- Size comes from three sequential confirmations (Helioscope → structural →
  Avoca). The latest confirmed one wins; until Avoca's lands, the project is
  flagged and runs on a provisional number.
- FMV = multiple × year-1 NOI, shown per watt and multiplied back out for the
  ITC basis.
- Unlevered IRR is computed at all three sun-hour cases. A deal that clears the
  benchmark at 1,200 but fails at 1,100 gets the `?` flag — that is a decision,
  not a calculation.
- Inputs the project manager has not supplied yet fall back to stated portfolio
  defaults and are marked `ASSUMED` in the UI. They are never treated as zero.

## Open questions — defaults taken, each flagged with a `TODO` in the code

1. Accounting input lives in the Accounting tab; Sales only feeds it.
2. The per-project Cost Tab and the portfolio Cost to Build screen are the same
   records under two views.
3. The master rate sheet lives inside Cost to Build.
4. The expense feed is a read-only mock; no write-back.
5. HubSpot is a one-way lead import.

## Not built yet

Persistence (state is React-only), authentication, and the real HubSpot and
QuickBooks integrations.
