// Shared service clients. Kept dependency-free so the agent modules can import
// them without creating import cycles.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// AGENT_ANTHROPIC_API_KEY (optional) gives the agent its own key so its spend
// shows separately in the Anthropic console; falls back to the shared one.
export const client = new Anthropic({ apiKey: process.env.AGENT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Service role: bypasses RLS, so every permission check lives in lib/acl.mjs.
export const admin = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;
