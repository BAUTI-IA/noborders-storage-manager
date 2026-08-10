// Floating in-app chat with the CRM agent (same brain as Telegram/WhatsApp:
// create/update jobs with confirmation, ask anything about CRM data). Talks to
// /api/agent-chat authenticated with the user's Supabase session token.
import React, { useEffect, useRef, useState } from "react";

const S = {
  fab: { position: "fixed", right: 22, bottom: 22, zIndex: 4000, width: 56, height: 56, borderRadius: "50%", border: "none", background: "#185FA5", color: "#fff", fontSize: 26, cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,.25)" },
  panel: { position: "fixed", right: 22, bottom: 90, zIndex: 4000, width: 380, maxWidth: "calc(100vw - 44px)", height: 540, maxHeight: "calc(100vh - 130px)", background: "#fff", border: "1px solid #dde5ee", borderRadius: 14, boxShadow: "0 10px 34px rgba(0,0,0,.22)", display: "flex", flexDirection: "column", overflow: "hidden" },
  head: { background: "#185FA5", color: "#fff", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", fontWeight: 600 },
  body: { flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "#F6F9FC" },
  rowUser: { alignSelf: "flex-end", maxWidth: "85%", background: "#185FA5", color: "#fff", borderRadius: "14px 14px 3px 14px", padding: "8px 12px", fontSize: 13.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  rowBot: { alignSelf: "flex-start", maxWidth: "85%", background: "#fff", border: "1px solid #e3eaf2", borderRadius: "14px 14px 14px 3px", padding: "8px 12px", fontSize: 13.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  foot: { display: "flex", gap: 8, padding: 10, borderTop: "1px solid #e7edf4", background: "#fff" },
  input: { flex: 1, border: "1px solid #cfdae7", borderRadius: 9, padding: "9px 12px", fontSize: 13.5, outline: "none", resize: "none", fontFamily: "inherit", lineHeight: 1.35 },
  send: { border: "none", background: "#185FA5", color: "#fff", borderRadius: 9, padding: "0 16px", fontSize: 15, cursor: "pointer" },
};

const WELCOME = "¡Hola! Soy el agente del CRM 🚚 Puedo cargar/actualizar jobs (con tu confirmación) y responder cualquier consulta: \"¿qué entregas hay esta semana?\", \"¿cuánto hay por cobrar?\"...\n\nI also speak English — just write to me in either language.";

const MAX_FILE_BYTES = 3 * 1024 * 1024; // must fit Vercel's 4.5MB body cap after base64
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

export function AgentChatWidget({ session }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([{ role: "bot", text: WELCOME }]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]); // { name, media_type, data(base64) }
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs, open, busy]);

  function addFiles(list) {
    const incoming = [...(list || [])];
    for (const f of incoming) {
      if (!ACCEPTED.includes(f.type)) { setMsgs((m) => [...m, { role: "bot", text: `⚠️ "${f.name}": solo imágenes o PDF.` }]); continue; }
      if (f.size > MAX_FILE_BYTES) { setMsgs((m) => [...m, { role: "bot", text: `⚠️ "${f.name}" pesa más de 3MB.` }]); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(",")[1] || "";
        setFiles((prev) => (prev.length >= 3 ? prev : [...prev, { name: f.name, media_type: f.type, data }]));
      };
      reader.readAsDataURL(f);
    }
  }

  // The live bubble is the last message while it's still being written; `done`
  // replaces it with the server's authoritative reply.
  function putLive(text) {
    setMsgs((m) => {
      const copy = [...m];
      if (copy.length && copy[copy.length - 1].live) copy[copy.length - 1] = { role: "bot", text, live: true };
      else copy.push({ role: "bot", text, live: true });
      return copy;
    });
  }
  function settleLive(text) {
    setMsgs((m) => {
      const copy = [...m];
      if (copy.length && copy[copy.length - 1].live) copy[copy.length - 1] = { role: "bot", text };
      else copy.push({ role: "bot", text });
      return copy;
    });
  }

  async function send() {
    const text = input.trim();
    if ((!text && !files.length) || busy) return;
    const attachments = files.map(({ media_type, data }) => ({ media_type, data }));
    const label = text + (files.length ? `${text ? "\n" : ""}📎 ${files.map((f) => f.name).join(", ")}` : "");
    setInput("");
    setFiles([]);
    setMsgs((m) => [...m, { role: "user", text: label }]);
    setBusy(true);
    try {
      const res = await fetch("/api/agent-hub", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
        body: JSON.stringify({ message: text, attachments, stream: true }),
      });
      // Errors (auth, validation) still come back as plain JSON with a status.
      if (!res.ok || !res.body || !(res.headers.get("content-type") || "").includes("text/event-stream")) {
        const j = await res.json().catch(() => ({}));
        setMsgs((m) => [...m, { role: "bot", text: res.ok ? (j.reply || "…") : `⚠️ ${j.error || `Error ${res.status}`}` }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", answer = "", status = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() || ""; // keep the incomplete event for the next read
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === "delta") { answer += ev.text; putLive(answer); }
          else if (ev.type === "status") { status = ev.text; if (!answer) putLive(status); }
          else if (ev.type === "reset") { answer = ""; putLive(status || "…"); }
          else if (ev.type === "done") { settleLive(ev.reply || answer || "…"); answer = ""; }
          else if (ev.type === "error") { settleLive(`⚠️ ${ev.error}`); answer = ""; }
        }
      }
      // Stream cut off mid-answer: keep whatever arrived rather than losing it.
      if (answer) settleLive(answer);
    } catch (e) {
      setMsgs((m) => [...m, { role: "bot", text: "⚠️ No pude conectar con el agente. Probá de nuevo." }]);
    } finally {
      setBusy(false);
      setMsgs((m) => m.map((x) => (x.live ? { ...x, live: false } : x)));
    }
  }

  // One-time code that proves, from an authenticated CRM session, that a
  // Telegram account belongs to this user — so the agent can apply their
  // permissions to writes made from Telegram.
  async function linkTelegram() {
    try {
      const res = await fetch("/api/agent-hub", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
        body: JSON.stringify({ action: "link_code" }),
      });
      const j = await res.json().catch(() => ({}));
      setMsgs((m) => [...m, { role: "bot", text: res.ok
        ? `🔗 Tu código es ${j.code} (vence en ${j.expires_in_minutes} min).\nMandale al bot de Telegram: /link ${j.code}`
        : `⚠️ ${j.error || "No pude generar el código"}` }]);
      setOpen(true);
    } catch {
      setMsgs((m) => [...m, { role: "bot", text: "⚠️ No pude generar el código. Probá de nuevo." }]);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <>
      {open && (
        <div style={S.panel}>
          <div style={S.head}>
            <span>🤖 CRM Agent</span>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={linkTelegram} title="Link Telegram" style={{ background: "none", border: "1px solid rgba(255,255,255,.4)", color: "#fff", fontSize: 11, borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>Link Telegram</button>
              <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
            </span>
          </div>
          <div ref={bodyRef} style={S.body}>
            {msgs.map((m, i) => (
              <div key={i} style={m.role === "user" ? S.rowUser : S.rowBot}>
                {m.text}{m.live && <span style={{ color: "#9fb0c4" }}> ▍</span>}
              </div>
            ))}
            {busy && !msgs[msgs.length - 1]?.live && <div style={{ ...S.rowBot, color: "#7a8aa0" }}>Typing…</div>}
          </div>
          {files.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 10px 0", background: "#fff", borderTop: "1px solid #e7edf4" }}>
              {files.map((f, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#EDF3FA", border: "1px solid #cfdae7", borderRadius: 14, padding: "3px 9px", fontSize: 12 }}>
                  {f.media_type === "application/pdf" ? "📄" : "🖼️"} {f.name.length > 22 ? f.name.slice(0, 20) + "…" : f.name}
                  <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, padding: 0, color: "#7a8aa0" }}>×</button>
                </span>
              ))}
            </div>
          )}
          <div style={S.foot}>
            <input ref={fileRef} type="file" accept={ACCEPTED.join(",")} multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <button title="Attach photo or PDF" onClick={() => fileRef.current?.click()} disabled={busy || files.length >= 3} style={{ background: "none", border: "1px solid #cfdae7", borderRadius: 9, padding: "0 10px", fontSize: 16, cursor: "pointer", opacity: busy || files.length >= 3 ? 0.5 : 1 }}>📎</button>
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              onPaste={(e) => { const items = [...(e.clipboardData?.files || [])]; if (items.length) { e.preventDefault(); addFiles(items); } }}
              placeholder="Message the agent…"
              style={S.input}
              disabled={busy}
              autoFocus
            />
            <button onClick={send} disabled={busy || (!input.trim() && !files.length)} style={{ ...S.send, opacity: busy || (!input.trim() && !files.length) ? 0.5 : 1 }}>➤</button>
          </div>
        </div>
      )}
      <button title="CRM Agent" onClick={() => setOpen((o) => !o)} style={S.fab}>{open ? "×" : "🤖"}</button>
    </>
  );
}
