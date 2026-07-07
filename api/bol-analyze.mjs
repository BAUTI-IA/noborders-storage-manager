// Vercel serverless function: ask Claude to look at a BOL template PDF (first
// page) and propose where the fillable fields are + which job datum each maps to.
// Returns rough field boxes that pre-populate the visual editor; the user then
// drags them to fine-tune. Best-effort — the manual editor works without this.
import Anthropic from "@anthropic-ai/sdk";
import { requireUser, rateLimitOk } from "../lib/auth.mjs";

const client = new Anthropic(); // ANTHROPIC_API_KEY from env
const MAX_IMAGE_B64_CHARS = 8 * 1024 * 1024; // ~6 MB of JPEG; page-1 renders are far smaller

const SOURCE_KEYS = [
  "customer","client_phone","client_email","job_number",
  "pickup_address","pickup_cityzip","pickup_city","pickup_state","pickup_zip",
  "delivery_address","delivery_cityzip","delivery_city","delivery_state","delivery_zip",
  "pickup_date_from","fadd","delivery_date","volume","price_per_cf","fuel_surcharge_pct",
  "estimate","deposit","pickup_balance","delivery_balance","bol_balance","broker",
];

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en Vercel." }); return; }

  // Require a valid logged-in user (fails closed if Supabase env is missing).
  const user = await requireUser(req, res);
  if (!user) return;
  if (!rateLimitOk(res, `bol-analyze:${user.id}`, 10, 5 * 60 * 1000)) return;

  const { image_base64, pages } = req.body || {};
  if (!image_base64 || typeof image_base64 !== "string") { res.status(400).json({ error: "Falta la imagen." }); return; }
  if (image_base64.length > MAX_IMAGE_B64_CHARS) { res.status(400).json({ error: "La imagen es demasiado grande." }); return; }
  const page0 = (pages && pages[0]) || { w: 612, h: 792 };

  const prompt = `This image is the first page of a moving company's Interstate Bill of Lading form. ` +
    `Identify the BLANK fields that a mover fills in per shipment (customer/shipper name, addresses, city/state/zip, phone, email, order/job number, dates like pickup and 1st available delivery, cubic feet, rate per cu.ft, fuel surcharge, charge amounts, totals, deposit, balances). ` +
    `For each field return its location as a box in NORMALIZED coordinates from 0 to 1 measured from the TOP-LEFT of the page (nx,ny = top-left of the box; nw,nh = width/height). ` +
    `Also map each to one of these source keys when it clearly fits, else "": ${SOURCE_KEYS.join(", ")}. ` +
    `For money/number fields set "align":"right", otherwise "left". ` +
    `Respond with ONLY compact JSON: {"fields":[{"page":0,"nx":0.0,"ny":0.0,"nw":0.0,"nh":0.0,"source":"","align":"left"}]}`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image_base64 } },
        { type: "text", text: prompt },
      ] }],
    });
    const text = message.content.filter(b => b.type === "text").map(b => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { res.status(200).json({ fields: [] }); return; }
    const parsed = JSON.parse(m[0]);
    const fields = (parsed.fields || [])
      .filter(f => typeof f.nx === "number" && typeof f.ny === "number")
      .map(f => ({
        page: 0,
        x: Math.round(f.nx * page0.w),
        y: Math.round(f.ny * page0.h),
        w: Math.round((f.nw || 0.15) * page0.w),
        h: Math.max(14, Math.round((f.nh || 0.02) * page0.h)),
        source: SOURCE_KEYS.includes(f.source) ? f.source : "",
        align: f.align === "right" || f.align === "center" ? f.align : "left",
      }));
    res.status(200).json({ fields });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Error analizando el PDF." });
  }
}
