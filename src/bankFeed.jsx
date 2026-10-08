// Bancos → Accounts: the bank feed panel and the daily bank email settings.
//
// Connect the bank once (Teller Connect: the person signs in to Chase inside
// Teller's own window — the CRM never sees the password), confirm which CRM
// account each bank account fills, and from then on every posted line lands in
// the Inbox as unreviewed, plus a summary email every morning. The access token
// stays on the server: this panel only ever talks to api/bank-analyze.mjs.
// Logic: lib/bankFeed.mjs (I/O) + src/bankFeedData.js (pure). docs/bank-feed.md.
import { useState, useEffect, useCallback } from "react";
import { BANK_FEED_SQL, problemText } from "./bankFeedData.js";
import { tr, getI18nLang } from "./i18n.js";

const TELLER_CONNECT_JS = "https://cdn.teller.io/connect/connect.js";
let tellerScript = null;
const loadTellerConnect = () => tellerScript || (tellerScript = new Promise((resolve, reject) => {
  if (window.TellerConnect) { resolve(window.TellerConnect); return; }
  const s = document.createElement("script");
  s.src = TELLER_CONNECT_JS;
  s.async = true;
  s.onload = () => (window.TellerConnect ? resolve(window.TellerConnect) : reject(new Error("Teller Connect did not load.")));
  s.onerror = () => {
    tellerScript = null;
    reject(new Error(tr("Could not load Teller Connect. Check the connection and try again.", "No se pudo cargar Teller Connect. Revisá la conexión y probá de nuevo.")));
  };
  document.head.appendChild(s);
}));

const box = { background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"14px 16px", marginBottom:14 };
const inp = { fontSize:13, padding:"7px 9px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", outline:"none" };
const th = { padding:"7px 8px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
const td = { padding:"7px 8px", fontSize:12.5, verticalAlign:"middle" };
const small = { fontSize:11.5, color:"#888" };
const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) : "—");

const STATUS_STYLE = {
  active: { bg:"#EAF3DE", text:"#3B6D11" },
  disconnected: { bg:"#FCEBEB", text:"#A32D2D" },
  error: { bg:"#FFF7ED", text:"#9A3412" },
};

