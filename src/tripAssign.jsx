// Driver → trip suggestion popup (Trips / Live Load).
//
// Right after a driver is assigned to a job this proposes the trip the job
// should ride — the driver's own trip, or a new one on that driver's truck —
// and from the Trips page it lists every job that has a driver but no trip yet.
// A job with several drivers asks first which of them takes the truck.
// Nothing is saved until the dispatcher confirms.
//
// UI only: the math lives in tripAssignData.js and the writes in App.jsx
// (applyTripPlan). Btn / Modal / inp arrive as props to avoid a circular
// import with App.jsx (same split as expenses.jsx).
import { useMemo, useState } from "react";
import { tr } from "./i18n.js";
import { suggestTrip, capacity, truckBusyTrip, jobUnits, nextMove } from "./tripAssignData.js";

const occColor = (pct) => pct > 90 ? "#E24B4A" : pct >= 70 ? "#EF9F27" : "#639922";
const tripName = (t) => t ? (t.trip_number || `#${t.id}`) : "";
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const tripState = (t) => t?.status === "in_transit" ? tr("on the road", "en ruta") : tr("loading", "cargando");
// "pickup 2026-10-02" / "delivery 2026-10-09" / "no pickup date".
const moveLabel = (m) => m.date
  ? `${m.kind === "pickup" ? "pickup" : "delivery"} ${m.date}`
  : (m.kind === "pickup" ? tr("no pickup date", "sin fecha de pickup") : tr("no delivery date", "sin fecha de delivery"));

