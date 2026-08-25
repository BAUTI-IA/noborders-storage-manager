#!/usr/bin/env node
// Unit tests for the real-time voice agent's server side: the session it hands
// the browser, and the gate every function call passes through. Pure — no DB,
// no network (lib/voice.mjs degrades to an empty schema/directory when Supabase
// isn't configured, which is exactly what this run exercises).
//
//   node scripts/test-voice.mjs
import {
  buildVoiceInstructions, buildVoiceSession, dropSessionParam, runVoiceTool, voiceLang, voiceSchema,
  voiceTools, vt, VOICE_TOOL_NAMES,
} from "../lib/voice.mjs";

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`✗ ${name}\n   esperado: ${JSON.stringify(want)}\n   obtenido: ${JSON.stringify(got)}`); }
  else console.log(`✓ ${name}`);
};

const admin = { role: "admin", email: "a@x.com", full_name: "Ana" };
const viewer = { role: "member", email: "v@x.com", permissions: { jobs: { view: true } } };

// ── Schema trimming ──────────────────────────────────────────────────────────
// Every extra token in the instructions is latency on the first spoken answer,
// so the schema is cut to a budget — but never silently: what didn't fit is
// still named so the agent knows the table exists.
const SCHEMA = [
  "zip_geo: zip text, lat numeric",
  "storage_jobs: id integer, job_number text, client_name text",
  "brokers: id integer, name text",
  "trips: id integer, trip_number text",
].join("\n");

eq("el esquema entero entra cuando hay presupuesto", voiceSchema(SCHEMA, 5000).split("\n").length, 4);
{
  // Budget for roughly two lines: the hot tables must survive, the cold one
  // must be the casualty.
  const out = voiceSchema(SCHEMA, 90);
  eq("recorta por presupuesto", out.includes("storage_jobs:"), true);
  eq("prioriza tablas calientes sobre frías", out.includes("zip_geo:"), false);
  eq("nombra lo que quedó afuera", out.includes("OTHER TABLES") && out.includes("zip_geo"), true);
}
eq("sin esquema no rompe", voiceSchema("").includes("crm_ask"), true);

// ── Tool surface ─────────────────────────────────────────────────────────────
eq("sin permiso de escritura no se ofrecen herramientas de escritura",
  voiceTools(false).map((t) => t.name), ["crm_lookup", "crm_ask"]);
eq("con permiso se ofrece el ciclo completo",
  voiceTools(true).map((t) => t.name), ["crm_lookup", "crm_ask", "crm_plan", "crm_confirm", "crm_cancel"]);
eq("el endpoint acepta exactamente esas herramientas",
  [...VOICE_TOOL_NAMES].sort(), voiceTools(true).map((t) => t.name).sort());

const badTools = [];
for (const t of voiceTools(true)) {
  if (t.type !== "function") badTools.push(`${t.name}: type`);
  if (!t.description || t.description.length < 40) badTools.push(`${t.name}: description`);
  if (t.parameters?.type !== "object" || !t.parameters.properties) badTools.push(`${t.name}: parameters`);
  // A realtime function tool is flat — an Anthropic-style input_schema here
  // would be silently ignored and the model would call with no arguments.
  if (t.input_schema) badTools.push(`${t.name}: input_schema`);
}
eq("todas las herramientas tienen forma de función realtime", badTools, []);

// ── Session config ───────────────────────────────────────────────────────────
{
  const ws = await buildVoiceSession({ actor: { profile: admin }, canWrite: true, transport: "websocket" });
  const rtc = await buildVoiceSession({ actor: { profile: admin }, canWrite: true, transport: "webrtc" });

  // Over WebRTC the codec is negotiated in the SDP; declaring PCM there would
  // fight the transport. Over a WebSocket we carry the samples ourselves.
  eq("websocket declara PCM 24k de entrada", ws.audio.input.format, { type: "audio/pcm", rate: 24000 });
  eq("websocket declara PCM 24k de salida", ws.audio.output.format, { type: "audio/pcm", rate: 24000 });
  eq("webrtc no declara formato de entrada", rtc.audio.input.format, undefined);
  eq("webrtc no declara formato de salida", rtc.audio.output.format, undefined);

  // Barge-in is the difference between a conversation and a monologue.
  eq("interrumpir al agente está habilitado", rtc.audio.input.turn_detection.interrupt_response, true);
  eq("el servidor crea la respuesta al terminar el turno", rtc.audio.input.turn_detection.create_response, true);
  eq("detección de turno semántica", rtc.audio.input.turn_detection.type, "semantic_vad");
  // The team switches between Spanish and English mid-sentence, so the language
  // is auto-detected. Pinning one is opt-in through VOICE_TRANSCRIBE_LANGUAGE.
  eq("no fuerza un idioma de transcripción",
    "language" in rtc.audio.input.transcription || "languages" in rtc.audio.input.transcription, false);
  eq("responde con audio", rtc.output_modalities, ["audio"]);

  const ro = await buildVoiceSession({ actor: { profile: viewer }, canWrite: false, transport: "webrtc" });
  eq("una sesión de solo lectura no lleva crm_plan",
    ro.tools.some((t) => t.name === "crm_plan"), false);
}

