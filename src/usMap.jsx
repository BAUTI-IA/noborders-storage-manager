// US maps (react-simple-maps + us-atlas state shapes), shared by the Storages
// page (count choropleth) and Analytics (margin choropleth).
import { useRef, useState } from "react";
import { ComposableMap, Geographies, Geography, Marker } from "react-simple-maps";
import { geoCentroid } from "d3-geo";

export const US_GEO_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";
// Full state name → 2-letter code, to join us-atlas geographies with our stats.
export const US_NAME_TO_CODE = {
  Alabama:"AL", Alaska:"AK", Arizona:"AZ", Arkansas:"AR", California:"CA", Colorado:"CO", Connecticut:"CT",
  Delaware:"DE", "District of Columbia":"DC", Florida:"FL", Georgia:"GA", Hawaii:"HI", Idaho:"ID", Illinois:"IL",
  Indiana:"IN", Iowa:"IA", Kansas:"KS", Kentucky:"KY", Louisiana:"LA", Maine:"ME", Maryland:"MD", Massachusetts:"MA",
  Michigan:"MI", Minnesota:"MN", Mississippi:"MS", Missouri:"MO", Montana:"MT", Nebraska:"NE", Nevada:"NV",
  "New Hampshire":"NH", "New Jersey":"NJ", "New Mexico":"NM", "New York":"NY", "North Carolina":"NC",
  "North Dakota":"ND", Ohio:"OH", Oklahoma:"OK", Oregon:"OR", Pennsylvania:"PA", "Rhode Island":"RI",
  "South Carolina":"SC", "South Dakota":"SD", Tennessee:"TN", Texas:"TX", Utah:"UT", Vermont:"VT", Virginia:"VA",
  Washington:"WA", "West Virginia":"WV", Wisconsin:"WI", Wyoming:"WY",
};
export const US_CODE_TO_NAME = Object.fromEntries(Object.entries(US_NAME_TO_CODE).map(([n, c]) => [c, n]));
// Choropleth fill by number of active storages; badge dot uses the stronger tone.
export const stateFill = (count) => !count ? "#f5f5f5" : count >= 6 ? "#FCEBEB" : count >= 3 ? "#FAEEDA" : "#EAF3DE";
export const stateDotColor = (count) => count >= 6 ? "#E24B4A" : count >= 3 ? "#EF9F27" : "#639922";

