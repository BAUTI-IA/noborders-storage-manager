#!/usr/bin/env node
// Unit tests for the agent hub's server-to-server door — the one the ElevenLabs
// agent comes through. Pure: the Supabase client is injected, so this runs with
// no project and no network.
//
//   node scripts/test-agent-auth.mjs
import { runToolWithBudget, serverToServerAuth } from "../api/agent-hub.mjs";
import { checkSqlAccess, normalizeSql } from "../lib/agentWrite.mjs";
import { VOICE_TOOL_NAMES } from "../lib/voice.mjs";

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`✗ ${name}\n   esperado: ${JSON.stringify(want)}\n   obtenido: ${JSON.stringify(got)}`); }
  else console.log(`✓ ${name}`);
};

const SECRET = "s3cr3t-de-prueba";
const EMAIL = "voz@noborders.com";

// Minimal stand-in for the supabase-js builder chain used by the auth path.
const dbWith = (profile) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }),
});
const req = (secret) => ({ headers: secret === undefined ? {} : { "x-agent-secret": secret } });

const member = { role: "member", email: EMAIL, permissions: { jobs: { view: true } } };

const withEnv = async (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  try { return await fn(); } finally { process.env = saved; }
};

// ── Not a server-to-server call ──────────────────────────────────────────────
// No header means a browser: the caller must fall through to the JWT path, NOT
// be rejected and NOT be let in.
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: EMAIL }, async () => {
  eq("sin header no es una llamada server-to-server", await serverToServerAuth(req(undefined), dbWith(member)), null);
});

// ── Fails closed ─────────────────────────────────────────────────────────────
// A secret with a fallback baked into the repo is not a secret. Half-set config
// must refuse everyone rather than fall back to something guessable.
await withEnv({ VOICE_AGENT_SECRET: undefined, VOICE_AGENT_ACTOR_EMAIL: EMAIL }, async () => {
  const r = await serverToServerAuth(req(SECRET), dbWith(member));
  eq("sin VOICE_AGENT_SECRET no entra nadie", [r.ok, r.status], [false, 503]);
});
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: undefined }, async () => {
  const r = await serverToServerAuth(req(SECRET), dbWith(member));
  eq("sin VOICE_AGENT_ACTOR_EMAIL no entra nadie", [r.ok, r.status], [false, 503]);
});
// The string the pasted snippet suggested hardcoding must not open anything.
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: EMAIL }, async () => {
  const r = await serverToServerAuth(req("nb_voice_agent_secret_2026"), dbWith(member));
  eq("no hay secret por defecto que sirva", [r.ok, r.status], [false, 401]);
});

// ── Wrong secrets ────────────────────────────────────────────────────────────
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: EMAIL }, async () => {
  for (const [name, given] of [
    ["secret incorrecto", "otra-cosa"],
    ["secret más corto no explota", "s3c"],
    ["secret más largo no explota", SECRET + "xxxxxxxxxxxxxxxx"],
    ["secret vacío no es una llamada s2s", ""],
    ["prefijo del secret no alcanza", SECRET.slice(0, -1)],
  ]) {
    const r = await serverToServerAuth(req(given), dbWith(member));
    // An empty header is falsy, so it reads as "no header" — still not a way in.
    if (given === "") eq(name, r, null);
    else eq(name, [r.ok, r.status], [false, 401]);
  }
});

// ── The actor ────────────────────────────────────────────────────────────────
// The secret authenticates the caller; it does not hand out authority. What
// comes back must be a REAL CRM profile, because lib/acl.mjs skips the
// per-table read check entirely when there is no profile.
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: EMAIL }, async () => {
  const r = await serverToServerAuth(req(SECRET), dbWith(member));
  eq("secret correcto entra", r.ok, true);
  eq("entra COMO un usuario del CRM, con su perfil", r.actor.profile, member);
  eq("nunca entra sin perfil", !!r.actor.profile, true);
  eq("no hereda permisos de admin", r.actor.profile.role, "member");
  eq("el actor queda identificado para action_log", r.actor.userEmail, EMAIL);
});

// A secret that outlives the person it was issued for must stop working.
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: EMAIL }, async () => {
  const r = await serverToServerAuth(req(SECRET), dbWith(null));
  eq("usuario inexistente no entra", [r.ok, r.status], [false, 503]);
});
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: EMAIL }, async () => {
  const r = await serverToServerAuth(req(SECRET), dbWith({ ...member, active: false }));
  eq("usuario desactivado no entra", [r.ok, r.status], [false, 403]);
});

// Case and whitespace in the env var must not silently miss the profile.
await withEnv({ VOICE_AGENT_SECRET: SECRET, VOICE_AGENT_ACTOR_EMAIL: `  ${EMAIL.toUpperCase()}  ` }, async () => {
  const r = await serverToServerAuth(req(SECRET), dbWith(member));
  eq("el email se normaliza", r.ok, true);
});

