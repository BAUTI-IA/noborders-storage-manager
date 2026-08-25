// Pure helpers for the voice panel (src/voiceAgent.jsx), kept out of the JSX so
// they can be unit tested — same split as the other *Data.js siblings.

// An open voice session keeps streaming the mic whether or not anyone is
// talking, and silence is billed like anything else. So a panel left open by
// mistake costs money until someone notices. This decides when to warn and when
// to hang up.
export const IDLE_HANGUP_MS = 2 * 60 * 1000; // nothing said for two minutes
export const IDLE_WARN_MS = 20 * 1000;       // start counting down this early

// idleMs — time since the last thing that counts as activity.
// busy    — a tool call or a reply is still in flight: the person is waiting on
//           us, not idle, so never hang up under them.
// -> { hangUp, warnSeconds } — warnSeconds is null outside the warning window.
export function idleState(idleMs, { busy = false, timeoutMs = IDLE_HANGUP_MS, warnMs = IDLE_WARN_MS } = {}) {
  const left = timeoutMs - idleMs;
  if (busy) return { hangUp: false, warnSeconds: null };
  if (left <= 0) return { hangUp: true, warnSeconds: 0 };
  return { hangUp: false, warnSeconds: left <= warnMs ? Math.ceil(left / 1000) : null };
}