export function UsStorageMap({ stats, selected, onSelect }) {
  const wrapRef = useRef();
  const [tt, setTt] = useState(null);   // { code, x, y } tooltip anchor (relative to wrapper)
  const showTip = (code, e) => {
    const r = wrapRef.current?.getBoundingClientRect(); if (!r) return;
    setTt({ code, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const ts = tt ? (stats[tt.code] || { count:0, cf:0, due:0 }) : null;
  return (
    <div ref={wrapRef} style={{ position:"relative", background:"#fff", border:"1px solid #efefef", borderRadius:12, padding:"6px 10px 4px", marginBottom:14 }}>
      <ComposableMap projection="geoAlbersUsa" projectionConfig={{ scale: 1000 }} width={800} height={500} style={{ width:"100%", height:"auto" }}>
        {/* state shapes */}
        <Geographies geography={US_GEO_URL}>
          {({ geographies }) => geographies.map(geo => {
            const code = US_NAME_TO_CODE[geo.properties.name];
            const count = (code && stats[code]?.count) || 0;
            const isSel = code && selected === code;
            return (
              <Geography key={geo.rsmKey} geography={geo}
                onMouseEnter={(e) => code && showTip(code, e)}
                onMouseMove={(e) => code && showTip(code, e)}
                onMouseLeave={() => setTt(null)}
                onClick={() => code && onSelect(selected === code ? "" : code)}
                style={{
                  default: { fill: stateFill(count), stroke: isSel ? "#111" : "#e0e0e0", strokeWidth: isSel ? 1.6 : 0.6, outline:"none", cursor: code ? "pointer" : "default" },
                  hover:   { fill: count ? stateFill(count) : "#eef2f7", stroke: isSel ? "#111" : "#9aa3ad", strokeWidth: isSel ? 1.6 : 0.9, outline:"none", cursor: code ? "pointer" : "default" },
                  pressed: { fill: stateFill(count), stroke:"#111", strokeWidth: 1.4, outline:"none" },
                }} />
            );
          })}
        </Geographies>
        {/* abbreviation + count badge on states that have storages (drawn on top) */}
        <Geographies geography={US_GEO_URL}>
          {({ geographies }) => geographies.map(geo => {
            const code = US_NAME_TO_CODE[geo.properties.name];
            const d = code ? stats[code] : null;
            if (!d) return null;
            const c = geoCentroid(geo);
            return (
              <Marker key={geo.rsmKey + "-m"} coordinates={c}>
                <g style={{ pointerEvents:"none" }}>
                  <text textAnchor="middle" y={2.5} style={{ fontWeight:700, fontSize:9, fill:"#3a3a3a" }}>{code}</text>
                  <g transform="translate(11,-7)">
                    {d.due > 0 && <circle r={9} fill="none" stroke="#E24B4A" strokeWidth={1.2} strokeDasharray="3 2" />}
                    <circle r={7} fill={stateDotColor(d.count)} stroke="#fff" strokeWidth={1} />
                    <text textAnchor="middle" y={2.6} style={{ fontSize:7.5, fontWeight:800, fill:"#fff" }}>{d.count}</text>
                  </g>
                </g>
              </Marker>
            );
          })}
        </Geographies>
      </ComposableMap>

      {/* legend */}
      <div style={{ display:"flex", gap:14, flexWrap:"wrap", fontSize:11, color:"#666", padding:"2px 4px 4px" }}>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:3, background:"#EAF3DE", border:"1px solid #cfe0b8" }} />1–2</span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:3, background:"#FAEEDA", border:"1px solid #ecd6ad" }} />3–5</span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:3, background:"#FCEBEB", border:"1px solid #f0cccc" }} />6+</span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:"50%", border:"1.5px dashed #E24B4A" }} />payment expiring soon</span>
        <span style={{ marginLeft:"auto", color:"#aaa" }}>Tap a state to filter the list</span>
      </div>

      {/* tooltip */}
      {tt && ts && (
        <div style={{ position:"absolute", left: tt.x, top: tt.y, transform:"translate(-50%, -100%)", marginTop:-10, background:"#111", color:"#fff", borderRadius:8, padding:"8px 11px", fontSize:11.5, lineHeight:1.5, pointerEvents:"none", whiteSpace:"nowrap", boxShadow:"0 6px 20px rgba(0,0,0,0.25)", zIndex:5 }}>
          <div style={{ fontWeight:700, marginBottom:2 }}>{US_CODE_TO_NAME[tt.code] || tt.code}</div>
          <div>{ts.count} storage{ts.count !== 1 ? "s" : ""} activo{ts.count !== 1 ? "s" : ""}</div>
          <div>{Math.round(ts.cf).toLocaleString()} CF en uso</div>
          {ts.due > 0
            ? <div style={{ color:"#FCA5A5", fontWeight:600 }}>⚠ {ts.due} payment{ts.due !== 1 ? "s" : ""} expiring soon (≤5 days)</div>
            : <div style={{ color:"#8fb98f" }}>No payments expiring soon</div>}
        </div>
      )}
    </div>
  );
}

// Diverging fill for storage margin: reds = losing money, greens = making money,
// neutral gray at ~zero. Steps scale to the largest |margin| on the map.
const MARGIN_NEG = ["#F6D5D5", "#EBA3A3", "#C64545"]; // light → dark red
const MARGIN_POS = ["#DCEBD2", "#A9CE8E", "#4E8A2E"]; // light → dark green
function marginFill(margin, maxAbs) {
  if (margin == null) return "#f5f5f5";
  const a = Math.abs(margin);
  if (maxAbs <= 0 || a < maxAbs * 0.02) return "#ececec"; // ~zero reads as "nothing"
  const idx = a >= maxAbs * 0.66 ? 2 : a >= maxAbs * 0.33 ? 1 : 0;
  return (margin < 0 ? MARGIN_NEG : MARGIN_POS)[idx];
}

