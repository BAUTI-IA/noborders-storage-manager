// Real-time voice agent for the CRM — browser side.
//
// The mic goes straight to a speech-to-speech model over a low-latency socket,
// so the loop is "you talk → it talks back", not "record → upload → wait". The
// model has no CRM access of its own: every question and every change comes
// back to us as a function call that we relay to /api/agent-hub, where the
// caller's own CRM permissions decide what happens (lib/voice.mjs).
//
// Two transports, same event protocol:
//   webrtc     — default. Audio rides an Opus RTP stream the browser manages
//                itself: jitter buffer, packet loss concealment and — the part
//                that matters on a speakerphone — echo cancellation against
//                what the agent is saying. Events travel on a data channel.
//   websocket  — a plain WebSocket carrying base64 PCM16 both ways, captured
//                and played back here by hand. Lower level and easier to run
//                through a proxy, but no echo cancellation: use headphones.
//
// LATENCY BUDGET (why the code looks the way it does):
//   · the session token is minted the moment the panel opens, not when the user
//     first speaks, and minting warms the agent's schema/directory caches;
//   · the CRM directory ships inside the session instructions, so resolving
//     "el broker Full Value" to an id costs zero round trips;
//   · turn ends are detected semantically, with barge-in enabled, so the agent
//     stops talking the instant someone talks over it;
//   · the model is told to say a short filler before a tool call, which hides
//     the round trip behind speech;
//   · every leg is measured and shown in the panel — reply, tool, connect.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getI18nLang, tr } from "./i18n.js";

const SAMPLE_RATE = 24000;          // the only PCM rate the realtime API accepts
const JITTER_S = 0.06;              // playback lead so a late chunk doesn't click
const METRIC_WINDOW = 20;           // turns kept for the median

// ── Small helpers ────────────────────────────────────────────────────────────
const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Chunked so a long buffer doesn't blow the argument limit of fromCharCode.
const bytesToB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const floatToPcm16 = (f32) => {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ── Audio plumbing (WebSocket transport only) ────────────────────────────────
// AudioWorklet lives in its own realm, so it's loaded from a Blob URL instead
// of a build-time asset — one less thing for Vite to special-case.
const CAPTURE_WORKLET = `
class NbCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) { const copy = new Float32Array(ch); this.port.postMessage(copy, [copy.buffer]); }
    return true;
  }
}
registerProcessor("nb-capture", NbCapture);
`;

async function startCapture(ctx, stream, onChunk) {
  const source = ctx.createMediaStreamSource(stream);
  if (ctx.audioWorklet) {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, "nb-capture");
      node.port.onmessage = (e) => onChunk(e.data);
      source.connect(node);
      // A worklet with no output still needs a sink to be pulled by the graph.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      return () => { try { node.port.onmessage = null; node.disconnect(); source.disconnect(); mute.disconnect(); } catch { /* closing */ } };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // Deprecated but still the only fallback where AudioWorklet is unavailable.
  const node = ctx.createScriptProcessor(2048, 1, 1);
  node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(ctx.destination);
  return () => { try { node.onaudioprocess = null; node.disconnect(); source.disconnect(); } catch { /* closing */ } };
}

function makePlayer(ctx) {
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const sources = new Set();
  let playAt = 0;
  return {
    push(int16) {
      const buf = ctx.createBuffer(1, int16.length, SAMPLE_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      playAt = Math.max(playAt, ctx.currentTime + JITTER_S);
      src.start(playAt);
      playAt += buf.duration;
      sources.add(src);
      src.onended = () => sources.delete(src);
    },
    // Barge-in: drop everything still queued so the agent goes quiet at once.
    stop() {
      for (const s of sources) { try { s.stop(); } catch { /* already ended */ } }
      sources.clear();
      playAt = 0;
    },
    setMuted(m) { gain.gain.value = m ? 0 : 1; },
    close() { this.stop(); try { gain.disconnect(); } catch { /* closing */ } },
  };
}

// ── Transports ───────────────────────────────────────────────────────────────
// Both resolve to the same shape: { send, close, kind, stream }.
async function openWebRTC({ token, onEvent, onError }) {
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  pc.addTrack(stream.getAudioTracks()[0], stream);

  const dc = pc.createDataChannel("oai-events");
  dc.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* not our event */ } };
  dc.onerror = () => onError?.(new Error("data channel error"));

  const ready = new Promise((resolve, reject) => {
    dc.onopen = resolve;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") reject(new Error("webrtc " + pc.connectionState));
    };
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const res = await fetch(token.sdp_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.client_secret}`, "Content-Type": "application/sdp" },
    body: offer.sdp,
  });
  if (!res.ok) throw new Error(`SDP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  await ready;
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      onError?.(new Error(`webrtc ${pc.connectionState}`));
    }
  };

  return {
    kind: "webrtc",
    stream,
    send: (ev) => { if (dc.readyState === "open") dc.send(JSON.stringify(ev)); },
    setMuted: (m) => { audio.muted = m; },
    // WebRTC decodes and plays the stream itself, so there is nothing local to
    // flush on barge-in; the server stops sending.
    stopPlayback: () => {},
    close: () => {
      try { dc.close(); } catch { /* closing */ }
      try { pc.close(); } catch { /* closing */ }
      for (const t of stream.getTracks()) t.stop();
      audio.srcObject = null;
    },
  };
}

