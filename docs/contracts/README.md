# Broker–Carrier Agreement — Invictus Brokerage LLC

Bilingual (English / Spanish) carrier agreement, parallel two-column layout.
The English column governs in the event of a discrepancy (Section 17.9).

| File | Use |
|---|---|
| `Invictus-Broker-Carrier-Agreement-EN-ES.docx` | Editable master — fill in the blanks, then send |
| `Invictus-Broker-Carrier-Agreement-EN-ES.pdf` | Ready-to-sign copy |
| `generator/` | Scripts that produce both files from one source of truth |

## Deal terms encoded

- **Onboarding fee:** US$5,000, two installments of US$2,500 (on signing, and 30 days later),
  fully non-refundable (Section 5).
- **Priority Rights:** right of first refusal on incoming Jobs, 24 hours to accept or decline
  in writing; no response = decline. Non-exclusive, no volume guarantee (Section 6).
- **Broker Fee per Job by volume:** <500 CF → $100 · 500–1,000 CF → $150 · >1,000 CF → $200 (Section 7.1).
- **Overage commission:** 10% of any Additional Charges collected above the original balance (Section 7.3).
- **Claims:** carrier is the carrier of record and bears all cargo/customer claims under Carmack;
  broker assumes none and is indemnified (Sections 8 and 9).

## Fill in before sending

Every placeholder is in `[BRACKETS]` or on a blank line:

- `[STATE]` / `[ESTADO]` — state of formation for Invictus Brokerage LLC
- `[ADDRESS]`, `[EMAIL]`, `[PHONE]`, `[NAME]` — Exhibit B broker contacts
- Broker USDOT/MC authority number (Section 1)
- `[COUNTY], [STATE]` — governing law and venue (Section 16)
- Bracketed day counts and percentages are defaults — adjust if you want different ones

Interstate household-goods brokerage requires FMCSA broker authority and a $75,000 surety bond.
Have a transportation attorney in your state review this before you use it.

## Regenerating

```bash
npm install docx playwright        # not project deps; install where you run the generator
node generator/build.js Invictus-Broker-Carrier-Agreement-EN-ES.docx
node generator/html.js contract.html   # then print to PDF
```

Clause text lives in `generator/sections.js` (1–8) and `generator/sections2.js` (9–17); each
entry carries the English and Spanish text side by side, so edits stay in sync across both
the DOCX and the PDF.
