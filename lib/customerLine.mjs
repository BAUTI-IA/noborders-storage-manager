// Customer Line — the server side of the ElevenLabs agent that answers
// customers with a job in progress ("where is my stuff", "how much do I owe",
// "can I move the delivery"). Reached through api/agent-hub.mjs
// (action=customer_line, rewritten from /api/customer-line). See
// docs/customer-line.md for the why.
//
// Least privilege by construction, not by configuration: there is no LLM, no
// free SQL and no CRM user behind this door. Three fixed operations, each one
// answering about at most ONE job — the one the caller proved is theirs — and
// returning a whitelisted set of fields (lib/customerLineData.mjs).
//
// Verification state lives HERE, keyed by the platform's conversation id
// (ElevenLabs fills system__conversation_id; the model never types it). The
// change/callback tools take no job number at all: they act on the job this
// conversation verified, so the model cannot be talked into reading or writing
// somebody else's.
//
// Every write below checks its { error } (CLAUDE.md): state writes throw, so a
// half-done turn never tells the caller it worked; the audit log only warns.
import { admin } from "./clients.mjs";
import {
  MAX_FAILED_PER_CALL, MAX_FAILED_PER_JOB, JOB_FAIL_WINDOW_MS, STAGE_TTL_MS,
  normJobNumber, jobSearchFragment, matchingJobs, factorsMatch, customerSnapshot,
  validateChange, changeReadback, validateCallback, callbackPhone, teamMessage,
} from "./customerLineData.mjs";

export const CUSTOMER_LINE_TOOLS = new Set(["verify_and_get_job", "request_change", "request_callback"]);

const JOB_COLS = [
  "id", "job_number", "customer", "status", "created_at", "deleted_at", "client_phone", "pickup_zip", "delivery_zip",
  "delivery_city", "delivery_state", "pickup_date", "pickup_date_from", "pickup_date_to", "fadd", "delivery_date",
  "date_in", "date_out", "pickup_balance", "delivery_balance", "bol_balance", "bol_collected", "trip_id",
  "storage_id", "warehouse", "billing_active", "client_monthly_rate", "first_month_free",
].join(", ");

const must = (res, what) => {
  if (res?.error) throw new Error(`${what}: ${res.error.message || res.error}`);
  return res?.data;
};