// ── El contrato de la tool ───────────────────────────────────────────────────
// Lo que ElevenLabs manda de verdad (capturado de una conversación real): el
// nombre de la herramienta viaja en `name`, no en `tool`, y la query trae punto
// y coma al final.
const elevenLabsBody = {
  action: "voice_tool",
  name: "crm_lookup",
  input: { query: "SELECT COUNT(*) FROM storage_jobs WHERE deleted_at IS NULL;" },
  conversation_id: "conv_8701m0z87nsefceaj58acz82y6pd",
};

eq("se acepta el nombre de tool que manda ElevenLabs (`name`)",
  VOICE_TOOL_NAMES.has(String(elevenLabsBody.tool || elevenLabsBody.name || "")), true);
eq("y el que manda nuestro widget (`tool`)",
  VOICE_TOOL_NAMES.has(String({ tool: "crm_lookup" }.tool || "")), true);
eq("una tool inventada sigue sin entrar", VOICE_TOOL_NAMES.has("drop_everything"), false);

// ── normalizeSql ─────────────────────────────────────────────────────────────
// agent_query rechaza CUALQUIER `;` — es como garantiza una sola sentencia — y
// los modelos lo ponen por costumbre.
eq("saca el punto y coma final", normalizeSql("select 1;"), "select 1");
eq("saca el punto y coma con espacios detrás", normalizeSql("  select 1 ;  "), "select 1");
eq("no toca una query limpia", normalizeSql("select 1"), "select 1");
eq("vacío sigue vacío", normalizeSql(undefined), "");
// Sacar sólo el final no abre la puerta a dos sentencias: lo que queda todavía
// tiene un `;` y agent_query lo rechaza igual.
eq("no habilita multi-sentencia", normalizeSql("select 1; drop table trucks;").includes(";"), true);

// ── Tabla inexistente vs sin permiso ─────────────────────────────────────────
// El agente de ElevenLabs pidió `FROM jobs`. Esa tabla no existe: la de jobs es
// `storage_jobs`. Decirle "no tenés permiso" lo manda a buscar un admin en vez
// de a corregir el nombre.
{
  const denied = checkSqlAccess("select count(*) from jobs where deleted_at is null", member);
  eq("una tabla inexistente no se reporta como falta de permiso", /no existe/.test(denied), true);
  eq("y sugiere la tabla real", /storage_jobs/.test(denied), true);
}
{
  // Una tabla que SÍ existe pero que este perfil no puede ver sigue diciendo
  // exactamente eso.
  const denied = checkSqlAccess("select * from bank_transactions", member);
  eq("sin permiso sigue siendo sin permiso", /no tenés permiso/.test(denied), true);
}
eq("una tabla permitida pasa", checkSqlAccess("select * from storage_jobs", member), null);
eq("una tabla privada sigue bloqueada", /privada/.test(checkSqlAccess("select * from profiles", member)), true);

// ── El turno de voz no se cuelga ─────────────────────────────────────────────
const never = () => new Promise(() => {});           // no resuelve jamás
const quick = async () => ({ output: "ok", ms: 1 });

{
  const out = await runToolWithBudget("crm_lookup", never, "es", 30);
  eq("una lectura colgada devuelve algo hablable", out.timed_out, true);
  eq("y el modelo recibe una instrucción, no un stack", /Do NOT repeat it/.test(out.output), true);
  eq("con texto para la persona en su idioma", out.ui.text, "Esa consulta tardó demasiado.");
}
{
  const out = await runToolWithBudget("crm_ask", never, "en", 30);
  eq("crm_ask también tiene tope", out.timed_out, true);
  eq("en inglés cuando el turno es en inglés", out.ui.text, "That query took too long.");
}
{
  const out = await runToolWithBudget("crm_lookup", quick, "es", 5000);
  eq("una tool rápida pasa sin tocar", out.output, "ok");
  eq("y no se marca como vencida", !!out.timed_out, false);
}
// Lo importante: las tools con estado NO se cortan. Un crm_plan cortado por
// tiempo puede dejar un plan staged que nadie escuchó, y un "sí" posterior lo
// ejecutaría — justo lo que confirmar-antes-de-escribir existe para impedir.
for (const stateful of ["crm_plan", "crm_confirm", "crm_cancel"]) {
  const out = await Promise.race([
    runToolWithBudget(stateful, never, "es", 30),
    new Promise((r) => setTimeout(() => r("SIGUE CORRIENDO"), 120)),
  ]);
  eq(`${stateful} no se corta por tiempo`, out, "SIGUE CORRIENDO");
}

console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodo OK");
process.exit(failed ? 1 : 0);