// Margin choropleth for Analytics. stats: { CODE: { units, pay, income, margin, vacantCost } }.
export function UsMarginMap({ stats, selected, onSelect }) {
  const wrapRef = useRef();
  const [tt, setTt] = useState(null);
  const showTip = (code, e) => {
    const r = wrapRef.current?.getBoundingClientRect(); if (!r) return;
    setTt({ code, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const maxAbs = Math.max(1, ...Object.values(stats).map(s => Math.abs(s.margin || 0)));
  const ts = tt ? stats[tt.code] : null;
  const fmt = (v) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString();
  return (
    <div ref={wrapRef} style={{ position:"relative" }}>
      <ComposableMap projection="geoAlbersUsa" projectionConfig={{ scale: 1000 }} width={800} height={480} style={{ width:"100%", height:"auto" }}>
        <Geographies geography={US_GEO_URL}>
          {({ geographies }) => geographies.map(geo => {
            const code = US_NAME_TO_CODE[geo.properties.name];
            const d = code ? stats[code] : null;
            const isSel = code && selected === code;
            const fill = d ? marginFill(d.margin, maxAbs) : "#f5f5f5";
            return (
              <Geography key={geo.rsmKey} geography={geo}
                onMouseEnter={(e) => code && d && showTip(code, e)}
                onMouseMove={(e) => code && d && showTip(code, e)}
                onMouseLeave={() => setTt(null)}
                onClick={() => code && d && onSelect && onSelect(selected === code ? "" : code)}
                style={{
                  default: { fill, stroke: isSel ? "#111" : "#e0e0e0", strokeWidth: isSel ? 1.6 : 0.6, outline:"none", cursor: d ? "pointer" : "default" },
                  hover:   { fill: d ? fill : "#eef2f7", stroke: isSel ? "#111" : "#9aa3ad", strokeWidth: isSel ? 1.6 : 0.9, outline:"none", cursor: d ? "pointer" : "default" },
                  pressed: { fill, stroke:"#111", strokeWidth: 1.4, outline:"none" },
                }} />
            );
          })}
        </Geographies>
        <Geographies geography={US_GEO_URL}>
          {({ geographies }) => geographies.map(geo => {
            const code = US_NAME_TO_CODE[geo.properties.name];
            const d = code ? stats[code] : null;
            if (!d) return null;
            const c = geoCentroid(geo);
            return (
              <Marker key={geo.rsmKey + "-m"} coordinates={c}>
                <text textAnchor="middle" y={3} style={{ pointerEvents:"none", fontWeight:700, fontSize:9.5, fill:"#3a3a3a", paintOrder:"stroke", stroke:"#fff", strokeWidth:2 }}>{code}</text>
              </Marker>
            );
          })}
        </Geographies>
      </ComposableMap>

      <div style={{ display:"flex", gap:14, flexWrap:"wrap", fontSize:11, color:"#666", padding:"2px 4px 4px", alignItems:"center" }}>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:3, background:MARGIN_NEG[2] }} />pierde plata</span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:3, background:"#ececec" }} />~neutro</span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:11, height:11, borderRadius:3, background:MARGIN_POS[2] }} />gana plata</span>
        <span style={{ marginLeft:"auto", color:"#aaa" }}>Click en un estado para filtrar</span>
      </div>

      {tt && ts && (
        <div style={{ position:"absolute", left: tt.x, top: tt.y, transform:"translate(-50%, -100%)", marginTop:-10, background:"#111", color:"#fff", borderRadius:8, padding:"8px 11px", fontSize:11.5, lineHeight:1.5, pointerEvents:"none", whiteSpace:"nowrap", boxShadow:"0 6px 20px rgba(0,0,0,0.25)", zIndex:5 }}>
          <div style={{ fontWeight:700, marginBottom:2 }}>{US_CODE_TO_NAME[tt.code] || tt.code}</div>
          <div>{ts.units} unidad{ts.units !== 1 ? "es" : ""}</div>
          <div>Pagás {fmt(ts.pay)}/mes · Cobrás {fmt(ts.income)}/mes</div>
          <div style={{ fontWeight:700, color: ts.margin < 0 ? "#FCA5A5" : "#8fd08f" }}>Margen {fmt(ts.margin)}/mes</div>
          {ts.vacantCost > 0 && <div style={{ color:"#FCA5A5" }}>Vacantes: {fmt(ts.vacantCost)}/mes</div>}
        </div>
      )}
    </div>
  );
}