// ── Instructions ─────────────────────────────────────────────────────────────
{
  const write = await buildVoiceInstructions({ actor: { profile: admin }, canWrite: true });
  const read = await buildVoiceInstructions({ actor: { profile: viewer }, canWrite: false });

  eq("identifica a quien llama", write.includes("Ana"), true);
  eq("le dice que puede proponer cambios", write.includes("crm_plan"), true);
  eq("marca READ-ONLY a quien no escribe", read.includes("READ-ONLY"), true);
  eq("le prohíbe crm_plan a quien no escribe", read.includes("never call crm_plan"), true);
  // The one rule that must never soften: writes wait for a spoken yes.
  eq("exige confirmación hablada antes de escribir", write.includes("crm_confirm ONLY after"), true);
  eq("pide un relleno hablado antes de cada herramienta", write.toLowerCase().includes("filler"), true);
  eq("sin base de datos igual arma instrucciones", write.length > 1500, true);
}

// ── Bilingual ────────────────────────────────────────────────────────────────
// The team speaks both, and mixes them. The agent mirrors whoever is talking;
// the CRM's own setting only decides the greeting (nobody has spoken yet) and
// the language of the panel's errors.
eq("es-AR es español", voiceLang("es-AR"), "es");
eq("es es español", voiceLang("es"), "es");
eq("en es inglés", voiceLang("en"), "en");
// src/i18n.js arranca en inglés, así que un idioma sin definir cae ahí.
eq("sin idioma cae en inglés", voiceLang(undefined), "en");
eq("basura cae en inglés", voiceLang("klingon"), "en");

eq("los errores del panel salen en español", vt("es").noKey.includes("Falta"), true);
eq("y en inglés", vt("en").noKey.includes("missing"), true);
eq("el idioma cambia la copia", vt("es").readOnly === vt("en").readOnly, false);

{
  const es = await buildVoiceInstructions({ actor: { profile: admin }, canWrite: true, lang: "es" });
  const en = await buildVoiceInstructions({ actor: { profile: admin }, canWrite: true, lang: "en" });

  eq("saluda en español cuando el CRM está en español", es.includes("greeting in Argentine Spanish"), true);
  eq("saluda en inglés cuando el CRM está en inglés", en.includes("greeting in English"), true);
  // El saludo es lo único que fija el idioma: después sigue al que habla.
  for (const [name, text] of [["es", es], ["en", en]]) {
    eq(`${name}: sigue el idioma del que habla`, text.includes("switch the moment they switch"), true);
    eq(`${name}: nunca pregunta qué idioma`, text.includes("Never ask which language"), true);
    // El bug que motivó esto: derivaba al castellano después de una consulta,
    // porque las instrucciones, el directorio y los resultados están salpicados
    // de castellano y los tomaba como pista.
    eq(`${name}: solo el que habla define el idioma`, text.includes("ONLY the person's own words decide"), true);
    eq(`${name}: los datos no son una pista de idioma`, text.includes("that is stored data, not a hint"), true);
    // Convención del CRM (CLAUDE.md): en español los términos del negocio
    // quedan en inglés, porque así habla el equipo.
    eq(`${name}: mantiene el vocabulario del CRM en inglés`, text.includes("Keep the CRM's vocabulary in English"), true);
  }
}

{
  // Sin perfil no hay escritura posible, que es el camino que devuelve DENIED.
  // (Un viewer CON perfil sí llega a proponer: lo frena validatePlan por tabla.)
  const anon = { profile: null, userEmail: null };
  const call = (lang) => runVoiceTool({ name: "crm_plan", input: { request: "x" }, convoKey: "voice:test", actor: anon, lang });
  const [es, en] = [await call("es"), await call("en")];
  // El modelo siempre lee inglés — es una directiva de prompt, no copia de UI —
  // y lo dice en el idioma de quien habla.
  eq("la directiva al modelo va siempre en inglés", es.output, en.output);
  eq("pero el panel la muestra traducida", es.ui.text === en.ui.text, false);
  eq("y en español dice solo lectura", es.ui.text.includes("solo lectura"), true);
  eq("y en inglés read-only", en.ui.text.includes("read-only"), true);
}

