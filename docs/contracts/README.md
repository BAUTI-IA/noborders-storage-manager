# Broker–Carrier Agreement — Invictus Brokerage LLC

Bilingual (English / Spanish) carrier agreement, parallel two-column layout.
The English column governs in the event of a discrepancy (Section 17.9).

Two versions, same deal terms — pick one and send it:

| File | Use |
|---|---|
| `Invictus-Broker-Carrier-Agreement-SHORT-EN-ES.docx` / `.pdf` | **Short form, 10 sections, 8 pages.** The everyday one — easier to get signed |
| `Invictus-Broker-Carrier-Agreement-EN-ES.docx` / `.pdf` | Full form, 17 sections, 14 pages. More detail per clause, for a bigger or riskier carrier |
| `generator/` | Scripts that produce every file from one source of truth |

The DOCX is the editable master; the PDF is the ready-to-sign copy. The short form keeps all the
commercial terms and every protection — it is the same deal written tighter, not a weaker contract.
The clauses it drops in full are the standalone compliance, force majeure, and boilerplate sections,
folded into Section 10.

## Deal terms encoded

Section numbers below are given as **short form / full form**.

- **Onboarding fee:** US$5,000, two installments of US$2,500 (on signing, and 30 days later),
  fully non-refundable (**4 / 5**).
- **Priority Rights:** right of first refusal on incoming Jobs, 24 hours to accept or decline
  in writing; no response = decline. Non-exclusive, no volume guarantee (**5 / 6**).
- **Broker Fee per Job by volume:** <500 CF → $100 · 500–1,000 CF → $150 · >1,000 CF → $200 (**6.1 / 7.1**).
- **Overage commission:** 10% of any Additional Charges collected above the original balance (**6.3 / 7.3**).
- **Claims:** carrier is the carrier of record and bears all cargo/customer claims under Carmack;
  broker assumes none and is indemnified (**7 / 8 and 9**).

## Fill in before sending

Every placeholder is in `[BRACKETS]` or on a blank line:

- `[STATE]` / `[ESTADO]` — state of formation for Invictus Brokerage LLC
  (Invictus's USDOT 4490702 and MC 1775070 are already filled in)
- `[ADDRESS]`, `[EMAIL]`, `[PHONE]`, `[NAME]` — Exhibit B broker contacts
- `[COUNTY], [STATE]` — governing law and venue (**10.1 / 16**)
- Bracketed day counts and percentages are defaults — adjust if you want different ones

Interstate household-goods brokerage requires FMCSA broker authority and a $75,000 surety bond.
Have a transportation attorney in your state review this before you use it.

## Regenerating

```bash
npm install docx playwright        # not project deps; install where you run the generator

# short form
node generator/build.js Invictus-Broker-Carrier-Agreement-SHORT-EN-ES.docx short
node generator/html.js contract-short.html short     # then print to PDF

# full form
node generator/build.js Invictus-Broker-Carrier-Agreement-EN-ES.docx full
node generator/html.js contract.html full
```

Clause text lives in `generator/sections-short.js` (short form, 1–10) and in
`generator/sections.js` + `generator/sections2.js` (full form, 1–17). Each entry carries the
English and Spanish text side by side, so edits stay in sync across both languages and both
output formats. Change a number in one place and rebuild — never edit the DOCX or PDF directly,
or the two language columns will drift apart.