async function openWebSocket({ token, onEvent, onError }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  if (ctx.state === "suspended") await ctx.resume();
  const player = makePlayer(ctx);

  // The ephemeral key travels as a subprotocol because browsers can't set
  // headers on a WebSocket handshake. It is an `ek_…`, never our API key.
  const ws = new WebSocket(token.ws_url, ["realtime", `openai-insecure-api-key.${token.client_secret}`]);
  ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* not our event */ } };
  ws.onerror = () => onError?.(new Error("websocket error"));

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onclose = (e) => reject(new Error(`websocket closed (${e.code})`));
  });
  ws.onclose = (e) => { if (e.code !== 1000) onError?.(new Error(`websocket closed (${e.code})`)); };

  const stopCapture = await startCapture(ctx, stream, (f32) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const pcm = floatToPcm16(f32);
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToB64(new Uint8Array(pcm.buffer)) }));
  });

  return {
    kind: "websocket",
    stream,
    player,
    send: (ev) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev)); },
    setMuted: (m) => player.setMuted(m),
    stopPlayback: () => player.stop(),
    close: () => {
      try { stopCapture(); } catch { /* closing */ }
      player.close();
      try { ws.close(); } catch { /* closing */ }
      for (const t of stream.getTracks()) t.stop();
      ctx.close().catch(() => {});
    },
  };
}