export function BankFeedPanel({ session, accounts = [], canEdit, onReload, Btn, Modal }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState({});   // connection id → links being edited
  const [mail, setMail] = useState(null);     // { recipients, lang, enabled }
  const [preview, setPreview] = useState(null);
  const lang = getI18nLang();

  const call = useCallback(async (action, body = {}) => {
    const res = await fetch("/api/bank-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session?.access_token },
      body: JSON.stringify({ action, ...body }),
    });
    let json = {};
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }, [session]);

  const apply = (st) => {
    if (!st) return;
    setStatus(st);
    setDrafts(Object.fromEntries((st.connections || []).map(c => [c.id, c.links])));
    if (st.settings) setMail({ ...st.settings });
  };
  const load = useCallback(async () => {
    try { apply(await call("feed_status")); } catch (e) { setError(e.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn) => {
    setBusy(key); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(e.message || String(e)); }
    setBusy("");
  };
  const syncNote = (s) => {
    if (!s) return "";
    const parts = [`${s.imported} ${tr("new transactions imported to the Inbox", "movimientos nuevos importados a la Bandeja")}`];
    if (s.skipped?.duplicate) parts.push(`${s.skipped.duplicate} ${tr("were already in the ledger", "ya estaban en el ledger")}`);
    if (s.skipped?.pending) parts.push(`${s.skipped.pending} ${tr("still pending at the bank", "todavía pendientes en el banco")}`);
    return parts.join(" · ");
  };

  // Teller's own window. Passing an enrollment id repairs that connection
  // (the bank asked to sign in again) instead of adding a new one.
  const connect = (enrollmentId) => run("connect", async () => {
    const TC = await loadTellerConnect();
    await new Promise((resolve, reject) => {
      TC.setup({
        applicationId: status.appId,
        environment: status.environment,
        products: ["transactions"],
        selectAccount: "multiple",
        ...(enrollmentId ? { enrollmentId } : {}),
        onSuccess: async (enr) => {
          try {
            const r = await call("feed_enroll", { accessToken: enr.accessToken, enrollment: enr.enrollment });
            apply(r.status);
            setNotice(enrollmentId
              ? tr("Reconnected. Press Sync now to catch up.", "Reconectado. Tocá Sincronizar ahora para ponerte al día.")
              : tr("Connected. Check which CRM account each bank account fills and press Save links.", "Conectado. Revisá qué cuenta del CRM llena cada cuenta del banco y tocá Guardar vínculos."));
            resolve();
          } catch (e) { reject(e); }
        },
        onExit: () => resolve(),
        onFailure: (f) => reject(new Error(f?.message || "Teller Connect failed.")),
      }).open();
    });
  });

  const saveLinks = (c) => run("link-" + c.id, async () => {
    const r = await call("feed_link", { connection_id: c.id, links: drafts[c.id] || [] });
    apply(r.status);
    setNotice(syncNote(r.sync));
    onReload?.();
  });
  const syncNow = () => run("sync", async () => {
    const r = await call("feed_sync");
    apply(r.status);
    setNotice(syncNote(r.sync));
    onReload?.();
  });
  const disconnectConn = (c) => {
    if (!window.confirm(tr(
      `Disconnect ${c.institution || "the bank"}? New transactions stop arriving. What is already in Bancos stays.`,
      `¿Desconectar ${c.institution || "el banco"}? Dejan de llegar movimientos nuevos. Lo que ya está en Bancos queda.`,
    ))) return;
    run("disc-" + c.id, async () => { apply((await call("feed_disconnect", { connection_id: c.id })).status); onReload?.(); });
  };
  const saveMail = () => run("mail", async () => {
    apply((await call("digest_settings", mail)).status);
    setNotice(tr("Email settings saved.", "Configuración del email guardada."));
  });
  const openPreview = () => run("preview", async () => setPreview(await call("digest_preview")));
  const setLink = (cid, i, patch) => setDrafts(d => ({ ...d, [cid]: d[cid].map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const banner = (error || notice) && (
    <div style={{ background: error ? "#FCEBEB" : "#EAF3DE", color: error ? "#A32D2D" : "#3B6D11", borderRadius:8, padding:"8px 12px", fontSize:12.5, marginBottom:10 }}>{error || notice}</div>
  );

  if (!status) {
    return <div style={box}>{banner}<span style={small}>{error ? "" : "Loading the bank connection…"}</span></div>;
  }

  if (!status.configured) {
    return (
      <div style={{ ...box, background:"#F8FAFC" }}>
        <div style={{ fontSize:13.5, fontWeight:700, marginBottom:4 }}>🏦 Automatic bank feed</div>
        <div style={{ fontSize:12.5, color:"#555" }}>Connect the bank once and every transaction lands in the Inbox by itself, with a summary email every morning.</div>
        <div style={{ ...small, marginTop:6 }}>Not set up yet. Missing in Vercel: <b>{(status.missing || []).join(", ")}</b> · step by step in docs/bank-feed.md</div>
      </div>
    );
  }

  if (status.tablesMissing) {
    return (
      <div style={{ ...box, background:"#FFF7ED", border:"1px solid #FED7AA", color:"#9A3412" }}>
        <b style={{ fontSize:13 }}>The bank feed is not installed in the database yet.</b>
        <div style={{ fontSize:12.5, marginTop:6 }}>Paste this in the Supabase SQL Editor (or run scripts/setup-bank-feed.mjs) and reload:</div>
        <pre style={{ background:"#fff", border:"1px solid #eee", borderRadius:8, padding:10, fontSize:11, marginTop:8, maxHeight:180, overflow:"auto", whiteSpace:"pre-wrap" }}>{BANK_FEED_SQL}</pre>
        <Btn style={{ fontSize:12, padding:"5px 12px", marginTop:4 }} onClick={() => navigator.clipboard?.writeText(BANK_FEED_SQL)}>Copy SQL</Btn>
      </div>
    );
  }

  const conns = status.connections || [];
  const active = accounts.filter(a => a.active !== false);
  return (
    <div style={box}>
      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:10 }}>
        <div style={{ fontSize:13.5, fontWeight:700, flex:1, minWidth:200 }}>
          🏦 Automatic bank feed
          {status.environment !== "production" && <span style={{ marginLeft:8, fontSize:10.5, fontWeight:700, padding:"2px 8px", borderRadius:20, background:"#EEF2FF", color:"#4338CA" }}>{status.environment === "sandbox" ? "Sandbox: test data" : "Development: real data, free tier"}</span>}
        </div>
        {canEdit && conns.length > 0 && <Btn style={{ fontSize:12, padding:"5px 12px" }} onClick={syncNow} disabled={!!busy}>{busy === "sync" ? "Syncing..." : "Sync now"}</Btn>}
        {canEdit && <Btn primary style={{ fontSize:12, padding:"5px 12px" }} onClick={() => connect()} disabled={!!busy}>{busy === "connect" ? "Connecting…" : "＋ Connect bank"}</Btn>}
      </div>
      {banner}
      {!conns.length && <div style={{ fontSize:12.5, color:"#555" }}>Connect the bank once and every transaction lands in the Inbox by itself, with a summary email every morning.</div>}

      {conns.map(c => {
        const st = STATUS_STYLE[c.status] || STATUS_STYLE.error;
        const links = drafts[c.id] || [];
        return (
          <div key={c.id} style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", marginBottom:10 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <b style={{ fontSize:13 }}>{c.institution || "Bank"}</b>
              <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, background:st.bg, color:st.text }}>{c.status === "active" ? "Connected" : c.status === "disconnected" ? "Needs reconnect" : "Sync error"}</span>
              <span style={small}>Last sync:</span><span style={small}>{when(c.last_sync_at)}</span>
              <span style={{ flex:1 }} />
              {canEdit && c.status !== "active" && <Btn style={{ fontSize:12, padding:"4px 10px" }} onClick={() => connect(c.enrollment_id)} disabled={!!busy}>Reconnect</Btn>}
              {canEdit && <button onClick={() => disconnectConn(c)} disabled={!!busy} style={{ border:"none", background:"transparent", cursor:"pointer", color:"#bbb", fontSize:12 }}>Disconnect</button>}
            </div>
            {c.status !== "active" && (
              <div style={{ fontSize:12, color:st.text, marginTop:6 }}>
                {problemText({ kind: c.status === "disconnected" ? "disconnected" : "error", label: c.institution, detail: c.last_error }, lang)}
              </div>
            )}
            <div style={{ overflowX:"auto", marginTop:8 }}>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead><tr style={{ borderBottom:"1px solid #f3f3f3" }}>{["Bank account", "Fills this CRM account", "Import from"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {links.map((l, i) => (
                    <tr key={l.feed_account_id} style={{ borderBottom:"1px solid #f7f7f7" }}>
                      <td style={{ ...td, fontWeight:600, whiteSpace:"nowrap" }}>{l.label}</td>
                      <td style={td}>
                        {l.supported ? (
                          <select style={{ ...inp, minWidth:200 }} disabled={!canEdit} value={String(l.bank_account_id)}
                            onChange={e => setLink(c.id, i, { bank_account_id: e.target.value === "" || e.target.value === "new" ? e.target.value : Number(e.target.value) })}>
                            <option value="">— Don't import —</option>
                            <option value="new">＋ Create a new account</option>
                            {active.filter(a => a.type !== "credit_card").map(a => (
                              <option key={a.id} value={String(a.id)}>{a.name}{a.account_last4 ? ` ····${a.account_last4}` : ""}</option>
                            ))}
                          </select>
                        ) : <span style={small}>Cards are not imported yet</span>}
                      </td>
                      <td style={td}>
                        {l.supported && l.bank_account_id !== "" && (
                          <input type="date" style={inp} disabled={!canEdit} value={l.since || ""} onChange={e => setLink(c.id, i, { since: e.target.value })} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canEdit && links.length > 0 && (
              <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:8, flexWrap:"wrap" }}>
                <Btn style={{ fontSize:12, padding:"5px 12px" }} onClick={() => saveLinks(c)} disabled={!!busy}>{busy === "link-" + c.id ? "Saving…" : "Save links"}</Btn>
                <span style={small}>Lines dated before “Import from” are left out. Once an account is linked, stop uploading its screenshots: the feed brings every line by itself.</span>
              </div>
            )}
          </div>
        );
      })}

      {conns.length > 0 && mail && (
        <div style={{ borderTop:"1px solid #f3f3f3", paddingTop:12, marginTop:4 }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>✉️ Daily email</div>
          <div style={{ ...small, marginBottom:8 }}>Every morning around 8 AM (New York): what came in and went out of the linked accounts since the last email, and what is waiting for review. Sent from the company Gmail by the script in scripts/bank-digest-email.gs.</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"flex-start" }}>
            <textarea style={{ ...inp, flex:"1 1 260px", minHeight:38, fontFamily:"inherit", resize:"vertical" }} disabled={!canEdit}
              value={mail.recipients} onChange={e => setMail(m => ({ ...m, recipients: e.target.value }))}
              placeholder="Who gets it: emails separated by commas" />
            <select style={inp} disabled={!canEdit} value={mail.lang} onChange={e => setMail(m => ({ ...m, lang: e.target.value }))}>
              <option value="en">Email in English</option>
              <option value="es">Email in Spanish</option>
            </select>
            <label style={{ fontSize:12.5, display:"flex", alignItems:"center", gap:5, padding:"7px 0" }}>
              <input type="checkbox" disabled={!canEdit} checked={mail.enabled !== false} onChange={e => setMail(m => ({ ...m, enabled: e.target.checked }))} />
              <span>Send it</span>
            </label>
            {canEdit && <Btn style={{ fontSize:12, padding:"6px 12px" }} onClick={saveMail} disabled={!!busy}>{busy === "mail" ? "Saving…" : "Save"}</Btn>}
            <Btn style={{ fontSize:12, padding:"6px 12px" }} onClick={openPreview} disabled={!!busy}>{busy === "preview" ? "Loading…" : "Preview"}</Btn>
          </div>
          <div style={{ ...small, marginTop:6 }}><span>Last email sent:</span> <span>{when(mail.last_sent_at)}</span></div>
        </div>
      )}

      {preview && (
        <Modal title="Daily email preview" wide onClose={() => setPreview(null)}>
          <div style={{ fontSize:12.5, marginBottom:4 }}><b>To:</b> <span>{preview.to?.length ? preview.to.join(", ") : "—"}</span></div>
          <div style={{ fontSize:12.5, marginBottom:10 }}><b>Subject:</b> <span>{preview.subject}</span></div>
          {/* sandboxed: the email carries bank text, nothing in it may run */}
          <iframe title="Daily email preview" sandbox="" srcDoc={preview.html} style={{ width:"100%", height:"60vh", border:"1px solid #eee", borderRadius:8 }} />
        </Modal>
      )}
    </div>
  );
}