{
  const text = await buildVoiceInstructions({ actor: { profile: admin }, canWrite: true, lang: "en" });
  // Cada ejemplo hablado va en los dos idiomas, o sesga hacia uno.
  const paired = [
    ["relleno antes de una herramienta", '"Let me check…" / "Dejame ver…"'],
    ["números", '"twelve hundred dollars" / "mil doscientos dólares"'],
    ["titular + detalle", '"There are seven deliveries. Want me to go through them?" / "Hay siete entregas. ¿Te las paso una por una?"'],
    ["fechas relativas", '"next Friday" / "el viernes"'],
  ];
  for (const [what, example] of paired) {
    eq(`el ejemplo de ${what} va en los dos idiomas`, text.includes(example), true);
  }
}

// ── Degrading on a knob the model doesn't take ───────────────────────────────
// Which parameters a realtime model accepts varies by model, and the API says
// so with a 400 naming the path. Tuning knobs get dropped and the mint retried;
// anything the agent can't work without does not.
{
  const session = () => ({
    type: "realtime",
    model: "gpt-realtime",
    instructions: "…",
    tools: [{ name: "crm_lookup" }],
    audio: { input: { transcription: { model: "m", languages: ["es", "en"] }, noise_reduction: { type: "near_field" } } },
  });

  const s1 = session();
  eq("quita el parámetro que el modelo rechazó",
    dropSessionParam(s1, "session.audio.input.transcription.languages"), "session.audio.input.transcription.languages");
  eq("y lo deja fuera del payload", "languages" in s1.audio.input.transcription, false);
  eq("sin tocar lo que estaba al lado", s1.audio.input.transcription.model, "m");

  eq("no borra las instrucciones", dropSessionParam(session(), "session.instructions"), null);
  eq("no borra las herramientas", dropSessionParam(session(), "session.tools"), null);
  eq("no borra el modelo", dropSessionParam(session(), "session.model"), null);
  eq("ignora un path que no existe", dropSessionParam(session(), "session.audio.output.voice"), null);
  eq("ignora un path que no es de session", dropSessionParam(session(), "expires_after.seconds"), null);
  eq("ignora un param vacío", dropSessionParam(session(), undefined), null);
}

// ── The gate ─────────────────────────────────────────────────────────────────
// The browser is only a relay: it can ask for any tool with any arguments, so
// the answer to "may I?" has to be decided here.
{
  const anon = { profile: null, userEmail: null };
  const ro = { profile: viewer, userEmail: viewer.email };

  const unknown = await runVoiceTool({ name: "drop_everything", input: {}, convoKey: "voice:test", actor: anon });
  eq("herramienta desconocida rechazada", unknown.output.startsWith("ERROR:"), true);

  const plan = await runVoiceTool({ name: "crm_plan", input: { request: "borrá todo" }, convoKey: "voice:test", actor: anon });
  eq("sin perfil no se puede proponer una escritura", plan.output.startsWith("DENIED:"), true);

  const confirm = await runVoiceTool({ name: "crm_confirm", input: {}, convoKey: "voice:test", actor: anon });
  eq("sin perfil no se puede confirmar", confirm.output.startsWith("DENIED:"), true);

  // Reading identity/permissions would be the way to plan an escalation.
  const priv = await runVoiceTool({ name: "crm_lookup", input: { query: "select * from profiles" }, convoKey: "voice:test", actor: ro });
  eq("profiles es privada también por voz", priv.output.startsWith("DENIED:"), true);

  const forbidden = await runVoiceTool({ name: "crm_lookup", input: { query: "select * from payments" }, convoKey: "voice:test", actor: ro });
  eq("un viewer de jobs no lee payments", forbidden.output.startsWith("DENIED:"), true);

  const empty = await runVoiceTool({ name: "crm_lookup", input: {}, convoKey: "voice:test", actor: ro });
  eq("consulta vacía rechazada", empty.output.startsWith("ERROR:"), true);

  eq("cada llamada informa su duración", typeof unknown.ms, "number");
}

console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodo OK");
process.exit(failed ? 1 : 0);