// ── Data access (injectable: scripts/test-customer-line.mjs swaps in memory) ──
export function supabaseStore(db = admin) {
  return {
    async jobRows(fragment) {
      return must(await db.from("storage_jobs").select(JOB_COLS)
        .ilike("job_number", `%${fragment}%`).is("deleted_at", null)
        .order("created_at", { ascending: false }).limit(500), "storage_jobs") || [];
    },
    async ledger(rowIds, tripIds) {
      const [pay, ext, bill, trips] = await Promise.all([
        db.from("payments").select("job_id, amount, discount, concept, received").in("job_id", rowIds).is("deleted_at", null),
        db.from("job_extras").select("job_id, amount, active").in("job_id", rowIds).is("deleted_at", null),
        db.from("storage_billing").select("job_id, amount, status, billing_period_end").in("job_id", rowIds).eq("status", "pending"),
        tripIds.length ? db.from("trips").select("id, status, truck_id").in("id", tripIds).is("deleted_at", null) : { data: [] },
      ]);
      const tripRows = must(trips, "trips") || [];
      const truckIds = [...new Set(tripRows.map((t) => t.truck_id).filter(Boolean))];
      const trucks = truckIds.length
        ? must(await db.from("trucks").select("id, last_location, last_location_at").in("id", truckIds), "trucks") || []
        : [];
      return {
        payments: must(pay, "payments") || [],
        extras: must(ext, "job_extras") || [],
        billing: must(bill, "storage_billing") || [],
        trips: tripRows,
        trucks,
      };
    },
    async getSession(cid) {
      return must(await db.from("customer_line_sessions").select("*").eq("conversation_id", cid).maybeSingle(), "customer_line_sessions");
    },
    async saveSession(cid, patch) {
      must(await db.from("customer_line_sessions")
        .upsert({ conversation_id: cid, ...patch, updated_at: new Date().toISOString() }, { onConflict: "conversation_id" }), "customer_line_sessions");
    },
    async recentJobFailures(jobRef, sinceIso) {
      const res = await db.from("customer_line_events").select("id", { count: "exact", head: true })
        .eq("job_ref", jobRef).eq("outcome", "verify_failed").gte("created_at", sinceIso);
      must(res, "customer_line_events");
      return res.count || 0;
    },
    async logEvent(e) {
      // Audit only: losing a line must not cost the caller their answer, but it
      // must not vanish silently either.
      const { error } = await db.from("customer_line_events").insert(e);
      if (error) console.error("customer_line_events:", error.message);
    },
    async insertRequest(r) {
      return must(await db.from("customer_requests").insert(r).select("*").single(), "customer_requests");
    },
    // Compare-and-swap on staged_at: exactly one confirmation wins the staged
    // copy, however many arrive at once. last_request_at marks the filing as in
    // flight until its id lands.
    async claimStaged(cid, stagedAt, claimedAt) {
      const rows = must(await db.from("customer_line_sessions")
        .update({ staged_at: null, last_request_id: null, last_request_at: claimedAt, updated_at: new Date().toISOString() })
        .eq("conversation_id", cid).eq("staged_at", stagedAt).select("conversation_id"), "customer_line_sessions");
      return (rows || []).length > 0;
    },
    async findRecentChange(cid, sinceIso) {
      return must(await db.from("customer_requests").select("*")
        .eq("conversation_id", cid).eq("kind", "change").gte("created_at", sinceIso).is("deleted_at", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(), "customer_requests");
    },
    async findOpenCallback(cid, topic) {
      return must(await db.from("customer_requests").select("*")
        .eq("conversation_id", cid).eq("kind", "callback").eq("topic", topic).is("deleted_at", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(), "customer_requests");
    },
  };
}

// Dispatch hears about every request on Telegram. Its own chat id, so testing
// the line never pings the team group by accident. Not configured or down →
// the request is still saved; the result says the team wasn't pinged.
export async function notifyTeam(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CUSTOMER_LINE_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(4000), // a slow Telegram must not stall a live call
    });
    if (!res.ok) { console.error("customer-line telegram:", res.status, await res.text()); return false; }
    return true;
  } catch (e) {
    console.error("customer-line telegram:", e?.message || e);
    return false;
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────
// Every result is JSON the MODEL reads. `instruction` tells it what to do next
// in plain words, so a failure turns into the right sentence instead of a retry
// loop. Business outcomes are ok:false with an `error` code, never an HTTP error.
const NOT_VERIFIED = {
  ok: false, error: "not_verified",
  instruction: "This caller hasn't verified a job on this call. Verify first with verify_and_get_job (job number + ZIP or last 4 of the phone).",
};

async function verifyAndGetJob(input, { cid, store, now }) {
  const session = await store.getSession(cid);
  if (session?.locked_at) {
    return {
      ok: false, verified: false, error: "locked",
      instruction: "Too many failed verification attempts on this call. Don't try again and don't give any job details. Offer a coordinator callback (request_callback) or a transfer.",
    };
  }

  const fragment = jobSearchFragment(input.job_number);
  if (!fragment) {
    return { ok: false, verified: false, error: "bad_job_number", instruction: "Ask for the job number again — it's on their estimate or bill of lading. Pass only its letters and digits." };
  }
  const factors = { zip: input.zip, phone_last4: input.phone_last4 };
  if (!String(factors.zip || "").trim() && !String(factors.phone_last4 || "").trim()) {
    return { ok: false, verified: false, error: "missing_factor", instruction: "Ask for the ZIP code of the delivery or pickup address, or the last 4 digits of the phone number on the job." };
  }

  // Throttle by what the CALLER typed, not by what exists: a lock that only
  // triggers for real job numbers would itself reveal which ones are real.
  const jobRef = normJobNumber(input.job_number);
  const since = new Date(now.getTime() - JOB_FAIL_WINDOW_MS).toISOString();
  if (await store.recentJobFailures(jobRef, since) >= MAX_FAILED_PER_JOB) {
    await store.logEvent({ conversation_id: cid, tool: "verify_and_get_job", outcome: "job_locked", job_ref: jobRef, detail: null });
    return {
      ok: false, verified: false, error: "locked",
      instruction: "Verification for that job number is temporarily locked for security. Don't give any job details. Offer a coordinator callback (request_callback).",
    };
  }

  const groups = matchingJobs(await store.jobRows(fragment), input.job_number);
  let hit = null, reason = groups.length ? "mismatch" : "no_such_job";
  for (const g of groups) {
    const m = factorsMatch(g.rows, factors);
    if (m.ok) { hit = { ...g, factor: m.factor }; break; }
    reason = m.reason;
  }

  if (!hit) {
    const failed = (session?.failed_attempts || 0) + 1;
    const locked = failed >= MAX_FAILED_PER_CALL;
    await store.saveSession(cid, { failed_attempts: failed, ...(locked ? { locked_at: now.toISOString() } : {}) });
    await store.logEvent({ conversation_id: cid, tool: "verify_and_get_job", outcome: "verify_failed", job_ref: jobRef, detail: { reason, attempt: failed } });
    return locked
      ? { ok: false, verified: false, error: "locked", instruction: "That didn't match, and that was the last attempt on this call. Don't give any job details. Offer a coordinator callback (request_callback) or a transfer." }
      : {
          ok: false, verified: false, error: "no_match", attempts_left: MAX_FAILED_PER_CALL - failed,
          // Same words whether the job doesn't exist or the ZIP was wrong.
          instruction: "Say you couldn't match those details. Never say or hint whether the job number exists. Ask them to double-check the job number (it's on the estimate or bill of lading) and the ZIP or phone digits.",
        };
  }

  const rowIds = hit.rows.map((r) => r.id);
  const tripIds = [...new Set(hit.rows.map((r) => r.trip_id).filter(Boolean))];
  const job = customerSnapshot({ rows: hit.rows, ...(await store.ledger(rowIds, tripIds)), now });
  await store.saveSession(cid, {
    job_key: hit.key, job_number: job.job_number, verified_at: now.toISOString(), verified_by: hit.factor,
    staged: null, staged_at: null, // a read-back belongs to the job it was read for
  });
  await store.logEvent({ conversation_id: cid, tool: "verify_and_get_job", outcome: "verified", job_ref: normJobNumber(job.job_number), detail: { factor: hit.factor } });
  return {
    ok: true, verified: true, today: now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }), job,
    instruction: "Identity verified. Answer ONLY from these fields. A null date means it isn't scheduled yet: say so and offer a callback — never estimate one. Amounts are USD.",
  };
}

