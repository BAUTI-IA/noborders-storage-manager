#!/usr/bin/env node
// Layout regression test for the agent widget.
//
// The voice panel had a bug the build and the linter can't see: its root asked
// for the widget's FULL height on top of the header, and the transcript couldn't
// shrink (no min-height: 0), so as the conversation grew the panel outgrew its
// own box. The widget clips its overflow, so the bottom of the conversation and
// the mic button ended up cut off where nobody could scroll to them.
//
// Nothing about that shows up until a real browser lays it out, so this renders
// the real widget, fills the transcript the way a long conversation would, and
// measures what a person can actually reach.
//
//   node scripts/test-voice-layout.mjs
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5199;

// Playwright's own download may be absent (the container ships a prebuilt one).
function findChromium() {
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* not installed at all */ }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    const p = join(base, d, "chrome-linux", "chrome");
    if (d.startsWith("chromium-") && existsSync(p)) return p;
  }
  return null;
}

const executablePath = findChromium();
if (!executablePath) {
  console.log("SALTEADO: no hay Chromium disponible (npx playwright install chromium).");
  process.exit(0);
}

// The harness lives in a throwaway dir so the repo keeps no fixture to
// maintain. It has to sit inside the repo — a page under /tmp can't resolve
// react, and one under node_modules/ trips Vite's dependency handling — so it
// is a dot-dir at the root, gitignored and removed when the run ends.
const dir = mkdtempSync(join(ROOT, ".nb-layout-"));
writeFileSync(join(dir, "index.html"),
  `<!doctype html><html><body style="margin:0;height:100vh"><div id="root"></div>` +
  `<script type="module" src="./main.jsx"></script></body></html>`);
writeFileSync(join(dir, "main.jsx"),
  `import React from "react";\n` +
  `import { createRoot } from "react-dom/client";\n` +
  `import { AgentChatWidget } from ${JSON.stringify(join(ROOT, "src", "agentChat.jsx"))};\n` +
  `createRoot(document.getElementById("root")).render(<AgentChatWidget session={{ access_token: "fake" }} />);\n`);

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`✗ ${name}\n   esperado: ${JSON.stringify(want)}\n   obtenido: ${JSON.stringify(got)}`); }
  else console.log(`✓ ${name}`);
};

const server = await createServer({
  root: dir,
  configFile: false,
  plugins: [react()],
  logLevel: "error",
  server: { port: PORT, strictPort: true, fs: { allow: [ROOT, dir] } },
});
await server.listen();

const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 500, height: 760 } });
  // A build error in the harness shows up as a blank page and a click timeout;
  // surfacing the console makes that diagnosable instead of mysterious.
  page.on("console", (m) => { if (m.type() === "error") console.error("  [browser]", m.text()); });
  page.on("pageerror", (e) => console.error("  [browser]", e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.getByTitle("CRM Agent").click();
  await page.getByTitle("Talk to the agent").click();
  await page.waitForSelector('button[title="Start talking"]');

  const m = await page.evaluate(() => {
    const panel = [...document.querySelectorAll("div")]
      .find((d) => getComputedStyle(d).position === "fixed" && d.style.height === "540px");
    const scroller = [...panel.querySelectorAll("div")].find((d) => getComputedStyle(d).overflowY === "auto");
    // Clone the panel's own bubble so the test measures the real styles.
    const proto = scroller.firstElementChild;
    for (let i = 0; i < 40; i++) {
      const n = proto.cloneNode(true);
      n.textContent = `Mensaje de prueba número ${i} para estirar la conversación.`;
      scroller.appendChild(n);
    }
    const mic = panel.querySelector('button[title="Hang up"], button[title="Start talking"]');
    const pr = panel.getBoundingClientRect();
    const mr = mic.getBoundingClientRect();
    scroller.scrollTop = scroller.scrollHeight; // what the auto-scroll effect does
    const sr = scroller.getBoundingClientRect();
    const lr = scroller.lastElementChild.getBoundingClientRect();
    return {
      micInsidePanel: mr.top >= pr.top && mr.bottom <= pr.bottom + 1,
      micOverflowPx: Math.round(mr.bottom - pr.bottom),
      transcriptScrolls: scroller.scrollHeight > scroller.clientHeight,
      scrolledToBottom: Math.abs(scroller.scrollTop + scroller.clientHeight - scroller.scrollHeight) < 2,
      lastBubbleVisible: lr.top >= sr.top - 1 && lr.bottom <= sr.bottom + 1,
    };
  });

  // The widget clips its overflow, so anything past its bottom edge is gone.
  eq("el botón del micrófono queda dentro del panel", m.micInsidePanel, true);
  eq("no sobresale ni un pixel", m.micOverflowPx <= 0, true);
  // Without min-height:0 the transcript grows instead of scrolling.
  eq("la conversación scrollea en vez de estirar el panel", m.transcriptScrolls, true);
  eq("se puede llegar hasta el final", m.scrolledToBottom, true);
  eq("y el último mensaje se ve entero", m.lastBubbleVisible, true);
} finally {
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodo OK");
process.exit(failed ? 1 : 0);