const capS = { fontSize:10.5, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", margin:"12px 0 6px" };
const noteS = (bg, fg) => ({ fontSize:12, color:fg, background:bg, borderRadius:8, padding:"7px 10px", marginTop:8, lineHeight:1.45 });
const linkBtn = { border:"none", background:"none", padding:0, cursor:"pointer", color:"#185FA5", textDecoration:"underline", fontSize:"inherit", fontFamily:"inherit" };

export function TripAssignModal({
  items, queue, hiddenCount = 0, jobs, trips, trucks, drivers, today, busy,
  onApply, onEdit, onDismiss, onUnhide, onOpenJob, onOpenTrip, onClose,
  Btn, Modal, inp,
}) {
  // What each confirmed card saved, by job: { trip, count, waHref }.
  const [results, setResults] = useState({});
  const pending = items.filter(it => !results[it.key]);
  const shown = pending.slice(0, 25);
  const done = Object.entries(results);
  return (
    <Modal wide={queue}
      title={queue
        ? tr(`Jobs with a driver but no trip (${pending.length})`, `Jobs con driver y sin trip (${pending.length})`)
        : tr("Put the job on a trip", "Subí el job a un trip")}
      onClose={onClose}
      footer={<>
        {queue && hiddenCount > 0 && (
          <Btn onClick={onUnhide} style={{ marginRight:"auto" }}>
            {tr(`Show the ${hiddenCount} put aside`, `Mostrar los ${hiddenCount} que dejaste para después`)}
          </Btn>
        )}
        <Btn onClick={onClose}>Close</Btn>
      </>}>
      {!queue && !done.length && (
        <div style={{ fontSize:12.5, color:"#777", marginBottom:12, lineHeight:1.5 }}>
          The driver is set, so the job should ride that driver's truck. This is the trip it would go on — nothing is saved until you confirm.
        </div>
      )}
      {queue && (
        <div style={{ fontSize:12.5, color:"#777", marginBottom:12, lineHeight:1.5 }}>
          These jobs already have a driver but are not on any trip yet. Confirm each one to put it on that driver's truck.
        </div>
      )}

      {done.map(([key, r]) => (
        <div key={key} style={{ background:"#EAF3DE", border:"1px solid #cfe3b3", borderRadius:10, padding:"10px 12px", marginBottom:10, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span style={{ fontSize:13, color:"#3B6D11", fontWeight:600, flex:1, minWidth:200 }}>
            ✓ {`${r.label} → ${tripName(r.trip)} (${r.driverName})`}
          </span>
          {r.waHref && <a href={r.waHref} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn style={{ padding:"5px 11px", fontSize:12 }}>📲 Notify the driver</Btn></a>}
          <Btn primary onClick={() => onOpenTrip(r.trip.id)} style={{ padding:"5px 11px", fontSize:12 }}>Open trip</Btn>
        </div>
      ))}

      {queue && pending.length === 0 && (
        <div style={{ padding:"18px", textAlign:"center", color:"#999", fontSize:13 }}>
          {hiddenCount > 0
            ? tr(`Nothing left to review — ${hiddenCount} put aside.`, `No queda nada por revisar — ${hiddenCount} para después.`)
            : "Every job with a driver is on a trip."}
        </div>
      )}

      {shown.map(it => (
        <AssignCard key={it.key} item={it} queue={queue} jobs={jobs} trips={trips} trucks={trucks} drivers={drivers} today={today}
          busy={busy} onApply={onApply} onEdit={onEdit} onDismiss={onDismiss} onOpenJob={onOpenJob} onOpenTrip={onOpenTrip}
          onDone={(r) => setResults(x => ({ ...x, [it.key]: r }))} Btn={Btn} inp={inp} />
      ))}
      {pending.length > shown.length && (
        <div style={{ fontSize:12, color:"#999", textAlign:"center", padding:"6px" }}>
          {tr(`+${pending.length - shown.length} more — confirm these first`, `+${pending.length - shown.length} más — confirmá estos primero`)}
        </div>
      )}
    </Modal>
  );
}

function AssignCard({ item, queue, jobs, trips, trucks, drivers, today, busy, onApply, onEdit, onDismiss, onOpenJob, onOpenTrip, onDone, Btn, inp }) {
  const ids = item.driverIds;
  const multi = ids.length > 1;
  // A job with several drivers waits for the dispatcher to say who drives.
  const [driverId, setDriverId] = useState(multi ? null : ids[0]);
  const [optKey, setOptKey] = useState(null);     // null = the suggested option
  const [truckId, setTruckId] = useState(null);   // new trip: null = the driver's truck
  const [departure, setDeparture] = useState(null);
  const [picked, setPicked] = useState(null);     // companion keys; null = the near ones
  const pickDriver = (id) => { setDriverId(id); setOptKey(null); setTruckId(null); setDeparture(null); setPicked(null); };

  const nameOf = (id) => drivers.find(d => sameId(d.id, id))?.name || `#${id}`;
  const rep = item.rows.find(r => !r.split_group) || item.rows[0];
  const units = useMemo(() => jobUnits(item.rows, trips), [item.rows, trips]);
  const jobCf = units.reduce((s, u) => s + u.cf, 0);
  const move = nextMove(rep);
  const sug = useMemo(() => driverId ? suggestTrip({ rows: item.rows, driverId, jobs, trips, trucks, drivers, today }) : null,
    [driverId, item.rows, jobs, trips, trucks, drivers, today]);
  const opt = sug ? (sug.options.find(o => o.key === optKey) || sug.options[0]) : null;
  const pickedSet = picked || new Set((sug?.companions || []).filter(c => c.near).map(c => c.key));
  const togglePick = (k) => setPicked(() => { const n = new Set(pickedSet); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const comps = (sug?.companions || []).filter(c => pickedSet.has(c.key));
  const compCf = comps.reduce((s, c) => s + c.cf, 0);

  // New-trip fields, defaulting to the driver's truck and the job's next move.
  const newOpt = sug?.options.find(o => o.kind === "new");
  const newTruckId = truckId ?? (newOpt?.truck ? String(newOpt.truck.id) : "");
  const newDeparture = departure ?? (newOpt?.departure || today);
  const truckFor = (o) => o.kind === "new" ? (trucks.find(t => sameId(t.id, newTruckId)) || null) : o.truck;
  const capOf = (o, extra) => capacity(truckFor(o)?.capacity_cf, o.loadCf, o.placeCf + extra);
  const sel = opt ? capOf(opt, compCf) : null;
  // A new trip on a truck that is already out (or loading) — this driver's or not.
  const busyTrip = opt?.kind === "new" ? truckBusyTrip(newTruckId, trips, null) : null;
  const canConfirm = !!opt && (opt.placeKeys.length > 0 || opt.claim);

  const plan = () => {
    const anchor = sug.units.filter(u => opt.placeKeys.includes(u.key));
    // Stops by date of their next move (undated last); the dispatcher can drag them later.
    const ordered = [...anchor, ...comps].sort((a, b) => (nextMove(a.row).date || "9999").localeCompare(nextMove(b.row).date || "9999"));
    return {
      jobKey: item.key,
      driverId,
      option: opt.kind === "new"
        ? { kind: "new", truckId: newTruckId || null, departure: newDeparture || today }
        : { kind: "existing", tripId: opt.trip.id, claim: !!opt.claim },
      unitKeys: ordered.map(u => u.key),
      // The job's own units whose driver list follows the trip's driver.
      anchorKeys: [...anchor.map(u => u.key), ...(opt.claim ? sug.units.filter(u => u.trip && sameId(u.trip.id, opt.trip.id)).map(u => u.key) : [])],
      label: `#${rep.job_number || "—"}${comps.length ? ` +${comps.length}` : ""}`,
    };
  };
  const confirm = async () => {
    const p = plan();
    const r = await onApply(p);
    if (r) onDone({ ...r, label: p.label, driverName: nameOf(driverId) });
  };

  const chip = (on) => ({ fontSize:12.5, padding:"6px 12px", borderRadius:20, cursor:"pointer", border:`1px solid ${on ? "#111" : "#e5e5e5"}`, background: on ? "#111" : "#fff", color: on ? "#fff" : "#333", fontWeight: on ? 600 : 500 });
  const optRow = (on) => ({ display:"flex", alignItems:"center", gap:10, padding:"9px 11px", borderRadius:9, cursor:"pointer", marginBottom:6, border:`1px solid ${on ? "#111" : "#ececec"}`, background: on ? "#fafafa" : "#fff" });

  return (
    <div style={{ border:"1px solid #ececec", borderRadius:12, padding:"12px 14px", marginBottom:12, background:"#fff" }}>
      {/* The job */}
      <div style={{ display:"flex", alignItems:"baseline", gap:8, flexWrap:"wrap" }}>
        <button onClick={() => onOpenJob(item.key)} style={{ ...linkBtn, fontFamily:"monospace", fontWeight:700, fontSize:13.5, color:"#111" }}>#{rep.job_number || "—"}</button>
        <span style={{ fontWeight:600, fontSize:13.5 }}>{rep.customer || "—"}</span>
        {(rep.pickup_state || rep.delivery_state) && <span style={{ color:"#888", fontSize:12.5 }}>{(rep.pickup_state || "?").toUpperCase()} → {(rep.delivery_state || "?").toUpperCase()}</span>}
        <span style={{ marginLeft:"auto", color:"#888", fontSize:12 }}>
          {`${Math.round(jobCf).toLocaleString()} CF · ${moveLabel(move)}`}
        </span>
      </div>

      {/* Who drives */}
      {multi ? (
        <div style={{ background:"#F5F3FF", border:"1px solid #DDD3F7", borderRadius:10, padding:"10px 12px", marginTop:10 }}>
          <div style={{ fontSize:12.5, fontWeight:600, color:"#5B3FBF", marginBottom:7 }}>
            {tr(`This job has ${ids.length} drivers — who takes the truck?`, `Este job tiene ${ids.length} drivers — ¿quién lleva el camión?`)}
          </div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {ids.map((id, i) => (
              <button key={id} onClick={() => pickDriver(id)} style={chip(sameId(driverId, id))}
                title={i === 0 ? tr("Main driver on the job today", "Driver principal del job hoy") : undefined}>
                🧑‍✈️ {nameOf(id)}{i === 0 ? " ★" : ""}
              </button>
            ))}
          </div>
          {driverId != null && !sameId(driverId, ids[0]) && (
            <div style={{ fontSize:11.5, color:"#6D28D9", marginTop:7 }}>
              {tr(`${nameOf(driverId)} becomes the job's main driver (cash and extras default to them).`, `${nameOf(driverId)} pasa a ser el driver principal del job (el efectivo y los extras quedan a su nombre).`)}
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize:12.5, color:"#555", marginTop:6 }}>🧑‍✈️ {nameOf(ids[0])}</div>
      )}

      {!sug ? (
        <div style={{ fontSize:12, color:"#999", marginTop:10 }}>Pick the driver to see the trip.</div>
      ) : sug.pending.length === 0 ? (
        <div style={noteS("#EAF3DE", "#3B6D11")}>
          {sug.done.length
            ? <>✓ {tr(`Already on ${nameOf(driverId)}'s trip ${tripName(sug.done[0].trip)}.`, `Ya está en el trip ${tripName(sug.done[0].trip)} de ${nameOf(driverId)}.`)}{" "}
                <button onClick={() => onOpenTrip(sug.done[0].trip.id)} style={linkBtn}>Open trip</button></>
            : tr("It is on a truck that is already on the road — hand it off from that trip.", "Está en un camión que ya salió — pasalo con un handoff desde ese trip.")}
        </div>
      ) : (<>
        {/* Where it can go */}
        <div style={capS}>Trip</div>
        {sug.options.map((o, i) => {
          const on = o.key === opt.key;
          const c = capOf(o, on ? compCf : 0);
          const tk = truckFor(o);
          return (
            <div key={o.key}>
              <div onClick={() => setOptKey(o.key)} style={optRow(on)}>
                <input type="radio" readOnly checked={on} style={{ margin:0 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, display:"flex", alignItems:"center", gap:7, flexWrap:"wrap" }}>
                    <span>
                      {o.kind === "new"
                        ? tr(`New trip for ${nameOf(driverId)}`, `Trip nuevo para ${nameOf(driverId)}`)
                        : o.claim
                          ? tr(`Take ${tripName(o.trip)} — it has no driver yet`, `Tomar ${tripName(o.trip)} — todavía no tiene driver`)
                          : tr(`Add to ${tripName(o.trip)}`, `Agregar a ${tripName(o.trip)}`)}
                    </span>
                    {i === 0 && <span style={{ fontSize:10, fontWeight:700, color:"#3B6D11", background:"#EAF3DE", borderRadius:20, padding:"1px 8px" }}>Suggested</span>}
                  </div>
                  <div style={{ fontSize:11.5, color:"#888", marginTop:2 }}>
                    {o.kind === "new"
                      ? (tk ? `🚛 ${tk.name || `#${tk.id}`}` : tr("🚛 no truck picked", "🚛 sin camión elegido"))
                      : [`🚛 ${tk?.name || tr("no truck", "sin camión")}`, tripState(o.trip), o.trip.departure_date ? tr(`departs ${o.trip.departure_date}`, `sale ${o.trip.departure_date}`) : ""].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {c.cap > 0
                  ? <span style={{ fontSize:12, fontWeight:700, color: occColor(c.pctAfter), whiteSpace:"nowrap" }}>{c.pctBefore}% → {c.pctAfter}%</span>
                  : <span style={{ fontSize:11, color:"#bbb", whiteSpace:"nowrap" }}>{`${Math.round(c.after).toLocaleString()} CF`}</span>}
              </div>
              {on && o.kind === "new" && (
                <div style={{ display:"flex", gap:10, flexWrap:"wrap", margin:"-2px 0 8px 30px", alignItems:"flex-end" }}>
                  <div style={{ display:"flex", flexDirection:"column", gap:3, minWidth:180, flex:1 }}>
                    <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Truck</label>
                    <select style={{ ...inp, boxSizing:"border-box" }} value={newTruckId} onChange={e => setTruckId(e.target.value)}>
                      <option value="">— No truck —</option>
                      {trucks.filter(t => t.active !== false || sameId(t.id, newTruckId)).map(t => (
                        <option key={t.id} value={String(t.id)}>{t.name || `#${t.id}`}{Number(t.capacity_cf) > 0 ? ` · ${Number(t.capacity_cf).toLocaleString()} CF` : ""}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                    <label style={{ fontSize:10.5, fontWeight:600, color:"#888", textTransform:"uppercase" }}>Departure</label>
                    <input type="date" style={{ ...inp, boxSizing:"border-box" }} value={newDeparture} onChange={e => setDeparture(e.target.value)} />
                  </div>
                  <div style={{ width:"100%", fontSize:11.5, color:"#888" }}>
                    {o.truckSource === "linked" || o.truckSource === "named"
                      ? tr(`${nameOf(driverId)}'s truck, from the Drivers page.`, `El camión de ${nameOf(driverId)}, según la página de Drivers.`)
                      : o.truckSource === "history"
                        ? tr(`The truck of ${nameOf(driverId)}'s last trip — set the driver's truck in Drivers to skip this guess.`, `El camión del último trip de ${nameOf(driverId)} — cargale el camión en Drivers para no tener que adivinar.`)
                        : tr(`${nameOf(driverId)} has no truck yet — pick one here, or set it in Drivers.`, `${nameOf(driverId)} todavía no tiene camión — elegí uno acá, o cargalo en Drivers.`)}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Same driver, also waiting for a truck */}
        {sug.companions.length > 0 && (<>
          <div style={capS}>{tr(`Other jobs of ${nameOf(driverId)} with no trip`, `Otros jobs de ${nameOf(driverId)} sin trip`)}</div>
          <div style={{ border:"1px solid #f0f0f0", borderRadius:9, overflow:"hidden" }}>
            {sug.companions.slice(0, 8).map(c => (
              <label key={c.key} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:12.5, cursor:"pointer", borderBottom:"1px solid #f6f6f6", background: pickedSet.has(c.key) ? "#f6fbf0" : "#fff" }}>
                <input type="checkbox" checked={pickedSet.has(c.key)} onChange={() => togglePick(c.key)} />
                <span style={{ fontFamily:"monospace", fontWeight:700 }}>#{c.row.job_number || "—"}</span>
                <span style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.row.customer || "—"}</span>
                <span style={{ color: c.near ? "#3B6D11" : "#999", whiteSpace:"nowrap" }}>📅 {moveLabel(c.move)}</span>
                <span style={{ color:"#888", whiteSpace:"nowrap" }}>{Math.round(c.cf).toLocaleString()} CF</span>
              </label>
            ))}
          </div>
          {sug.companions.length > 8 && <div style={{ fontSize:11.5, color:"#999", marginTop:4 }}>{tr(`+${sug.companions.length - 8} more`, `+${sug.companions.length - 8} más`)}</div>}
        </>)}

        {/* The load once it is all on */}
        {sel.cap > 0 && (
          <div style={{ marginTop:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4 }}>
              <b style={{ color: occColor(sel.pctAfter) }}>{tr(`${sel.pctAfter}% of ${truckFor(opt)?.name || "the truck"}`, `${sel.pctAfter}% de ${truckFor(opt)?.name || "el camión"}`)}</b>
              <span style={{ color:"#888" }}>{Math.round(sel.after).toLocaleString()} / {Math.round(sel.cap).toLocaleString()} CF</span>
            </div>
            <div style={{ background:"#eee", borderRadius:6, height:9, overflow:"hidden" }}>
              <div style={{ background: occColor(sel.pctAfter), height:9, width:`${Math.min(100, sel.pctAfter)}%` }} />
            </div>
          </div>
        )}
        {sel.full && <div style={noteS("#FCEBEB", "#A32D2D")}>{tr("⚠ That is over 90% of the truck — think about another truck or splitting a job.", "⚠ Eso pasa el 90% del camión — pensá en otro camión o en dividir un job.")}</div>}
        {busyTrip && (sameId(busyTrip.driver_id, driverId) ? (
          <div style={noteS("#F5F7FA", "#556")}>
            {tr(`${truckFor(opt)?.name || "That truck"} is already on ${tripName(busyTrip)} (${tripState(busyTrip)}) — a new trip is a second run after that one.`,
                `${truckFor(opt)?.name || "Ese camión"} ya está en ${tripName(busyTrip)} (${tripState(busyTrip)}) — un trip nuevo es una segunda vuelta después de ese.`)}
          </div>
        ) : (
          <div style={noteS("#FEF3C7", "#92760B")}>
            {tr(`⚠ ${truckFor(opt)?.name || "That truck"} is on ${tripName(busyTrip)} with ${busyTrip.driver_id != null ? nameOf(busyTrip.driver_id) : "no driver"} (${tripState(busyTrip)}).`,
                `⚠ ${truckFor(opt)?.name || "Ese camión"} está en ${tripName(busyTrip)} con ${busyTrip.driver_id != null ? nameOf(busyTrip.driver_id) : "sin driver"} (${tripState(busyTrip)}).`)}
          </div>
        ))}
        {sug.units.filter(u => opt.placeKeys.includes(u.key) && u.trip).map(u => (
          <div key={"mv" + u.key} style={noteS("#F5F7FA", "#556")}>
            {tr(`Leaves ${tripName(u.trip)}${u.trip.driver_id != null ? ` (${nameOf(u.trip.driver_id)})` : ""}.`, `Sale de ${tripName(u.trip)}${u.trip.driver_id != null ? ` (${nameOf(u.trip.driver_id)})` : ""}.`)}
          </div>
        ))}
        {sug.locked.map(u => (
          <div key={"lk" + u.key} style={noteS("#F5F7FA", "#556")}>
            {tr(`${Math.round(u.cf)} CF stay on ${tripName(u.trip)} — that truck is on the road; hand it off from the trip.`, `${Math.round(u.cf)} CF quedan en ${tripName(u.trip)} — ese camión ya salió; pasalo con un handoff desde el trip.`)}
          </div>
        ))}
        {opt.kind === "existing" && opt.trip.status === "in_transit" && (
          <div style={noteS("#EDE9FE", "#6D28D9")}>
            {tr(`${tripName(opt.trip)} is already on the road — after confirming you can send the driver a WhatsApp update.`, `${tripName(opt.trip)} ya está en ruta — después de confirmar le podés mandar un update por WhatsApp al driver.`)}
          </div>
        )}
      </>)}

      {/* Actions */}
      <div style={{ display:"flex", gap:8, justifyContent:"flex-end", marginTop:12, flexWrap:"wrap" }}>
        {queue && <Btn onClick={() => onDismiss(item)} style={{ marginRight:"auto" }}>Not now</Btn>}
        {sug && canConfirm && <Btn onClick={() => onEdit(plan())}>Edit in trip form</Btn>}
        {sug && canConfirm && (
          <Btn primary disabled={busy} onClick={confirm}>
            {busy ? "Saving..." : opt.kind === "new" ? "Create trip" : opt.claim ? "Take trip" : "Add to trip"}
          </Btn>
        )}
      </div>
    </div>
  );
}
