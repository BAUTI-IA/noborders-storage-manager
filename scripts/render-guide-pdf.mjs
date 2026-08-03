#!/usr/bin/env node
// Renderiza las dos guías HTML (docs/guia-crm.html y docs/crm-guide-en.html)
// a los PDFs de la raíz del repo usando Chromium headless (Playwright).
//
// Uso:
//   npx playwright install chromium   (una sola vez, baja el browser)
//   node scripts/render-guide-pdf.mjs
//
// Escribe primero a *.tmp y renombra los DOS juntos solo si ambos renders
// salieron bien: nunca queda un par de PDFs a medias. Cualquier error → exit 1.
import { renameSync, unlinkSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const TARGETS = [
  ["docs/guia-crm.html", "Guia-CRM-NoBorders.pdf"],
  ["docs/crm-guide-en.html", "CRM-Guide-NoBorders-EN.pdf"],
];

// GUIDE_CHROMIUM: ruta a un Chromium ya instalado (para entornos donde no se
// puede correr `npx playwright install`). Si no está, usa el browser de Playwright.
const browser = await chromium.launch(
  process.env.GUIDE_CHROMIUM ? { executablePath: process.env.GUIDE_CHROMIUM } : {}
);
try {
  const page = await browser.newPage();
  for (const [html, pdf] of TARGETS) {
    const url = pathToFileURL(resolve(html)).href;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.pdf({
      path: pdf + ".tmp",
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true, // respeta el @page { size:A4; margin:14mm ... } del HTML
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    console.log(`render OK: ${html} → ${pdf}.tmp`);
  }
  // Ambos renders OK: recién ahora pisamos los PDFs finales.
  for (const [, pdf] of TARGETS) renameSync(pdf + ".tmp", pdf);
  console.log("PDFs actualizados:", TARGETS.map(([, p]) => p).join(", "));
} catch (e) {
  for (const [, pdf] of TARGETS) if (existsSync(pdf + ".tmp")) unlinkSync(pdf + ".tmp");
  console.error("Error renderizando PDFs:", e?.message || e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
