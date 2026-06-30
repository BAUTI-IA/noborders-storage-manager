// Vercel serverless function: privileged user-management operations that need
// the Supabase SERVICE ROLE key (never exposed to the browser). Every request
// is authenticated from the caller's JWT and authorized against profiles.role
// server-side — the client is never trusted to assert it is an admin.
//
// Required env (configure in Vercel project settings):
//   SUPABASE_SERVICE_ROLE_KEY  - service role key (bypasses RLS)
//   SUPABASE_URL (or VITE_SUPABASE_URL) - project URL
//   APP_URL - public app origin, used for invite/redirect links
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.APP_URL || "";

const admin = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!admin) {
    res.status(500).json({ error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." });
    return;
  }

  // 1) Authenticate the caller from the bearer token.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }
  const { data: { user }, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !user) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }

  // 2) Authorize: the caller must be an active admin (checked server-side).
  const { data: me } = await admin.from("profiles").select("role,active").eq("id", user.id).single();
  if (!me || me.role !== "admin" || !me.active) {
    res.status(403).json({ error: "Solo administradores." });
    return;
  }

  const { action, payload } = req.body || {};
  try {
    if (action === "list") {
      const { data, error } = await admin.from("profiles").select("*").order("created_at", { ascending: true });
      if (error) throw error;
      res.status(200).json({ users: data });
      return;
    }

    if (action === "invite") {
      const { email, role = "member", permissions = {}, full_name = "" } = payload || {};
      if (!email) { res.status(400).json({ error: "Falta el email." }); return; }
      if (role !== "admin" && role !== "member") { res.status(400).json({ error: "Rol inválido." }); return; }

      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: APP_URL ? `${APP_URL}/?invited=1` : undefined,
        data: { full_name },
      });
      if (error) throw error;

      // The on_auth_user_created trigger creates the base row; set role + perms.
      const { error: pErr } = await admin.from("profiles").upsert({
        id: data.user.id, email, full_name, role, permissions, active: true,
      });
      if (pErr) throw pErr;
      res.status(200).json({ ok: true, user: { id: data.user.id, email } });
      return;
    }

    if (action === "update") {
      const { id, role, permissions, active, full_name } = payload || {};
      if (!id) { res.status(400).json({ error: "Falta el id." }); return; }
      if (role !== undefined && role !== "admin" && role !== "member") {
        res.status(400).json({ error: "Rol inválido." }); return;
      }
      // Guard: an admin cannot strip their own admin role / deactivate themselves
      // (prevents locking everyone out by mistake).
      if (id === user.id && (role === "member" || active === false)) {
        res.status(400).json({ error: "No podés quitarte tu propio acceso de admin." });
        return;
      }
      const patch = {};
      if (role !== undefined) patch.role = role;
      if (permissions !== undefined) patch.permissions = permissions;
      if (active !== undefined) patch.active = active;
      if (full_name !== undefined) patch.full_name = full_name;
      const { error } = await admin.from("profiles").update(patch).eq("id", id);
      if (error) throw error;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "delete") {
      const { id } = payload || {};
      if (!id) { res.status(400).json({ error: "Falta el id." }); return; }
      if (id === user.id) { res.status(400).json({ error: "No podés eliminar tu propia cuenta." }); return; }
      // Only deactivated users can be deleted (matches the UI; defense in depth).
      const { data: target } = await admin.from("profiles").select("active").eq("id", id).single();
      if (target && target.active !== false) {
        res.status(400).json({ error: "Primero desactivá al usuario." });
        return;
      }
      // Remove the auth user; the profiles row is removed by the on-delete-cascade FK.
      const { error: dErr } = await admin.auth.admin.deleteUser(id);
      if (dErr) {
        // Fallback: if the auth user is already gone, still clear any orphan profile row.
        await admin.from("profiles").delete().eq("id", id);
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "Acción desconocida." });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Error." });
  }
}
