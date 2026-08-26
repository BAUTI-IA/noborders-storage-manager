#!/usr/bin/env node
// Unit tests for the agent hub's server-to-server door — the one the ElevenLabs
// agent comes through. Pure: the Supabase client is injected, so this runs with
// no project and no network.
//
//   node scripts/test-agent-auth.mjs
import { serverToServerAuth } from "../api/agent-hub.mjs";

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

console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodo OK");
process.exit(failed ? 1 : 0);
