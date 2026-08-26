// Second floating agent: the conversational agent built in ElevenLabs, embedded
// with their own web component. It lives NEXT TO the in-house CRM agent
// (src/agentChat.jsx), it doesn't replace it — two bubbles, bottom right.
//
// Positioning: the <elevenlabs-convai> host is `position:fixed; inset:0` with
// `pointer-events:none` and `z-index:1000`, and it parks its bubble
// `--el-overlay-padding` (32px) in from the corner chosen by `placement`. So it
// would land exactly on top of the CRM agent's FAB (right/bottom 22, 56px tall).
// An inline `bottom` on the host shrinks that overlay from below and lifts the
// whole widget — bubble and expanded sheet alike — clear of the FAB. Inline
// styles outrank the shadow tree's `:host` rule, so this holds.
//
// The script is only pulled in for a signed-in user: no third-party JS on the
// login screen.
import { useEffect, useState } from "react";

const AGENT_ID = import.meta.env.VITE_ELEVENLABS_AGENT_ID || "agent_2601m0z1c6vtfhj85bdebqemwgwm";
const EMBED_SRC = "https://unpkg.com/@elevenlabs/convai-widget-embed";

// 22 (FAB offset) + 56 (FAB) + 28 (gap) − 32 (the widget's own overlay padding).
const LIFT = 74;

// The custom element renders nothing until its script has defined it, and the
// script must be loaded exactly once per page even if this mounts twice.
let loading = null;
function loadEmbed() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${EMBED_SRC}"]`);
    if (existing) {
      if (window.customElements?.get("elevenlabs-convai")) return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const el = document.createElement("script");
    el.src = EMBED_SRC;
    el.async = true;
    el.type = "text/javascript";
    el.addEventListener("load", () => resolve(), { once: true });
    el.addEventListener("error", reject, { once: true });
    document.head.appendChild(el);
  });
  loading.catch(() => { loading = null; }); // a failed load may be retried
  return loading;
}

export function ElevenLabsAgentWidget() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    // A blocked or offline CDN must not take the CRM down with it: the widget
    // simply never appears and the in-house agent keeps working.
    loadEmbed().then(() => { if (alive) setReady(true); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!AGENT_ID || !ready) return null;
  return <elevenlabs-convai agent-id={AGENT_ID} style={{ bottom: LIFT }} />;
}