async function requestChange(input, { cid, store, notify, now, ...deps }) {
  const session = await store.getSession(cid);
  if (!session?.verified_at || !session?.job_number) return NOT_VERIFIED;
  const confirmed = input.confirmed === true || String(input.confirmed).toLowerCase() === "true";

  // Step 1 — stage. Nothing is written but the read-back.
  if (!confirmed) {
    const v = validateChange(input);
    if (!v.ok) return { ok: false, error: "bad_input", instruction: v.error };
    await store.saveSession(cid, { staged: v.staged, staged_at: now.toISOString() });
    await store.logEvent({ conversation_id: cid, tool: "request_change", outcome: "staged", job_ref: normJobNumber(session.job_number), detail: { kind: v.staged.kind } });
    return {
      ok: true, staged: true, readback: changeReadback(session.job_number, v.staged),
      instruction: "Read the readback to the caller and ask if it's right. Only after a clear yes, call request_change again with confirmed=true. If they want something different, call it again with confirmed=false and the corrected details.",
    };
  }

  // Step 2 — confirm. Writes EXACTLY what was read back: the staged copy, not
  // whatever arguments came with the confirmation.
  //
  // Confirmations can overlap: when this call is slow, the platform gives up
  // (tool timeout) and the model retries while the first one is still running.
  // So the staged copy is claimed atomically first; only the call that wins it
  // files the request, and every other one answers with that same reference.
  const staged = session.staged;
  const fresh = staged && session.staged_at && now.getTime() - new Date(session.staged_at).getTime() <= STAGE_TTL_MS;
  if (!fresh || !(await store.claimStaged(cid, session.staged_at, now.toISOString()))) {
    const prior = await priorChange(store, cid, session, now, { lostRace: !!fresh, sleep: deps.sleep });
    if (prior) return prior;
    return { ok: false, error: "nothing_staged", instruction: "There is no read-back to confirm. Call request_change with confirmed=false first and read it to the caller." };
  }

  let row;
  try {
    row = await store.insertRequest({
      source: "customer_line", conversation_id: cid, kind: "change", topic: staged.kind,
      job_number: session.job_number, verified: true, details: staged.details, preferred_date: staged.preferred_date,
    });
  } catch (e) {
    // Give the claim back so the caller's yes can be retried without a new read-back.
    await store.saveSession(cid, { staged_at: session.staged_at, last_request_at: null }).catch(() => {});
    throw e;
  }
  await store.saveSession(cid, { staged: null, last_request_id: row.id, last_request_at: now.toISOString() });
  const notified = await notify(teamMessage(row));
  await store.logEvent({ conversation_id: cid, tool: "request_change", outcome: "submitted", job_ref: normJobNumber(session.job_number), detail: { request_id: row.id, notified } });
  return {
    ok: true, submitted: true, reference: `CR-${row.id}`, team_notified: notified,
    instruction: "Give the caller the reference. Make clear nothing on the job has changed yet: a coordinator reviews the request and calls back to confirm.",
  };
}