// ── The hook ─────────────────────────────────────────────────────────────────
// status: "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error"
export function useVoiceAgent({ session, transport = "webrtc" }) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [lines, setLines] = useState([]);      // { id, role, text, partial }
  const [activity, setActivity] = useState([]); // { id, kind, text, rows, ms, pending }
  const [pending, setPending] = useState(null); // staged plan awaiting confirmation
  const [muted, setMuted] = useState(false);
  const [metrics, setMetrics] = useState({ connectMs: null, replyMs: null, replyMedian: null, toolMs: null });

  const conn = useRef(null);
  const turn = useRef({ spokeAt: 0, awaitingAudio: false, replies: [], openCalls: 0, responseActive: false, wantResponse: false });
  const alive = useRef(true);
  const injected = useRef(new Set()); // texts we pushed ourselves, hidden from the transcript

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; conn.current?.close(); conn.current = null; };
  }, []);

  // Bubbles are ordered by where the item sits in the CONVERSATION, never by
  // when its text showed up. Input transcription runs asynchronously — the
  // agent starts answering (and its transcript streams) while what you said is
  // still being transcribed — so arrival order puts the answer above the
  // question. The item.added/created events fire in true conversation order and
  // carry previous_item_id, so each line gets its slot reserved first and the
  // transcript fills it in later.
  const upsertLine = useCallback((id, role, { text = "", append = false, after = null } = {}) => {
    if (!id) return;
    setLines((prev) => {
      const i = prev.findIndex((l) => l.id === id);
      if (i !== -1) {
        const copy = [...prev];
        copy[i] = { ...copy[i], text: append ? copy[i].text + text : text, partial: append };
        return copy;
      }
      const line = { id, role, text, partial: append };
      const at = after ? prev.findIndex((l) => l.id === after) : -1;
      return at === -1 ? [...prev, line] : [...prev.slice(0, at + 1), line, ...prev.slice(at + 1)];
    });
  }, []);

  // getI18nLang() is read per call, not captured: someone can switch the CRM to
  // Spanish mid-session and the next thing the panel says comes back translated.
  const post = useCallback(async (body) => {
    const res = await fetch("/api/agent-hub", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
      body: JSON.stringify({ ...body, lang: getI18nLang() }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Error ${res.status}`);
    return j;
  }, [session]);

  // Asking for a response while one is still active is an error, and so is
  // asking before every tool of the turn has answered. Queue in both cases and
  // let response.done fire it.
  const requestResponse = useCallback(() => {
    const t = turn.current;
    if (t.responseActive || t.openCalls) t.wantResponse = true;
    else conn.current?.send({ type: "response.create" });
  }, []);

  // A function call from the model: relay it, hand the result back, and only
  // ask for a new response once every call of this turn has been answered.
  const relayTool = useCallback(async (call) => {
    const started = now();
    setActivity((a) => [...a.slice(-6), { id: call.call_id, kind: "running", text: call.name }]);
    let output;
    try {
      const j = await post({ action: "voice_tool", tool: call.name, input: call.args });
      output = j.output ?? "";
      const ui = j.ui || {};
      setActivity((a) => a.map((x) => (x.id === call.call_id
        ? { ...x, kind: ui.kind || "result", text: ui.text || call.name, rows: ui.rows, ms: j.ms }
        : x)));
      if (ui.kind === "plan") setPending(ui.pending ? { text: ui.text } : null);
      if (call.name === "crm_confirm" || call.name === "crm_cancel") setPending(null);
    } catch (e) {
      output = `ERROR: ${e.message}`;
      setActivity((a) => a.map((x) => (x.id === call.call_id ? { ...x, kind: "error", text: e.message } : x)));
    }
    setMetrics((m) => ({ ...m, toolMs: Math.round(now() - started) }));
    conn.current?.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output },
    });
    turn.current.openCalls = Math.max(0, turn.current.openCalls - 1);
    requestResponse();
  }, [post, requestResponse]);

  const onServerEvent = useCallback((ev) => {
    const t = turn.current;
    switch (ev.type) {
      case "session.created":
        setStatus("listening");
        break;

      case "response.created":
        t.responseActive = true;
        break;

      // The user started talking: cut our own audio short (barge-in) and start
      // the clock for this turn.
      case "input_audio_buffer.speech_started":
        conn.current?.stopPlayback();
        setStatus("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        t.spokeAt = now();
        t.awaitingAudio = true;
        setStatus("thinking");
        break;

      // Reserves the slot, in order, before any text exists for it.
      case "conversation.item.added":
      case "conversation.item.created": {
        const it = ev.item;
        if (it?.type !== "message" || !it.id) break;
        const role = it.role === "assistant" ? "agent" : it.role === "user" ? "user" : null;
        if (!role) break;
        const text = (it.content || []).map((c) => c.transcript || c.text || "").join("");
        // The confirm/cancel buttons inject a user message to keep the agent in
        // the loop. It's plumbing, not something anyone said — don't show it.
        if (injected.current.has(text)) { injected.current.delete(text); break; }
        upsertLine(it.id, role, { text, after: ev.previous_item_id || null });
        break;
      }

      case "conversation.item.input_audio_transcription.delta":
        upsertLine(ev.item_id, "user", { text: ev.delta || "", append: true });
        break;
      case "conversation.item.input_audio_transcription.completed":
        upsertLine(ev.item_id, "user", { text: ev.transcript || "" });
        break;

      case "response.output_audio_transcript.delta":
        upsertLine(ev.item_id, "agent", { text: ev.delta || "", append: true });
        break;
      case "response.output_audio_transcript.done":
        upsertLine(ev.item_id, "agent", { text: ev.transcript || "" });
        break;

      // First audio of the turn — this is the number a caller actually feels.
      // WebRTC reports it as a buffer start; WebSocket as the first PCM chunk.
      case "output_audio_buffer.started":
      case "response.output_audio.delta": {
        if (ev.type === "response.output_audio.delta" && ev.delta) {
          const bytes = b64ToBytes(ev.delta);
          conn.current?.player?.push(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1));
        }
        if (t.awaitingAudio && t.spokeAt) {
          const ms = Math.round(now() - t.spokeAt);
          t.awaitingAudio = false;
          t.replies = [...t.replies, ms].slice(-METRIC_WINDOW);
          setMetrics((m) => ({ ...m, replyMs: ms, replyMedian: median(t.replies) }));
        }
        setStatus("speaking");
        break;
      }

      case "response.function_call_arguments.done": {
        let args = {};
        try { args = JSON.parse(ev.arguments || "{}"); } catch { /* the model sent junk; the tool will complain */ }
        t.openCalls += 1;
        setStatus("thinking");
        relayTool({ call_id: ev.call_id, name: ev.name, args });
        break;
      }

      case "response.done":
        t.responseActive = false;
        if (t.wantResponse && !t.openCalls) {
          t.wantResponse = false;
          conn.current?.send({ type: "response.create" });
        } else if (!t.openCalls) {
          setStatus("listening");
        }
        break;

      case "error":
        setError(ev.error?.message || tr("Voice session error", "Error en la sesión de voz"));
        break;

      default:
        break;
    }
  }, [upsertLine, relayTool]);

  const disconnect = useCallback(() => {
    conn.current?.close();
    conn.current = null;
    turn.current = { spokeAt: 0, awaitingAudio: false, replies: [], openCalls: 0, responseActive: false, wantResponse: false };
    setStatus("idle");
    setPending(null);
  }, []);

  const connect = useCallback(async () => {
    if (conn.current) return;
    setError("");
    setStatus("connecting");
    const started = now();
    try {
      const token = await post({ action: "voice_token", transport });
      const open = transport === "websocket" ? openWebSocket : openWebRTC;
      const c = await open({ token, onEvent: onServerEvent, onError: (e) => setError(e.message) });
      if (!alive.current) { c.close(); return; }
      conn.current = c;
      c.setMuted(muted);
      setMetrics((m) => ({ ...m, connectMs: Math.round(now() - started) }));
      setStatus("listening");
      // Ask for the opening greeting: it also proves the audio path works
      // before anyone has said a word.
      c.send({ type: "response.create" });
    } catch (e) {
      conn.current?.close();
      conn.current = null;
      setStatus("error");
      setError(e?.name === "NotAllowedError"
        ? tr("Microphone permission denied.", "No me diste permiso para usar el micrófono.")
        : (e?.message || tr("Could not start the voice session.", "No pude iniciar la sesión de voz.")));
    }
  }, [post, transport, onServerEvent, muted]);

  const toggleMute = useCallback(() => {
    setMuted((m) => { conn.current?.setMuted(!m); return !m; });
  }, []);

  // The on-screen Confirm / Cancel buttons: run the same tool the voice would
  // have, then tell the session what happened so the agent stays in the loop.
  const decide = useCallback(async (which) => {
    const tool = which === "confirm" ? "crm_confirm" : "crm_cancel";
    setPending(null);
    try {
      const j = await post({ action: "voice_tool", tool, input: {} });
      setActivity((a) => [...a.slice(-6), { id: `ui-${Date.now()}`, kind: "result", text: j.ui?.text || "", ms: j.ms }]);
      const text = which === "confirm"
        ? `(The user confirmed on screen. Result: ${j.output}) Tell them what happened in one short sentence.`
        : `(The user cancelled on screen. ${j.output}) Acknowledge it in one short sentence.`;
      injected.current.add(text);
      conn.current?.send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      requestResponse();
    } catch (e) {
      setError(e.message);
    }
  }, [post, requestResponse]);

  return { status, error, lines, activity, pending, metrics, muted, connect, disconnect, toggleMute, decide };
}

// ── UI ───────────────────────────────────────────────────────────────────────
const S = {
  wrap: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, background: "#F6F9FC" },
  bar: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e7edf4", background: "#fff", flexWrap: "wrap", flexShrink: 0 },
  pill: { fontSize: 11, fontWeight: 600, borderRadius: 20, padding: "3px 10px", textTransform: "uppercase", letterSpacing: .4 },
  body: { flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 },
  user: { alignSelf: "flex-end", maxWidth: "88%", background: "#185FA5", color: "#fff", borderRadius: "14px 14px 3px 14px", padding: "7px 11px", fontSize: 13.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  agent: { alignSelf: "flex-start", maxWidth: "88%", background: "#fff", border: "1px solid #e3eaf2", borderRadius: "14px 14px 14px 3px", padding: "7px 11px", fontSize: 13.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  chip: { alignSelf: "center", fontSize: 11, color: "#5c6f85", background: "#EDF3FA", border: "1px solid #d9e4f0", borderRadius: 12, padding: "3px 9px", maxWidth: "92%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  plan: { background: "#FFF8E6", border: "1px solid #F0D69B", borderRadius: 10, padding: "10px 12px", fontSize: 13, whiteSpace: "pre-wrap" },
  foot: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderTop: "1px solid #e7edf4", background: "#fff", flexWrap: "wrap", flexShrink: 0 },
  mic: { width: 46, height: 46, borderRadius: "50%", border: "none", color: "#fff", fontSize: 19, cursor: "pointer", flexShrink: 0 },
  ghost: { background: "none", border: "1px solid #cfdae7", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", color: "#33475e" },
  metric: { fontSize: 11, color: "#7a8aa0", display: "flex", gap: 10, flexWrap: "wrap" },
  select: { border: "1px solid #cfdae7", borderRadius: 8, padding: "4px 6px", fontSize: 12, background: "#fff", color: "#33475e" },
};

const STATUS_STYLE = {
  idle: { background: "#EDF1F6", color: "#5c6f85" },
  connecting: { background: "#FFF3D6", color: "#8a6d1f" },
  listening: { background: "#E3F5E9", color: "#1d7a45" },
  thinking: { background: "#E8EEFB", color: "#2b4c9b" },
  speaking: { background: "#E4F0FB", color: "#185FA5" },
  error: { background: "#FDE7E7", color: "#a32020" },
};

const STATUS_TEXT = {
  idle: () => tr("Off", "Apagado"),
  connecting: () => tr("Connecting", "Conectando"),
  listening: () => tr("Listening", "Escuchando"),
  thinking: () => tr("Thinking", "Pensando"),
  speaking: () => tr("Speaking", "Hablando"),
  error: () => tr("Error", "Error"),
};

const ms = (v) => (v == null ? "—" : `${v} ms`);

export function VoiceAgentPanel({ session }) {
  const [transport, setTransport] = useState("webrtc");
  const v = useVoiceAgent({ session, transport });
  const bodyRef = useRef(null);
  const live = v.status !== "idle" && v.status !== "error";

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [v.lines, v.activity, v.pending]);

  const hint = useMemo(() => (transport === "websocket"
    ? tr("Raw PCM over a WebSocket. Use headphones — there is no echo cancellation on this path.",
         "PCM crudo sobre WebSocket. Usá auriculares: por acá no hay cancelación de eco.")
    : tr("Opus over WebRTC: lowest latency and echo cancellation on speakerphone.",
         "Opus sobre WebRTC: la menor latencia y cancelación de eco en manos libres.")), [transport]);

  return (
    <div style={S.wrap}>
      <div style={S.bar}>
        <span style={{ ...S.pill, ...(STATUS_STYLE[v.status] || STATUS_STYLE.idle) }}>{(STATUS_TEXT[v.status] || STATUS_TEXT.idle)()}</span>
        <select
          value={transport}
          onChange={(e) => { v.disconnect(); setTransport(e.target.value); }}
          disabled={live}
          title="Transport"
          style={S.select}
        >
          <option value="webrtc">WebRTC</option>
          <option value="websocket">WebSocket</option>
        </select>
        <span style={{ ...S.metric, marginLeft: "auto" }}>
          <span title={tr("Time to open the session", "Lo que tardó en abrir la sesión")}>conn {ms(v.metrics.connectMs)}</span>
          <span title={tr("From the end of your sentence to the first word back", "Desde que terminás de hablar hasta la primera palabra de respuesta")}>reply {ms(v.metrics.replyMs)}</span>
          <span title={tr("Median reply over this session", "Mediana de respuesta de esta sesión")}>p50 {ms(v.metrics.replyMedian)}</span>
          <span title={tr("Last CRM tool call", "Última llamada a una herramienta del CRM")}>tool {ms(v.metrics.toolMs)}</span>
        </span>
      </div>

      <div ref={bodyRef} style={S.body}>
        {!v.lines.length && !live && (
          <div style={{ color: "#7a8aa0", fontSize: 13, textAlign: "center", padding: "18px 6px", lineHeight: 1.5 }}>
            Talk to the CRM. Ask what's being delivered this week, how much a job still owes, or tell it what happened and it will propose the change before writing anything.
          </div>
        )}
        {v.lines.map((l) => (
          <div key={l.id} style={l.role === "user" ? S.user : S.agent}>
            {l.text || <span style={{ opacity: .45 }}>…</span>}{l.partial && <span style={{ opacity: .5 }}> ▍</span>}
          </div>
        ))}
        {v.activity.map((a) => (
          <div key={a.id} style={S.chip} title={a.text}>
            {a.kind === "running" ? "⏳" : a.kind === "error" ? "⚠️" : a.kind === "lookup" ? "🔎" : a.kind === "plan" ? "📝" : "✅"}{" "}
            {a.text}{a.rows != null ? tr(` · ${a.rows} rows`, ` · ${a.rows} filas`) : ""}{a.ms != null ? ` · ${a.ms} ms` : ""}
          </div>
        ))}
        {v.pending && (
          <div style={S.plan}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Waiting for your confirmation</div>
            {v.pending.text}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={() => v.decide("confirm")} style={{ ...S.ghost, background: "#1d7a45", color: "#fff", border: "none" }}>Confirm</button>
              <button onClick={() => v.decide("cancel")} style={S.ghost}>Cancel</button>
            </div>
          </div>
        )}
        {v.error && <div style={{ ...S.chip, background: "#FDE7E7", borderColor: "#f2c2c2", color: "#a32020", whiteSpace: "normal" }}>⚠️ {v.error}</div>}
      </div>

      <div style={S.foot}>
        <button
          onClick={live ? v.disconnect : v.connect}
          title={live ? "Hang up" : "Start talking"}
          style={{ ...S.mic, background: live ? "#c0392b" : "#185FA5" }}
        >
          {live ? "■" : "🎙️"}
        </button>
        <button onClick={v.toggleMute} disabled={!live} style={{ ...S.ghost, opacity: live ? 1 : .5 }} title="Mute the agent">
          {v.muted ? "🔇" : "🔊"}
        </button>
        <span style={{ fontSize: 11, color: "#7a8aa0", flex: 1, minWidth: 150, lineHeight: 1.35 }}>{hint}</span>
      </div>
    </div>
  );
}
