// Shared auth helpers for the serverless API endpoints.
//
// Every endpoint that spends money (Anthropic) or touches data must call
// requireUser() and FAIL CLOSED: if the server is missing its Supabase env
// vars the request is rejected with 500 instead of silently skipping auth.
//
// Required env (Vercel): SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL (or VITE_SUPABASE_URL)
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const admin = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Verify the caller's Supabase JWT. Sends the error response itself and
// returns null on failure; returns the user object on success.
export async function requireUser(req, res) {
  if (!admin) {
    res.status(500).json({ error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." });
    return null;
  }
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "No autorizado." });
    return null;
  }
  const { data: { user } = {}, error } = await admin.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: "No autorizado." });
    return null;
  }
  return user;
}

// Best-effort in-memory rate limiter (per serverless instance). Not a hard
// guarantee across instances, but stops naive abuse loops cheaply. Sends the
// 429 itself and returns false when over the limit.
const buckets = new Map();
export function rateLimitOk(res, key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 5000) buckets.clear(); // avoid unbounded growth
    return true;
  }
  b.count += 1;
  if (b.count > max) {
    res.status(429).json({ error: "Demasiadas solicitudes. Esperá un momento e intentá de nuevo." });
    return false;
  }
  return true;
}