// The request a repeated "yes" refers to: the one this conversation filed
// within the read-back window. When another confirmation is still filing it
// (it won the claim, or claimed it before this call read the session), wait
// briefly for its row instead of filing a second request.
async function priorChange(store, cid, session, now, { lostRace, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const recent = (iso) => !!iso && now.getTime() - new Date(iso).getTime() <= STAGE_TTL_MS;
  const already = (id) => ({ ok: true, submitted: true, already_submitted: true, reference: `CR-${id}`, instruction: "That request was already submitted; give the caller its reference." });
  if (session.last_request_id && recent(session.last_request_at)) return already(session.last_request_id);
  const inFlight = lostRace || (!session.last_request_id && recent(session.last_request_at));
  if (!inFlight) return null;
  const since = new Date(now.getTime() - STAGE_TTL_MS).toISOString();
  for (let i = 0; i < 5; i++) {
    const row = await store.findRecentChange(cid, since);
    if (row) return already(row.id);
    if (i < 4) await sleep(750);
  }
  return {
    ok: false, error: "submitting",
    instruction: "The request is still being filed. Tell the caller you are finishing it, then call request_change with confirmed=true again to get its reference. Do not stage it again.",
  };
}

async function requestCallback(input, { cid, callerId, store, notify, now }) {
  const v = validateCallback(input);
  if (!v.ok) return { ok: false, error: "bad_input", instruction: v.error };
  const session = await store.getSession(cid);
  const verified = !!(session?.verified_at && session?.job_number);

  // A verified job already has a phone on file; anyone else must leave one.
  const phone = callbackPhone(input.callback_phone, callerId);
  if (!verified && !phone) {
    return { ok: false, error: "need_phone", instruction: "Ask for the best phone number to call them back (10 digits) and read it back before calling request_callback again." };
  }

  const prior = await store.findOpenCallback(cid, v.callback.topic);
  if (prior) return { ok: true, reference: `CB-${prior.id}`, already_submitted: true, instruction: "That callback is already logged; give the caller its reference." };

  const row = await store.insertRequest({
    source: "customer_line", conversation_id: cid, kind: "callback", topic: v.callback.topic, urgency: v.callback.urgency,
    job_number: verified ? session.job_number : null, verified,
    claimed_job_number: verified ? null : v.callback.claimed_job_number,
    caller_name: v.callback.caller_name, callback_phone: phone, best_time: v.callback.best_time, details: v.callback.reason,
  });
  const notified = await notify(teamMessage(row));
  await store.logEvent({ conversation_id: cid, tool: "request_callback", outcome: "callback", job_ref: verified ? normJobNumber(session.job_number) : null, detail: { request_id: row.id, topic: row.topic, verified, notified } });
  return {
    ok: true, reference: `CB-${row.id}`, team_notified: notified,
    instruction: "Give the caller the reference and say a coordinator will call back. Don't promise an outcome — no refund, credit or date commitments.",
  };
}

const HANDLERS = { verify_and_get_job: verifyAndGetJob, request_change: requestChange, request_callback: requestCallback };

/**
 * Run one tool call. `deps` is injectable for tests:
 *   { store = supabaseStore(), notify = notifyTeam, now = new Date() }
 */
export async function runCustomerLineTool({ tool, input = {}, conversationId, callerId = null, deps = {} }) {
  const store = deps.store || supabaseStore();
  const notify = deps.notify || notifyTeam;
  const now = deps.now || new Date();
  return HANDLERS[tool](input, { cid: conversationId, callerId, store, notify, now, sleep: deps.sleep });
}
