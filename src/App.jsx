import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Reads from Vercel env vars when present (so the test/preview deployment can
// point to a separate test database), falling back to the production project.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://szkmktxziojzgfjkomua.supabase.co";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_v2VNtyiQ_tTAAmEWDdHwYg_IJ-_IN-5";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// One physical storage = one row in `storages`. Jobs that pass through a unit are
// tracked as history in `storage_jobs`. Multiple jobs can be active at once.
const STORAGE_JOBS_SQL = `create table if not exists public.storage_jobs (
  id bigint generated always as identity primary key,
  storage_id bigint references public.storages(id) on delete cascade,
  job_number text,
  customer text,
  driver text,
  date_in date,
  date_out date,
  notes text,
  created_at timestamptz default now()
);
alter table public.storage_jobs enable row level security;
create policy "storage_jobs_auth_all" on public.storage_jobs
  for all to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.storage_jobs;`;

const today = () => new Date().toISOString().slice(0, 10);

// A storage = a physical unit (fixed: company, location, unit, gate code, account).
// Jobs (customer, job number, driver, dates, notes) live in storage_jobs as history.
const EMPTY_FORM = {
  brand:"", state:"", zip:"", address:"", unit:"", size:"",
  gate_code:"", lock:"", email:"", account:"", phone:"", situation:"Open",
  monthly_cost:"", card_on_file:"", date_opened:"", payment_due_date:""
};

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
const STANDARD_SIZES = ["5x5","5x10","5x15","10x10","10x15","10x20","10x25","10x30","12x20","15x20","20x20"];

// A job can span several locations: one storage_jobs row per location (rented
// unit via storage_id, or company warehouse via `warehouse`), sharing job_number.
const WAREHOUSES = ["Indiana", "New Jersey"];
const EMPTY_BROKER = { name:"", contact_name:"", contact_phone:"", contact_email:"", notes:"" };
const EMPTY_DRIVER = { name:"", phone:"", whatsapp_group_link:"", truck_id:"", notes:"", active:true };
const EMPTY_CS = { closing_sheet_number:"", broker_id:"", driver_id:"", load_date:"", status:"open", charge_per_pad:"7", trip_cost:"", labor_charges:"", other_fees:"", other_fees_description:"", notes:"", document_url:"", job_keys:[] };
const CS_STATUS = {
  open:     { l:"Open", bg:"#E6F1FB", text:"#185FA5", dot:"#378ADD" },
  settled:  { l:"Settled", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  disputed: { l:"Disputed", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
};
function CSBadge({ status }) {
  const c = CS_STATUS[status] || CS_STATUS.open;
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />{c.l}</span>;
}
const PAY_METHODS = [
  { v:"cash", l:"Cash" },
  { v:"credit_card", l:"Credit card" },
  { v:"zelle", l:"Zelle" },
  { v:"venmo", l:"Venmo" },
  { v:"check", l:"Check" },
  { v:"money_order", l:"Money order" },
  { v:"paypal", l:"PayPal" },
  { v:"cashapp", l:"Cash App" },
  { v:"wire_transfer", l:"Wire transfer" },
  { v:"apple_pay", l:"Apple Pay" },
];
const payMethodLabel = (v) => v ? (PAY_METHODS.find(p => p.v === v)?.l || v) : "";
// Reusable payment-method <select>: always blank-default, optional, saves null when blank.
function PaymentMethodSelect({ value, onChange, style }) {
  return (
    <select style={style} value={value || ""} onChange={e => onChange(e.target.value || null)}>
      <option value="">— Select payment method —</option>
      {PAY_METHODS.map(pm => <option key={pm.v} value={pm.v}>{pm.l}</option>)}
    </select>
  );
}
const numv = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
// Collection status for a BOL job: complete / partial / pending.
function collectionStatus(j) {
  const bal = numv(j.bol_balance), col = numv(j.bol_collected);
  if (bal > 0 && col >= bal) return { key:"complete", l:"Cobrado", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" };
  if (col > 0) return { key:"partial", l:"Parcial", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" };
  return { key:"pending", l:"Pendiente", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" };
}
// Missing pads for a single job (received minus returned, floored at 0).
const jobPadsMissing = (j) => Math.max(0, numv(j.pads_received) - numv(j.pads_returned));
// All settlement math for a closing sheet given its (deduped-by-job) job rows.
// Pads are now tallied per job (received/returned), not from the sheet header.
function sheetCalc(sheet, jobsIn) {
  let carrierFee = 0, bolBalance = 0, bolCollected = 0, totalCf = 0, padsSent = 0, padsReturned = 0, padsMissing = 0;
  for (const j of jobsIn) {
    const cf = parseCf(j.volume);
    totalCf += cf;
    carrierFee += cf * numv(j.carrier_rate_per_cf);
    bolBalance += numv(j.bol_balance);
    bolCollected += numv(j.bol_collected);
    padsSent += numv(j.pads_received);
    padsReturned += numv(j.pads_returned);
    padsMissing += jobPadsMissing(j);
  }
  const padsCharge = padsMissing * (sheet?.charge_per_pad != null ? numv(sheet.charge_per_pad) : 7);
  const deductions = numv(sheet?.trip_cost) + numv(sheet?.labor_charges) + numv(sheet?.other_fees) + padsCharge;
  const netCarrier = carrierFee - deductions;       // what the broker owes us
  const pending = Math.max(0, bolBalance - bolCollected);
  const net = netCarrier - bolCollected;            // >0 broker owes us, <0 we owe broker
  return { carrierFee, bolBalance, bolCollected, totalCf, padsSent, padsReturned, padsMissing, padsCharge, deductions, netCarrier, pending, net, jobCount: jobsIn.length };
}
const EMPTY_JOB = { storage_ids:[], warehouses:[], driver_ids:[], job_number:"", customer:"", driver:"", date_in:"", fadd:"", volume:"", lot_number:"", sticker_color:"", job_type:"full", status:"scheduled", broker_id:"", rep:"", client_phone:"", client_email:"", pickup_balance:"", delivery_balance:"", price_per_cf:"", fuel_surcharge_pct:"", estimate:"", deposit:"", carrier_notes:"", extra_stops:"", pickup_date:"", pickup_date_from:"", pickup_date_to:"", pickup_address:"", pickup_city:"", pickup_state:"", pickup_zip:"", delivery_date:"", delivery_address:"", delivery_city:"", delivery_state:"", delivery_zip:"", billing_active:false, client_monthly_rate:"", first_month_free:false, billing_start_date:"", closing_sheet_id:"", carrier_rate_per_cf:"", bol_balance:"", bol_collected:"", bol_payment_method:"", bol_payment_notes:"", bol_collected_date:"", pads_received:"", pads_returned:"", notes:"" };

// Google Maps directions URL from the job's storage location to its delivery address.
const routeUrl = (g) => {
  const sp = g.parts.find(p => p.storage?.address);
  const origin = sp ? [sp.storage.address, sp.storage.state, sp.storage.zip].filter(Boolean).join(" ")
    : (g.parts.find(p => p.warehouse) ? `Warehouse ${g.parts.find(p => p.warehouse).warehouse}` : "");
  const dest = [g.delivery_address, g.delivery_state, g.delivery_zip].filter(Boolean).join(" ");
  if (!origin || !dest) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`;
};

// Audit trail: who created / last edited a record, and when (shown in light gray).
const fmtTs = (ts) => {
  if (!ts) return null;
  try { return new Date(ts).toLocaleString("es-AR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }); }
  catch { return ts; }
};
function AuditInfo({ rec }) {
  if (!rec || (!rec.created_by && !rec.updated_by && !rec.created_at)) return null;
  return (
    <div style={{ marginTop:14, paddingTop:10, borderTop:"1px solid #f5f5f5", fontSize:11, color:"#bbb", lineHeight:1.6 }}>
      {(rec.created_by || rec.created_at) && <div>Creado por {rec.created_by || "—"}{rec.created_at ? ` · ${fmtTs(rec.created_at)}` : ""}</div>}
      {(rec.updated_by || rec.updated_at) && <div>Última edición por {rec.updated_by || "—"}{rec.updated_at ? ` · ${fmtTs(rec.updated_at)}` : ""}</div>}
    </div>
  );
}

// Payment due dates. If payment_due_date isn't set, derive it from date_opened
// + 30 days, rolled forward in 30-day steps until it lands on/after today.
const ONE_DAY = 86400000;
const fmtDateLocal = (d) => d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` : null;
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const addDaysStr = (dateStr, n) => { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return fmtDateLocal(d); };
function paymentDueDate(r) {
  if (!r) return null;
  if (r.payment_due_date) return new Date(r.payment_due_date + "T00:00:00");
  if (!r.date_opened) return null;
  const d = new Date(r.date_opened + "T00:00:00");
  d.setDate(d.getDate() + 30);
  const today = startOfToday();
  while (d < today) d.setDate(d.getDate() + 30);
  return d;
}
function daysUntilDue(r) {
  const due = paymentDueDate(r);
  if (!due) return null;
  return Math.round((due - startOfToday()) / ONE_DAY);
}
// Red ≤5 days, yellow 6–10, green 11+; gray "—" when the unit is Closed or Empty.
function PaymentBadge({ record, situation }) {
  if (situation === "Close" || situation === "Empty") return <span style={{ color:"#bbb" }}>—</span>;
  const days = daysUntilDue(record);
  if (days === null) return <span style={{ color:"#bbb" }}>—</span>;
  const c = days <= 5 ? { bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" }
          : days <= 10 ? { bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" }
          : { bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" };
  const label = days < 0 ? "Vencido" : days === 0 ? "Hoy" : `${days} días`;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
      {label}
    </span>
  );
}

// FADD = First Available Delivery Date (per job). Drives dispatching urgency.
function daysUntilFadd(fadd) {
  if (!fadd) return null;
  return Math.round((new Date(fadd + "T00:00:00") - startOfToday()) / ONE_DAY);
}
function FaddBadge({ fadd }) {
  const days = daysUntilFadd(fadd);
  if (days === null) return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:"#f1f1f1", color:"#888", whiteSpace:"nowrap" }}>No FADD</span>;
  const c = days < 0 ? { bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" }
          : days <= 3 ? { bg:"#FDE3CF", text:"#C2410C", dot:"#EA580C" }
          : days <= 7 ? { bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" }
          : { bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" };
  const label = days < 0 ? "Overdue" : days === 0 ? "Hoy" : `${days} días`;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
      {label}
    </span>
  );
}

// Inline FADD: a "+ FADD" button when unset (quick date picker), or the badge
// (clickable to change) when set. Saves to all parts of the job.
function FaddCell({ group, onSet }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input type="date" autoFocus defaultValue={group.fadd || ""}
        onChange={e => { if (e.target.value) { onSet(group, e.target.value); setEditing(false); } }}
        onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
        style={{ fontSize:12, padding:"4px 6px", borderRadius:8, border:"1px solid #185FA5", outline:"none" }} />
    );
  }
  if (!group.fadd) {
    return (
      <button onClick={() => setEditing(true)}
        style={{ fontSize:11, fontWeight:600, padding:"3px 11px", borderRadius:20, border:"1px dashed #ccc", background:"#fff", color:"#888", cursor:"pointer", whiteSpace:"nowrap" }}>
        + FADD
      </button>
    );
  }
  return (
    <span onClick={() => setEditing(true)} style={{ cursor:"pointer" }} title="Cambiar FADD"><FaddBadge fadd={group.fadd} /></span>
  );
}

// Click-to-edit field used in the job detail. Date inputs commit on change
// (the native calendar steals focus); text/datalist inputs commit on blur/Enter.
function InlineField({ value, onSave, type = "text", listId, placeholder = "—", display, transform, mono }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || "");
  useEffect(() => { setVal(value || ""); }, [value]);
  if (!editing) {
    return (
      <span onClick={() => { setVal(value || ""); setEditing(true); }} title="Click para editar"
        style={{ cursor:"pointer", borderBottom:"1px dashed #ddd", paddingBottom:1, fontFamily: mono ? "monospace" : undefined }}>
        {display != null ? display : (value ? value : <span style={{ color:"#bbb" }}>{placeholder}</span>)}
      </span>
    );
  }
  const commit = () => { const v = (transform ? transform(val) : val) || ""; if (v !== (value || "")) onSave(v); setEditing(false); };
  if (type === "date") {
    return (
      <input type="date" autoFocus value={val}
        onChange={e => { onSave(e.target.value); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
        style={{ fontSize:13, padding:"4px 8px", borderRadius:8, border:"1px solid #185FA5", outline:"none" }} />
    );
  }
  return (
    <input autoFocus list={listId} value={val}
      onChange={e => setVal(transform ? transform(e.target.value) : e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
      style={{ fontSize:13, padding:"4px 8px", borderRadius:8, border:"1px solid #185FA5", outline:"none", width:"100%", fontFamily: mono ? "monospace" : undefined }} />
  );
}
function EditRow({ label, children }) {
  return (
    <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13, alignItems:"center" }}>
      <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>{label}</span>
      <span style={{ fontWeight:500, flex:1 }}>{children}</span>
    </div>
  );
}

// ── Dispatching CRM: job types, statuses, badges, status flow, WhatsApp ──
// New columns on storage_jobs for the Dispatching CRM. DDL can't run via the
// anon key, so the app probes for `status` and shows this SQL if it's missing.
const JOB_COLS_SQL = `alter table public.storage_jobs
  add column if not exists job_type text,
  add column if not exists status text default 'scheduled',
  add column if not exists pickup_date date,
  add column if not exists pickup_address text,
  add column if not exists pickup_city text,
  add column if not exists pickup_state text,
  add column if not exists pickup_zip text,
  add column if not exists delivery_date date,
  add column if not exists delivery_city text;`;
// brokers table + broker/balance columns on storage_jobs (CRM v2). The app probes
// the brokers table and the pickup_balance column; if missing it shows this SQL.
const CRM_V2_SQL = `create table if not exists public.brokers (
  id bigint generated always as identity primary key,
  name text,
  contact_name text,
  contact_phone text,
  contact_email text,
  notes text,
  created_at timestamptz default now()
);
alter table public.brokers enable row level security;
drop policy if exists "brokers_all" on public.brokers;
create policy "brokers_all" on public.brokers for all to anon, authenticated using (true) with check (true);

insert into public.brokers (name)
select v.name from (values
  ('Allied Van Lines'),('Atlas Van Lines'),('Mayflower'),('United Van Lines'),
  ('North American Van Lines'),('Wheaton'),('Arpin'),('Bekins'),('Direct (no broker)')
) as v(name)
where not exists (select 1 from public.brokers b where b.name = v.name);

alter table public.storage_jobs
  add column if not exists broker_id bigint references public.brokers(id),
  add column if not exists pickup_balance numeric,
  add column if not exists delivery_balance numeric;

do $$ begin
  alter publication supabase_realtime add table public.brokers;
exception when others then null; end $$;`;
// Storage occupancy + client storage billing (CRM v3). Probed via storage_billing
// table + storages.space_type + storage_jobs.billing_active.
const BILLING_SQL = `alter table public.storages
  add column if not exists space_type text,
  add column if not exists total_capacity_cf numeric;

alter table public.storage_jobs
  add column if not exists client_monthly_rate numeric,
  add column if not exists first_month_free boolean default false,
  add column if not exists billing_start_date date,
  add column if not exists billing_active boolean default false;

create table if not exists public.storage_billing (
  id bigint generated always as identity primary key,
  job_id bigint references public.storage_jobs(id) on delete cascade,
  billing_period_start date,
  billing_period_end date,
  amount numeric,
  status text default 'pending',
  paid_date date,
  notes text,
  created_at timestamptz default now()
);
alter table public.storage_billing enable row level security;
drop policy if exists "storage_billing_all" on public.storage_billing;
create policy "storage_billing_all" on public.storage_billing for all to anon, authenticated using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table public.storage_billing;
exception when others then null; end $$;`;

// CRM v3: extra job fields (rep, financials, contacts, multi-driver) + drivers table.
const CRM_V3_SQL = `alter table public.storage_jobs
  add column if not exists rep text,
  add column if not exists extra_stops text,
  add column if not exists price_per_cf numeric,
  add column if not exists fuel_surcharge_pct numeric,
  add column if not exists estimate numeric,
  add column if not exists deposit numeric,
  add column if not exists carrier_notes text,
  add column if not exists client_phone text,
  add column if not exists client_email text,
  add column if not exists driver_ids bigint[],
  add column if not exists pickup_date_from date,
  add column if not exists pickup_date_to date;

alter table public.storages add column if not exists payment_due_date date;

create table if not exists public.drivers (
  id bigint generated always as identity primary key,
  name text,
  phone text,
  whatsapp_group_link text,
  truck_id text,
  notes text,
  active boolean default true,
  created_at timestamptz default now()
);
alter table public.drivers enable row level security;
drop policy if exists "drivers_all" on public.drivers;
create policy "drivers_all" on public.drivers for all to anon, authenticated using (true) with check (true);

do $$ begin
  alter publication supabase_realtime add table public.drivers;
exception when others then null; end $$;`;

// Carrier Settlements: closing sheets + BOL collection fields + a public docs bucket.
const SETTLEMENTS_SQL = `create table if not exists public.closing_sheets (
  id bigint generated always as identity primary key,
  closing_sheet_number text,
  broker_id bigint references public.brokers(id),
  driver_id bigint references public.drivers(id),
  load_date date,
  status text default 'open',
  broker_payment_received boolean default false,
  broker_payment_date date,
  broker_payment_amount numeric,
  pads_sent integer default 0,
  pads_received integer default 0,
  charge_per_pad numeric default 7,
  trip_cost numeric default 0,
  labor_charges numeric default 0,
  other_fees numeric default 0,
  other_fees_description text,
  document_url text,
  notes text,
  created_at timestamptz default now()
);
alter table public.closing_sheets enable row level security;
drop policy if exists "closing_sheets_all" on public.closing_sheets;
create policy "closing_sheets_all" on public.closing_sheets for all to anon, authenticated using (true) with check (true);

alter table public.storage_jobs
  add column if not exists closing_sheet_id bigint references public.closing_sheets(id),
  add column if not exists carrier_rate_per_cf numeric,
  add column if not exists bol_balance numeric,
  add column if not exists bol_collected numeric default 0,
  add column if not exists bol_payment_method text,
  add column if not exists bol_payment_notes text,
  add column if not exists bol_collected_date date,
  add column if not exists pads_received integer default 0,
  add column if not exists pads_returned integer default 0;

insert into storage.buckets (id, name, public)
  values ('closing-sheet-docs', 'closing-sheet-docs', true)
  on conflict (id) do update set public = true;
drop policy if exists "csdocs_read" on storage.objects;
create policy "csdocs_read" on storage.objects for select to anon, authenticated using (bucket_id = 'closing-sheet-docs');
drop policy if exists "csdocs_write" on storage.objects;
create policy "csdocs_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'closing-sheet-docs');
drop policy if exists "csdocs_update" on storage.objects;
create policy "csdocs_update" on storage.objects for update to anon, authenticated using (bucket_id = 'closing-sheet-docs');

do $$ begin
  alter publication supabase_realtime add table public.closing_sheets;
exception when others then null; end $$;`;

// Cubic feet stored in a job: volume is free text ("1200 cu ft / 5 pallets"),
// so pull the first number for occupancy math.
const parseCf = (v) => { if (!v) return 0; const m = String(v).match(/[\d,.]+/); return m ? Number(m[0].replace(/,/g, "")) || 0 : 0; };
// Occupancy colors: green <70%, amber 70–90%, red >90%.
const occColor = (pct) => pct > 90 ? "#E24B4A" : pct >= 70 ? "#EF9F27" : "#639922";
function OccupancyBar({ used, total, height = 8 }) {
  if (!total || total <= 0) return null;
  const pct = Math.min(100, Math.round((used / total) * 100));
  return (
    <div style={{ minWidth:90 }}>
      <div style={{ background:"#f0f0f0", borderRadius:6, height, overflow:"hidden" }}>
        <div style={{ background:occColor(pct), height, width:`${pct}%`, transition:"width .4s" }} />
      </div>
      <div style={{ fontSize:10, color:"#888", marginTop:3, whiteSpace:"nowrap" }}>{pct}% · {Math.round(used).toLocaleString()}/{Math.round(total).toLocaleString()} CF</div>
    </div>
  );
}

const BILLING_STATUS = {
  pending: { l:"Pending", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" },
  overdue: { l:"Overdue", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
  paid:    { l:"Paid", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
};
function BillingBadge({ status }) {
  const c = BILLING_STATUS[status] || BILLING_STATUS.pending;
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />{c.l}</span>;
}
function billingReminderLink(b) {
  const txt = `Hi ${b.customer || "there"}, this is a reminder that your storage fee of $${Number(b.amount || 0).toLocaleString()} for job ${b.job_number || "-"} is due on ${b.billing_period_end || "-"}. Please contact us to arrange payment. Thank you - No Borders Moving`;
  return "https://wa.me/?text=" + encodeURIComponent(txt);
}
function settlementWaLink(sheet, calc, brokerName, driverName) {
  const m = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const netResult = calc.net >= 0 ? `Broker te debe ${m(calc.net)}` : `Le debés al broker ${m(-calc.net)}`;
  const txt = [
    `Closing Sheet #${sheet.closing_sheet_number || "-"} — ${brokerName || "-"}`,
    `Load date: ${sheet.load_date || "-"} | Driver: ${driverName || "-"}`,
    `Jobs: ${calc.jobCount} | Total CF: ${Math.round(calc.totalCf)}`,
    ``,
    `Carrier fee: ${m(calc.carrierFee)}`,
    `Deductions: -${m(calc.deductions)}`,
    `Net owed to us: ${m(calc.netCarrier)}`,
    ``,
    `BOL collected from clients: ${m(calc.bolCollected)}`,
    `Pending collections: ${m(calc.pending)}`,
    ``,
    `Settlement: ${netResult}`,
  ].join("\n");
  return "https://wa.me/?text=" + encodeURIComponent(txt);
}

const JOB_TYPES = [{ v:"full", l:"Full" }, { v:"direct", l:"Direct" }, { v:"broker_delivery", l:"Broker" }];
const jobTypeLabel = (v) => (JOB_TYPES.find(t => t.v === v)?.l) || "—";
const STATUSES = [
  { v:"scheduled", l:"Scheduled", bg:"#E6F1FB", text:"#185FA5", dot:"#378ADD" },        // blue
  { v:"picked_up", l:"Picked up", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" },         // amber
  { v:"in_storage", l:"In storage", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },        // green
  { v:"out_for_delivery", l:"Out for delivery", bg:"#EDE9FE", text:"#6D28D9", dot:"#7C3AED" }, // purple
  { v:"delivered", l:"Delivered", bg:"#f1f1f1", text:"#888", dot:"#bbb" },                // gray
  { v:"cancelled", l:"Cancelled", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },          // red
  { v:"on_hold", l:"On hold", bg:"#FEF9C3", text:"#854D0E", dot:"#FACC15" },              // yellow
  { v:"redispatched", l:"Redispatched", bg:"#FDE3CF", text:"#C2410C", dot:"#EA580C" },    // orange
];
const statusMeta = (v) => STATUSES.find(s => s.v === v) || STATUSES[0];
function StatusBadge({ status }) {
  const c = statusMeta(status || "scheduled");
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}><span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />{c.l}</span>;
}
function TypeBadge({ type }) {
  if (!type) return <span style={{ color:"#bbb" }}>—</span>;
  const colors = { full:{ bg:"#E6F1FB", text:"#185FA5" }, direct:{ bg:"#EAF3DE", text:"#3B6D11" }, broker_delivery:{ bg:"#FDE3CF", text:"#C2410C" } };
  const c = colors[type] || { bg:"#f1f1f1", text:"#888" };
  return <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:6, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>{jobTypeLabel(type)}</span>;
}
function nextStatus(g) {
  const s = g.status || "scheduled";
  if (s === "scheduled") return "picked_up";
  if (s === "picked_up") return g.job_type === "full" ? "in_storage" : "out_for_delivery";
  if (s === "in_storage") return "out_for_delivery";
  if (s === "out_for_delivery") return "delivered";
  return null;
}
const money = (v) => (v || v === 0) && !isNaN(Number(v)) ? `$${Number(v).toLocaleString()}` : null;

// ── Calendar helpers (Sunday-start) ──
function weekDays(anchorStr) {
  const d = new Date(anchorStr + "T00:00:00");
  const start = new Date(d); start.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(start); x.setDate(start.getDate() + i); return fmtDateLocal(x); });
}
function monthGrid(anchorStr) {
  const d = new Date(anchorStr + "T00:00:00");
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => { const x = new Date(gridStart); x.setDate(gridStart.getDate() + i); return { date: fmtDateLocal(x), inMonth: x.getMonth() === d.getMonth() }; });
}
function shiftDate(anchorStr, days) { const x = new Date(anchorStr + "T00:00:00"); x.setDate(x.getDate() + days); return fmtDateLocal(x); }
const MONTHS_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DOW_ES = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
function calEventColor(g) {
  const s = g.status || "scheduled";
  if (s === "cancelled") return { bg:"#FCEBEB", text:"#A32D2D", bar:"#E24B4A" };       // red
  if (s === "delivered") return { bg:"#E6F1FB", text:"#185FA5", bar:"#378ADD" };       // blue
  if (s === "on_hold" || s === "redispatched") return { bg:"#FEF9C3", text:"#854D0E", bar:"#FACC15" }; // yellow
  if (g.job_type === "full" && g.pickup_state && g.delivery_state && g.pickup_state !== g.delivery_state)
    return { bg:"#EDE9FE", text:"#6D28D9", bar:"#7C3AED" };                            // purple (long haul)
  return { bg:"#EAF3DE", text:"#3B6D11", bar:"#639922" };                              // green (active)
}
function waLink(g, storeLabel, brokerName, groupLink) {
  const pickup = [g.pickup_address, g.pickup_city, g.pickup_state, g.pickup_zip].filter(Boolean).join(", ");
  const delivery = [g.delivery_address, g.delivery_city, g.delivery_state].filter(Boolean).join(", ");
  const txt = [
    `Job: ${g.job_number || "-"}`,
    `Customer: ${g.customer || "-"} | Ph: ${g.client_phone || "-"}`,
    `Broker: ${brokerName || "-"} | Rep: ${g.rep || "-"}`,
    `Pick up: ${pickup || "-"}`,
    `Extra stops: ${g.extra_stops || "-"}`,
    `Delivery: ${delivery || "-"}`,
    `FADD: ${g.fadd || "-"}`,
    `Volume: ${g.volume || "-"} CF | Price/CF: ${money(g.price_per_cf) || "-"}`,
    `Sticker: ${g.sticker_color || "-"} - Lot ${g.lot_number || "-"}`,
    `Storage: ${storeLabel || "-"}`,
    `Due at pick up: ${money(g.pickup_balance) || "$0"}`,
    `Due at delivery: ${money(g.delivery_balance) || "$0"}`,
    `Carrier notes: ${g.carrier_notes || "-"}`,
  ].join("\n");
  // If we have the driver group's chat link, the message can't be auto-injected into a
  // group invite, so fall back to wa.me share which lets the dispatcher pick the group.
  return "https://wa.me/?text=" + encodeURIComponent(txt);
}

// Sticker color: stored as free text, with a color swatch for the known names.
const STICKER_COLORS = ["Rojo","Azul","Verde","Amarillo","Naranja","Rosa","Violeta","Blanco","Negro","Gris","Marrón"];
const COLOR_MAP = { rojo:"#e24b4a", red:"#e24b4a", azul:"#185FA5", blue:"#185FA5", verde:"#3B6D11", green:"#3B6D11", amarillo:"#EAB308", yellow:"#EAB308", naranja:"#EA7C27", orange:"#EA7C27", rosa:"#EC4899", pink:"#EC4899", violeta:"#7C3AED", purple:"#7C3AED", blanco:"#FFFFFF", white:"#FFFFFF", negro:"#111111", black:"#111111", gris:"#888888", gray:"#888888", "marrón":"#92400E", marron:"#92400E", brown:"#92400E" };
const colorHex = (name) => { if (!name) return null; const k = name.trim().toLowerCase(); return COLOR_MAP[k] || null; };

function Sticker({ color }) {
  if (!color) return <span>—</span>;
  const hex = colorHex(color);
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:6, whiteSpace:"nowrap" }}>
      <span style={{ width:12, height:12, borderRadius:"50%", flexShrink:0, background: hex || "#fff", border:"1px solid #ccc" }} />
      {color}
    </span>
  );
}

// Group key for a job: same job_number = same job (across locations). Blank number = standalone.
const jobKey = (j) => j.job_number && j.job_number.trim() ? `n:${j.job_number.trim().toLowerCase()}` : `id:${j.id}`;

const sitColor = {
  Open:  { bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  Close: { bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
  Empty: { bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" },
};

const Badge = ({ situation }) => {
  const c = sitColor[situation] || sitColor.Open;
  const label = situation === "Close" ? "Cerrado" : situation === "Empty" ? "Vacio" : "Activo";
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:500, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
      {label}
    </span>
  );
};

const CopyButton = ({ value }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      onClick={copy}
      title={copied ? "Copiado" : "Copiar gate code"}
      style={{ flexShrink:0, marginLeft:6, padding:0, width:18, height:18, lineHeight:"18px", border:"none", background:"none", cursor:"pointer", color:copied?"#16a34a":"#bbb", fontSize:11, opacity:0.8 }}
      onMouseEnter={e => e.currentTarget.style.opacity=1}
      onMouseLeave={e => e.currentTarget.style.opacity=0.8}>
      {copied ? "✓" : "⧉"}
    </button>
  );
};

const DetailRow = ({ label, value }) => {
  if (!value) return null;
  return (
    <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}>
      <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>{label}</span>
      <span style={{ fontWeight:500, wordBreak:"break-all" }}>{value}</span>
    </div>
  );
};

const SectionLabel = ({ children }) => (
  <div style={{ fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em", margin:"14px 0 6px" }}>{children}</div>
);

const Field = ({ label, children, full }) => (
  <div style={{ gridColumn: full ? "1/-1" : undefined, display:"flex", flexDirection:"column", gap:4 }}>
    <label style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</label>
    {children}
  </div>
);

// Collapsible titled section for the job form. Responsive grids stack on mobile.
function FormSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderTop:"1px solid #f0f0f0", marginTop:12, paddingTop:4 }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ width:"100%", display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", padding:"8px 0", textAlign:"left" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"#666", textTransform:"uppercase", letterSpacing:"0.07em" }}>{title}</span>
        <span style={{ flex:1 }} />
        <span style={{ color:"#bbb", fontSize:11, transform: open ? "rotate(90deg)" : "none", transition:"transform .15s" }}>▸</span>
      </button>
      {open && <div style={{ paddingBottom:6 }}>{children}</div>}
    </div>
  );
}
const fgrid = { display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:10 };

const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none" };

function Btn({ onClick, primary, danger, disabled, children, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ fontSize:13, fontWeight:500, padding:"8px 16px", borderRadius:8, border: danger ? "1px solid #fca5a5" : "1px solid #e5e5e5", background: primary ? "#111" : danger ? "#fef2f2" : "#fff", color: primary ? "#fff" : danger ? "#b91c1c" : "#111", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, display:"inline-flex", alignItems:"center", gap:6, ...style }}>
      {children}
    </button>
  );
}

function Modal({ title, onClose, children, footer }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:50, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:14, width:"100%", maxWidth:600, maxHeight:"90vh", overflowY:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.15)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"18px 20px 14px", borderBottom:"1px solid #f0f0f0" }}>
          <span style={{ fontWeight:600, fontSize:15 }}>{title}</span>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:"#aaa", lineHeight:1 }}>x</button>
        </div>
        <div style={{ padding:"16px 20px" }}>{children}</div>
        {footer && <div style={{ padding:"12px 20px 16px", borderTop:"1px solid #f0f0f0", display:"flex", justifyContent:"flex-end", gap:8 }}>{footer}</div>}
      </div>
    </div>
  );
}

function parsePastedMessages(text) {
  const blocks = text.split(/\n(?=Storage para:|storage para:)/i).filter(b => b.trim());
  if (!blocks.length) blocks.push(text);
  return blocks.map(block => {
    const get = (patterns) => { for (const p of patterns) { const m = block.match(p); if (m) return (m[1] || "").trim(); } return ""; };
    const driver = get([/storage para:\s*(.+)/i]);
    const brand = get([/^([A-Z][^\n]+(?:storage|store|smart|space|life|extra|haul)[^\n]*)/im]);
    const unit = get([/unit\s*(?:number|#)?[:\s]+([^\n]+)/i]);
    const address = get([/address[:\s]+([^\n]+)/i]);
    const state = (address.match(/,\s*([A-Z]{2})\s*\d{5}/) || [])[1] || "";
    const size = get([/size[:\s]+([^\n]+)/i]);
    const gate_code = get([/gate\s*code[:\s]+([^\n/]+)/i]);
    const lock = get([/use\s+([^\n]+?)\s+to\s+unlock/i]);
    const email = get([/email[:\s]+([^\n]+)/i]);
    const account = get([/account\s*#?[:\s]+([^\n]+)/i]);
    const rawDate = get([/date[:\s]+([^\n]+)/i]);
    let date_opened = "";
    if (rawDate) { const p = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (p) { const y = p[3].length === 2 ? "20" + p[3] : p[3]; date_opened = `${y}-${p[1].padStart(2,"0")}-${p[2].padStart(2,"0")}`; } }
    const jobLine = get([/jobs?[:\s]+(.+)/i]);
    const job_number = (jobLine.match(/([A-Z]{1,2}\d{6,})/i) || [])[1] || "";
    const notes = jobLine.replace(job_number, "").trim() || null;
    return { customer:null, driver, brand:brand||null, state, address:address||null, unit:unit||null, size:size||null, gate_code:gate_code||null, lock:lock||null, email:email||null, account:account||null, situation:"Open", monthly_cost:null, card_on_file:null, date_opened:date_opened||null, job_number:job_number||null, notes };
  }).filter(r => r.driver || r.unit || r.address);
}

function parseWhatsAppExport(rawText) {
  rawText = rawText.replace(/\u200e/g, "").replace(/\r/g, "");
  const lineRe = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s?[ap]?\.?m?\.?)\]?\s*-?\s*([^:]{1,60}?):\s*([\s\S]*)$/i;
  const lines = rawText.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (m) { if (current) entries.push(current); current = { date: m[1], sender: m[3].trim(), text: m[4] }; }
    else if (current) current.text += "\n" + line;
  }
  if (current) entries.push(current);
  const blocks = [];
  let block = null;
  const isNoise = t => /omitted|encrypted|created group|added you|changed the subject|security code|end-to-end/i.test(t);
  for (const e of entries) {
    if (isNoise(e.text)) continue;
    if (!block || block.sender !== e.sender) { if (block) blocks.push(block); block = { sender: e.sender, date: e.date, lines: [e.text] }; }
    else block.lines.push(e.text);
  }
  if (block) blocks.push(block);
  return blocks.filter(b => /storage|unit|gate code|address/i.test(b.lines.join("\n")))
    .map(b => parsePastedMessages(b.lines.join("\n"))[0] || null).filter(Boolean);
}

function AIPanel({ records }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function analyze() {
    setLoading(true); setResult(null);
    const active = records.filter(r => r.situation === "Open");
    const byState = active.reduce((acc,r)=>{ if(r.state) acc[r.state]=(acc[r.state]||0)+1; return acc; },{});
    const byBrand = active.reduce((acc,r)=>{ if(r.brand) acc[r.brand.trim()]=(acc[r.brand.trim()]||0)+1; return acc; },{});
    const withCost = active.filter(r=>r.monthly_cost);
    const totalCost = withCost.reduce((s,r)=>s+Number(r.monthly_cost),0);
    const noCost = active.length - withCost.length;
    const sameState = Object.entries(byState).filter(([,v])=>v>=3).map(([k,v])=>`${k}: ${v} storages`);
    const sameBrand = Object.entries(byBrand).filter(([,v])=>v>=3).map(([k,v])=>`${k}: ${v} unidades`);

    const prompt = `Sos un experto en operaciones de empresas de mudanzas en USA. Analiza estos datos de storages activos y dame 4-6 recomendaciones concretas y accionables para mejorar la eficiencia y reducir costos. Se especifico, directo y práctico.

DATOS:
- Total storages activos: ${active.length}
- Costo mensual total registrado: $${totalCost.toLocaleString()} (${noCost} storages sin costo cargado)
- Storages por estado: ${JSON.stringify(byState)}
- Storages por empresa: ${JSON.stringify(byBrand)}
- Estados con 3+ storages: ${sameState.join(", ") || "ninguno"}
- Empresas con 3+ unidades: ${sameBrand.join(", ") || "ninguna"}

Formato: lista numerada, cada recomendacion en 2-3 lineas max. Empieza directo con "1."`;

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      if (!res.ok) setResult(data.error || "No se pudo conectar con la IA.");
      else setResult(data.text || "No se pudo obtener respuesta.");
    } catch(e) {
      setResult("Error al conectar con la IA. Intenta de nuevo.");
    }
    setLoading(false);
  }

  return (
    <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom: result ? 16 : 0 }}>
        <div>
          <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Recomendaciones con IA</div>
          <div style={{ fontSize:12, color:"#bbb" }}>Analisis automatico de tu operacion de storages</div>
        </div>
        <button onClick={analyze} disabled={loading}
          style={{ fontSize:13, fontWeight:500, padding:"8px 16px", borderRadius:8, border:"1px solid #e5e5e5", background: loading ? "#f5f5f5" : "#111", color: loading ? "#aaa" : "#fff", cursor: loading ? "not-allowed" : "pointer", flexShrink:0, display:"flex", alignItems:"center", gap:6 }}>
          {loading ? "Analizando..." : "Analizar con IA"}
        </button>
      </div>
      {loading && (
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"20px 0", color:"#888", fontSize:13 }}>
          <div style={{ width:16, height:16, border:"2px solid #f0f0f0", borderTop:"2px solid #111", borderRadius:"50%", animation:"spin 0.8s linear infinite", flexShrink:0 }} />
          Analizando {records.filter(r=>r.situation==="Open").length} storages activos...
        </div>
      )}
      {result && (
        <div style={{ marginTop:16, padding:"16px", background:"#fafafa", borderRadius:10, fontSize:13, lineHeight:1.7, color:"#333", whiteSpace:"pre-wrap" }}>
          {result}
        </div>
      )}
    </div>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    setLoading(true); setError(null); setMessage(null);
    if (isSignUp) {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else setMessage("Cuenta creada. Revisa tu email para confirmar.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError("Email o contrasena incorrectos.");
    }
    setLoading(false);
  }

  const inp2 = { fontSize:14, padding:"10px 14px", borderRadius:8, border:"1px solid #e5e5e5", width:"100%", outline:"none", marginBottom:10, boxSizing:"border-box" };

  return (
    <div style={{ minHeight:"100vh", background:"#fafafa", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ background:"#fff", borderRadius:16, border:"1px solid #efefef", padding:"36px 32px", width:"100%", maxWidth:380, boxShadow:"0 4px 24px rgba(0,0,0,0.06)" }}>
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:11, fontWeight:600, color:"#aaa", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:4 }}>No Borders Moving and Storage</div>
          <h1 style={{ fontSize:22, fontWeight:700, margin:0, letterSpacing:"-0.02em" }}>Storage Manager</h1>
          <p style={{ fontSize:13, color:"#888", marginTop:6 }}>{isSignUp ? "Crea tu cuenta para acceder" : "Inicia sesion para continuar"}</p>
        </div>
        {error && <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#b91c1c", marginBottom:12 }}>{error}</div>}
        {message && <div style={{ background:"#f0fdf4", border:"1px solid #86efac", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#166534", marginBottom:12 }}>{message}</div>}
        <input style={inp2} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        <input style={{ ...inp2, marginBottom:16 }} type="password" placeholder="Contrasena" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        <button onClick={handleSubmit} disabled={loading || !email || !password}
          style={{ width:"100%", padding:"11px", borderRadius:8, border:"none", background:"#111", color:"#fff", fontSize:14, fontWeight:600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1, marginBottom:14 }}>
          {loading ? "Cargando..." : isSignUp ? "Crear cuenta" : "Iniciar sesion"}
        </button>
        <p style={{ textAlign:"center", fontSize:13, color:"#888", margin:0 }}>
          {isSignUp ? "Ya tenes cuenta? " : "No tenes cuenta? "}
          <span onClick={() => { setIsSignUp(!isSignUp); setError(null); setMessage(null); }} style={{ color:"#111", fontWeight:600, cursor:"pointer", textDecoration:"underline" }}>
            {isSignUp ? "Inicia sesion" : "Registrate"}
          </span>
        </p>
      </div>
    </div>
  );
}

const jobBadgeStyle = (delivered) => ({
  display:"inline-flex", alignItems:"center", gap:5, fontSize:10, fontWeight:600,
  padding:"2px 8px", borderRadius:20, flexShrink:0,
  background: delivered ? "#f1f1f1" : "#EAF3DE",
  color: delivered ? "#888" : "#3B6D11",
});

function JobCard({ job, onDeliver }) {
  const delivered = !!job.date_out;
  return (
    <div style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", background: delivered ? "#fafafa" : "#fff" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom: (job.customer||job.driver||job.notes) ? 6 : 0 }}>
        <span style={jobBadgeStyle(delivered)}>
          <span style={{ width:6, height:6, borderRadius:"50%", background: delivered ? "#bbb" : "#639922" }} />
          {delivered ? "Delivered" : "Active"}
        </span>
        <span style={{ fontFamily:"monospace", fontSize:12, fontWeight:600 }}>{job.job_number || "—"}</span>
        <span style={{ flex:1 }} />
        {!delivered && (
          <Btn onClick={() => onDeliver(job)} style={{ padding:"4px 10px", fontSize:12 }}>Marcar entregado</Btn>
        )}
      </div>
      <div style={{ fontSize:12, color:"#666", display:"flex", flexWrap:"wrap", gap:"2px 12px" }}>
        {job.customer && <span>Cliente: <strong style={{ color:"#333" }}>{job.customer}</strong></span>}
        {job.driver && <span>Driver: <strong style={{ color:"#333" }}>{job.driver}</strong></span>}
        {job.date_in && <span>In: {job.date_in}</span>}
        {job.date_out && <span>Out: {job.date_out}</span>}
      </div>
      {job.notes && <div style={{ fontSize:12, color:"#888", marginTop:4 }}>{job.notes}</div>}
    </div>
  );
}

function JobHistory({ storageId, jobs, dbReady, onSetup, onChange }) {
  const EMPTY = { job_number:"", customer:"", driver:"", date_in:"", notes:"" };
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [showDelivered, setShowDelivered] = useState(false);

  const active = jobs.filter(j => !j.date_out);
  const delivered = jobs.filter(j => j.date_out);

  async function addJob() {
    if (!form.job_number && !form.customer && !form.driver) { setErr("Completá al menos job, cliente o driver."); return; }
    setSaving(true); setErr(null);
    const payload = {
      storage_id: storageId,
      job_number: form.job_number || null,
      customer: form.customer || null,
      driver: form.driver || null,
      date_in: form.date_in || today(),
      notes: form.notes || null,
    };
    const { error } = await supabase.from("storage_jobs").insert([payload]);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setForm(EMPTY);
    onChange && onChange();
  }

  async function deliver(job) {
    const { error } = await supabase.from("storage_jobs").update({ date_out: today() }).eq("id", job.id);
    if (error) { setErr(error.message); return; }
    onChange && onChange();
  }

  if (!dbReady) {
    return (
      <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"12px 14px", fontSize:13, color:"#854F0B" }}>
        El historial de jobs necesita una configuración inicial de la base de datos.
        {onSetup && <button onClick={onSetup} style={{ marginLeft:8, background:"none", border:"none", color:"#854F0B", fontWeight:600, textDecoration:"underline", cursor:"pointer", fontSize:13 }}>Ver cómo activarlo</button>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:14 }}>
        {active.length === 0 && delivered.length === 0 && (
          <div style={{ fontSize:13, color:"#bbb", padding:"6px 0" }}>Todavía no hay jobs en esta unidad.</div>
        )}
        {active.map(j => <JobCard key={j.id} job={j} onDeliver={deliver} />)}

        {delivered.length > 0 && (
          <div>
            <button onClick={() => setShowDelivered(s => !s)}
              style={{ background:"none", border:"none", cursor:"pointer", color:"#888", fontSize:12, fontWeight:600, padding:"4px 0", display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ display:"inline-block", transform: showDelivered ? "rotate(90deg)" : "none", transition:"transform .15s" }}>▸</span>
              {delivered.length} entregado{delivered.length === 1 ? "" : "s"}
            </button>
            {showDelivered && (
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:8 }}>
                {delivered.map(j => <JobCard key={j.id} job={j} onDeliver={deliver} />)}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ background:"#fafafa", border:"1px solid #f0f0f0", borderRadius:10, padding:"12px" }}>
        <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Agregar job</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
          <Field label="Job #"><input style={inp} value={form.job_number} onChange={e => setForm(f => ({...f, job_number:e.target.value}))} placeholder="B8417142" /></Field>
          <Field label="Date in"><input style={inp} type="date" value={form.date_in} onChange={e => setForm(f => ({...f, date_in:e.target.value}))} /></Field>
          <Field label="Cliente"><input style={inp} value={form.customer} onChange={e => setForm(f => ({...f, customer:e.target.value}))} placeholder="Nombre del cliente" /></Field>
          <Field label="Driver"><input style={inp} value={form.driver} onChange={e => setForm(f => ({...f, driver:e.target.value}))} placeholder="Driver" /></Field>
          <Field label="Notas" full><input style={inp} value={form.notes} onChange={e => setForm(f => ({...f, notes:e.target.value}))} placeholder="Notas del job" /></Field>
        </div>
        {err && <div style={{ fontSize:12, color:"#b91c1c", marginTop:8 }}>{err}</div>}
        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
          <Btn primary disabled={saving} onClick={addJob}>{saving ? "Agregando..." : "+ Agregar job"}</Btn>
        </div>
      </div>
    </div>
  );
}

// Left navigation for the Operations CRM.
const NAV = [
  { section:"Operations", items:[
    { id:"dispatching", label:"Dispatching", icon:"🚚" },
    { id:"calendario", label:"Calendario", icon:"📅" },
    { id:"storage", label:"Storage", icon:"🏬" },
    { id:"jobs", label:"Jobs", icon:"💼" },
  ]},
  { section:"Finanzas", items:[
    { id:"brokers", label:"Brokers", icon:"🏦" },
    { id:"billing", label:"Billing", icon:"🧾" },
    { id:"settlements", label:"Settlements", icon:"📑" },
    { id:"clientes", label:"Clientes", icon:"👥" },
  ]},
  { section:"Fleet", items:[
    { id:"drivers", label:"Drivers", icon:"🪪" },
    { id:"trucks", label:"Trucks", icon:"🚛" },
  ]},
  { section:"Business", items:[
    { id:"analytics", label:"Analytics", icon:"📊" },
    { id:"settings", label:"Settings", icon:"⚙️" },
  ]},
];
function Sidebar({ page, setPage, onSignOut, badges = {} }) {
  return (
    <div style={{ width:220, flexShrink:0, background:"#fff", borderRight:"1px solid #efefef", display:"flex", flexDirection:"column", height:"100vh", position:"sticky", top:0, alignSelf:"flex-start" }}>
      <div style={{ padding:"18px 18px 14px", borderBottom:"1px solid #f3f3f3" }}>
        <div style={{ fontSize:15, fontWeight:700, letterSpacing:"-0.01em", lineHeight:1.2 }}>No Borders Moving</div>
        <div style={{ fontSize:10, color:"#aaa", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", marginTop:3 }}>Operations CRM</div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"10px" }}>
        {NAV.map(group => (
          <div key={group.section} style={{ marginBottom:12 }}>
            <div style={{ fontSize:10, fontWeight:600, color:"#bbb", textTransform:"uppercase", letterSpacing:"0.07em", padding:"6px 10px 4px" }}>{group.section}</div>
            {group.items.map(it => {
              const active = page === it.id;
              const badge = badges[it.id] || 0;
              return (
                <button key={it.id} onClick={() => setPage(it.id)}
                  style={{ width:"100%", display:"flex", alignItems:"center", gap:9, padding:"8px 10px", borderRadius:8, border:"none", cursor:"pointer", fontSize:13.5, fontWeight: active?600:500, textAlign:"left", marginBottom:2, background: active?"#111":"transparent", color: active?"#fff":"#444" }}>
                  <span style={{ fontSize:14 }}>{it.icon}</span>
                  <span style={{ flex:1 }}>{it.label}</span>
                  {badge > 0 && (
                    <span style={{ background: active?"#fff":"#E24B4A", color: active?"#111":"#fff", fontSize:10, fontWeight:700, borderRadius:10, padding:"1px 6px" }}>{badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ padding:"12px", borderTop:"1px solid #f3f3f3" }}>
        <button onClick={onSignOut} style={{ width:"100%", padding:"8px", borderRadius:8, border:"1px solid #eee", background:"#fff", color:"#888", fontSize:12, cursor:"pointer" }}>Salir</button>
      </div>
    </div>
  );
}

const PAGE_META = {
  dispatching: { title:"Dispatching", sub:"Despacho de pickups y deliveries" },
  calendario:  { title:"Calendario", sub:"Pick ups programados" },
  storage:     { title:"Storage", sub:"Unidades físicas y ocupación" },
  jobs:        { title:"Jobs", sub:"Todos los trabajos con detalle completo" },
  brokers:     { title:"Brokers", sub:"Brokers y balances pendientes" },
  billing:     { title:"Billing", sub:"Cobro de storage a clientes" },
  settlements: { title:"Carrier Settlements", sub:"Closing sheets de broker deliveries" },
  clientes:    { title:"Clientes", sub:"Clientes y sus trabajos" },
  drivers:     { title:"Drivers", sub:"Choferes de la operación" },
  trucks:      { title:"Trucks", sub:"Flota de camiones" },
  analytics:   { title:"Analytics", sub:"Métricas y recomendaciones con IA" },
  settings:    { title:"Settings", sub:"Configuración de la operación" },
};

export default function App() {
  const [session, setSession] = useState(undefined);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [liveIndicator, setLiveIndicator] = useState(false);
  const [page, setPage] = useState("dispatching");   // sidebar navigation
  const [tab, setTab] = useState("active");           // jobs page sub-tab: active/delivered/wh:*
  const [dispatchFilter, setDispatchFilter] = useState("all"); // all/pickups/deliveries/longhaul/nofadd
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState("");
  const [sortBy, setSortBy] = useState("date-desc");
  const [detailId, setDetailId] = useState(null);
  const [jobDetailKey, setJobDetailKey] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showAddJob, setShowAddJob] = useState(false);
  const [jobForm, setJobForm] = useState(EMPTY_JOB);
  const [jobSaving, setJobSaving] = useState(false);
  const [jobErr, setJobErr] = useState(null);
  const [editingJobKey, setEditingJobKey] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importTab, setImportTab] = useState("paste");
  const [pasteText, setPasteText] = useState("");
  const [pending, setPending] = useState([]);
  const [excluded, setExcluded] = useState({});
  const [zipStatus, setZipStatus] = useState("");
  const [zipName, setZipName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [dbReady, setDbReady] = useState(false);
  const [dbSetupNeeded, setDbSetupNeeded] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
  const [paymentColMissing, setPaymentColMissing] = useState(false);
  const [faddColMissing, setFaddColMissing] = useState(false);
  const [jobColsMissing, setJobColsMissing] = useState(false);
  const [crmV2Missing, setCrmV2Missing] = useState(false);
  const [billingMissing, setBillingMissing] = useState(false);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [billing, setBilling] = useState([]);
  const [storageTab, setStorageTab] = useState("storage_units");  // storage_units | <warehouse name>
  const [unitsSubTab, setUnitsSubTab] = useState("units");        // units | unit_jobs (inside Storage Units)
  const [billingTab, setBillingTab] = useState("all");       // all | pending | overdue | paid
  const [capTarget, setCapTarget] = useState(null);          // { kind, id?, name?, value }
  const [brokers, setBrokers] = useState([]);
  const [showBrokerModal, setShowBrokerModal] = useState(false);
  const [brokerForm, setBrokerForm] = useState(EMPTY_BROKER);
  const [editingBrokerId, setEditingBrokerId] = useState(null);
  const [brokerSaving, setBrokerSaving] = useState(false);
  // CRM v3: drivers table, calendar, clientes
  const [crmV3Missing, setCrmV3Missing] = useState(false);
  const [driversList, setDriversList] = useState([]);
  const [showDriverModal, setShowDriverModal] = useState(false);
  const [driverForm, setDriverForm] = useState(EMPTY_DRIVER);
  const [editingDriverId, setEditingDriverId] = useState(null);
  const [driverSaving, setDriverSaving] = useState(false);
  const [brokerDetailId, setBrokerDetailId] = useState(null);
  const [driverDetailId, setDriverDetailId] = useState(null);
  const [clientDetail, setClientDetail] = useState(null);
  // Carrier settlements
  const [settlementsMissing, setSettlementsMissing] = useState(false);
  const [closingSheets, setClosingSheets] = useState([]);
  const [csTab, setCsTab] = useState("open");          // open | settled | disputed | all
  const [csDetailId, setCsDetailId] = useState(null);  // open closing-sheet detail page
  const [showCsModal, setShowCsModal] = useState(false);
  const [csForm, setCsForm] = useState(EMPTY_CS);
  const [editingCsId, setEditingCsId] = useState(null);
  const [csSaving, setCsSaving] = useState(false);
  const [csJobSearch, setCsJobSearch] = useState("");
  const [payModal, setPayModal] = useState(null);      // { job, amount, method, date, notes, entries:[] }
  const [docUploading, setDocUploading] = useState(false);
  const [calView, setCalView] = useState("week");      // week | month
  const [calAnchor, setCalAnchor] = useState(today());  // ISO date inside the visible range
  const fileRef = useRef();
  const autoGenRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setSession(session));
    return () => subscription.unsubscribe();
  }, []);

  const loadData = useCallback(async () => {
    const { data, error } = await supabase.from("storages").select("*").order("date_opened", { ascending: false });
    if (error) { setError(error.message); setLoading(false); return; }
    setRecords(data || []);
    setLoading(false);
  }, []);

  const loadJobs = useCallback(async () => {
    const { data, error } = await supabase.from("storage_jobs").select("*").order("created_at", { ascending: false });
    if (!error) setJobs(data || []);
  }, []);

  const loadBrokers = useCallback(async () => {
    const { data, error } = await supabase.from("brokers").select("*").order("name", { ascending: true });
    if (!error) setBrokers(data || []);
  }, []);

  const loadBilling = useCallback(async () => {
    const { data, error } = await supabase.from("storage_billing").select("*").order("billing_period_end", { ascending: true });
    if (!error) { setBilling(data || []); setBillingLoaded(true); }
  }, []);

  const loadDrivers = useCallback(async () => {
    const { data, error } = await supabase.from("drivers").select("*").order("name", { ascending: true });
    if (!error) setDriversList(data || []);
  }, []);

  const loadClosingSheets = useCallback(async () => {
    const { data, error } = await supabase.from("closing_sheets").select("*").order("created_at", { ascending: false });
    if (!error) setClosingSheets(data || []);
  }, []);

  // Ensure storage_jobs exists. With a publishable (anon) key DDL isn't possible
  // via REST, so we probe the table and, if missing, best-effort create it through
  // an exec_sql-style RPC. If neither works, surface a one-time setup banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("id").limit(1);
      if (cancelled) return;
      if (!error) { setDbReady(true); setDbSetupNeeded(false); loadJobs(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: STORAGE_JOBS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { setDbReady(true); setDbSetupNeeded(false); loadJobs(); }
      else { setDbReady(false); setDbSetupNeeded(true); }
    })();
    return () => { cancelled = true; };
  }, [session, loadJobs]);

  useEffect(() => {
    if (!session || !dbReady) return;
    const channel = supabase.channel("storage-jobs-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storage_jobs" }, () => loadJobs())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, dbReady, loadJobs]);

  // Ensure the payment_due_date column exists; with the anon key DDL isn't
  // possible, so probe it and (if missing) try an exec_sql RPC, else flag a banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storages").select("payment_due_date").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storages add column if not exists payment_due_date date;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setPaymentColMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Same probe for the FADD column on storage_jobs.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("fadd").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: "alter table public.storage_jobs add column if not exists fadd date;" });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setFaddColMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Probe the Dispatching CRM columns (job_type, status, pickup_*/delivery_*) on
  // storage_jobs; if missing, try exec_sql, else surface the setup banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("status").limit(1);
      if (cancelled || !error) return;
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: JOB_COLS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (!cancelled && !created) setJobColsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session]);

  // Probe the brokers table + balance columns (CRM v2). If present, load brokers
  // and subscribe to realtime; otherwise surface the setup banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: bErr } = await supabase.from("brokers").select("id").limit(1);
      const { error: balErr } = await supabase.from("storage_jobs").select("pickup_balance").limit(1);
      if (cancelled) return;
      if (!bErr && !balErr) { loadBrokers(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: CRM_V2_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadBrokers();
      else setCrmV2Missing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadBrokers]);

  useEffect(() => {
    if (!session || crmV2Missing) return;
    const channel = supabase.channel("brokers-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "brokers" }, () => loadBrokers())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, crmV2Missing, loadBrokers]);

  // Probe the CRM v3 extras (drivers table + rep column on storage_jobs).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: dErr } = await supabase.from("drivers").select("id").limit(1);
      const { error: rErr } = await supabase.from("storage_jobs").select("rep, pickup_date_from").limit(1);
      if (cancelled) return;
      if (!dErr && !rErr) { loadDrivers(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: CRM_V3_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadDrivers();
      else setCrmV3Missing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadDrivers]);

  useEffect(() => {
    if (!session || crmV3Missing) return;
    const channel = supabase.channel("drivers-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "drivers" }, () => loadDrivers())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, crmV3Missing, loadDrivers]);

  // Probe the Carrier Settlements module (closing_sheets table + BOL columns).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: tErr } = await supabase.from("closing_sheets").select("id").limit(1);
      const { error: jErr } = await supabase.from("storage_jobs").select("bol_balance, pads_received").limit(1);
      if (cancelled) return;
      if (!tErr && !jErr) { loadClosingSheets(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: SETTLEMENTS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadClosingSheets();
      else setSettlementsMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadClosingSheets]);

  useEffect(() => {
    if (!session || settlementsMissing) return;
    const channel = supabase.channel("closing-sheets-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "closing_sheets" }, () => loadClosingSheets())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, settlementsMissing, loadClosingSheets]);

  // Probe the billing table + occupancy/billing columns (CRM v3).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error: tErr } = await supabase.from("storage_billing").select("id").limit(1);
      const { error: sErr } = await supabase.from("storages").select("space_type").limit(1);
      const { error: jErr } = await supabase.from("storage_jobs").select("billing_active").limit(1);
      if (cancelled) return;
      if (!tErr && !sErr && !jErr) { loadBilling(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: BILLING_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) loadBilling();
      else setBillingMissing(true);
    })();
    return () => { cancelled = true; };
  }, [session, loadBilling]);

  useEffect(() => {
    if (!session || billingMissing) return;
    const channel = supabase.channel("billing-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storage_billing" }, () => loadBilling())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, billingMissing, loadBilling]);

  // Auto-generate billing: one pending record per active billing-active job for the
  // current 30-day period, and flip past-due pending records to overdue. Idempotent
  // (dedupes by job + period); converges once realtime reloads with nothing to do.
  useEffect(() => {
    if (!session || billingMissing || !billingLoaded || autoGenRef.current) return;
    const td = today();
    const groups = new Map();
    for (const j of jobs) {
      if (j.date_out || j.status === "cancelled") continue;
      const k = jobKey(j);
      if (!groups.has(k)) groups.set(k, j);
    }
    const toInsert = [];
    for (const rep of groups.values()) {
      if (!rep.billing_active) continue;
      const rate = Number(rep.client_monthly_rate);
      if (!rate || isNaN(rate)) continue;
      const start = rep.billing_start_date || (rep.first_month_free ? (rep.date_in ? addDaysStr(rep.date_in, 30) : null) : rep.date_in);
      if (!start || start > td) continue;
      let periodStart = start;
      while (addDaysStr(periodStart, 30) <= td) periodStart = addDaysStr(periodStart, 30);
      const periodEnd = addDaysStr(periodStart, 30);
      if (!billing.some(b => b.job_id === rep.id && b.billing_period_start === periodStart))
        toInsert.push({ job_id: rep.id, billing_period_start: periodStart, billing_period_end: periodEnd, amount: rate, status: "pending" });
    }
    const toOverdue = billing.filter(b => b.status === "pending" && b.billing_period_end && b.billing_period_end < td).map(b => b.id);
    if (!toInsert.length && !toOverdue.length) return;
    autoGenRef.current = true;
    (async () => {
      if (toInsert.length) await supabase.from("storage_billing").insert(toInsert);
      if (toOverdue.length) await supabase.from("storage_billing").update({ status: "overdue" }).in("id", toOverdue);
      await loadBilling();
      autoGenRef.current = false;
    })();
  }, [session, billingMissing, billingLoaded, jobs, billing, loadBilling]);

  useEffect(() => {
    if (!session) return;
    loadData();
    const channel = supabase.channel("storages-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storages" }, (payload) => {
        setLiveIndicator(true);
        setTimeout(() => setLiveIndicator(false), 2000);
        if (payload.eventType === "INSERT") setRecords(r => [payload.new, ...r]);
        if (payload.eventType === "UPDATE") setRecords(r => r.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setRecords(r => r.filter(x => x.id !== payload.old.id));
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, loadData]);

  const storageById = useMemo(() => {
    const m = {};
    for (const r of records) m[r.id] = r;
    return m;
  }, [records]);

  const drivers = useMemo(() => [...new Set(jobs.map(j => j.driver).filter(Boolean))].sort(), [jobs]);
  const driverById = useMemo(() => { const m = {}; for (const d of driversList) m[d.id] = d; return m; }, [driversList]);
  // A job's driver names: prefer the drivers-table ids, fall back to the legacy text field.
  const jobDriverNames = useCallback((g) => {
    const ids = Array.isArray(g?.driver_ids) ? g.driver_ids : [];
    const names = ids.map(id => driverById[id]?.name).filter(Boolean);
    if (names.length) return names.join(", ");
    return g?.driver || "";
  }, [driverById]);
  const jobGroupLink = useCallback((g) => {
    const ids = Array.isArray(g?.driver_ids) ? g.driver_ids : [];
    for (const id of ids) { const l = driverById[id]?.whatsapp_group_link; if (l) return l; }
    return "";
  }, [driverById]);
  const brokerById = useMemo(() => { const m = {}; for (const b of brokers) m[b.id] = b; return m; }, [brokers]);
  const brokerName = useCallback((id) => (id && brokerById[id]?.name) || "", [brokerById]);
  const brands = useMemo(() => [...new Set(records.map(r => r.brand).filter(Boolean))].sort(), [records]);
  const sizes = useMemo(() => [...new Set([...STANDARD_SIZES, ...records.map(r => r.size).filter(Boolean)])], [records]);

  const activeJobsByStorage = useMemo(() => {
    const m = {};
    for (const j of jobs) if (!j.date_out && j.storage_id) m[j.storage_id] = (m[j.storage_id] || 0) + 1;
    return m;
  }, [jobs]);

  // CF currently stored per rented unit and per owned warehouse (active jobs only).
  const usedCfByStorage = useMemo(() => {
    const m = {};
    for (const j of jobs) if (!j.date_out && j.storage_id) m[j.storage_id] = (m[j.storage_id] || 0) + parseCf(j.volume);
    return m;
  }, [jobs]);
  const usedCfByWarehouse = useMemo(() => {
    const m = {};
    for (const j of jobs) if (!j.date_out && j.warehouse) m[j.warehouse] = (m[j.warehouse] || 0) + parseCf(j.volume);
    return m;
  }, [jobs]);
  // Warehouse capacity is held in a storages row (space_type='warehouse', brand=name).
  const warehouseMeta = useMemo(() => {
    const m = {};
    for (const r of records) if (r.space_type === "warehouse" && r.brand) m[r.brand] = r;
    return m;
  }, [records]);

  // Active jobs stored in rented units — one row per (job, unit) so you see what's
  // inside each unit. Filtered by the storage search box, sorted by company/unit.
  const unitJobRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs
      .filter(j => !j.date_out && j.storage_id)
      .map(j => ({ ...j, storage: storageById[j.storage_id] || null }))
      .filter(j => {
        if (!q) return true;
        const s = j.storage || {};
        const hay = [j.job_number, j.customer, j.driver, j.lot_number, j.sticker_color, s.brand, s.unit, s.address, s.state, s.zip].join(" ").toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const ab = (a.storage?.brand || "").localeCompare(b.storage?.brand || "");
        if (ab !== 0) return ab;
        return (a.storage?.unit || "").localeCompare(b.storage?.unit || "");
      });
  }, [jobs, storageById, search]);

  // Derived situation: Close is manual; otherwise Open if it has active jobs, else Empty.
  const sit = useCallback(
    (r) => r.situation === "Close" ? "Close" : ((activeJobsByStorage[r.id] || 0) > 0 ? "Open" : "Empty"),
    [activeJobsByStorage]
  );

  // Job-first view: jobs grouped by job number (a job may span several locations).
  // You search a job number and instantly see all the places WHERE it is.
  const jobGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const wh = tab.startsWith("wh:") ? tab.slice(3) : null;
    const parts = jobs
      .filter(j => {
        if (wh) return !j.date_out && j.warehouse === wh;          // active jobs in this warehouse
        if (tab === "delivered") return j.date_out;
        return !j.date_out;                                        // "active" (includes warehouse jobs)
      })
      .map(j => ({ ...j, storage: storageById[j.storage_id] || null }))
      .filter(j => {
        if (driverFilter && j.driver !== driverFilter) return false;
        if (q) {
          const s = j.storage || {};
          const hay = [j.job_number, j.customer, j.driver, j.notes, j.warehouse, j.lot_number, j.sticker_color, j.delivery_address, j.delivery_state, j.delivery_zip, s.brand, s.state, s.zip, s.address, s.unit, s.gate_code].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    const map = new Map();
    for (const p of parts) {
      const key = jobKey(p);
      if (!map.has(key)) map.set(key, { key, job_number:p.job_number, customer:p.customer, driver:p.driver, date_in:p.date_in, date_out:p.date_out, fadd:p.fadd, volume:p.volume, lot_number:p.lot_number, sticker_color:p.sticker_color, job_type:p.job_type, status:p.status, broker_id:p.broker_id, rep:p.rep, client_phone:p.client_phone, client_email:p.client_email, driver_ids:p.driver_ids, extra_stops:p.extra_stops, price_per_cf:p.price_per_cf, fuel_surcharge_pct:p.fuel_surcharge_pct, estimate:p.estimate, deposit:p.deposit, carrier_notes:p.carrier_notes, billing_active:p.billing_active, client_monthly_rate:p.client_monthly_rate, first_month_free:p.first_month_free, billing_start_date:p.billing_start_date, pickup_balance:p.pickup_balance, delivery_balance:p.delivery_balance, closing_sheet_id:p.closing_sheet_id, carrier_rate_per_cf:p.carrier_rate_per_cf, bol_balance:p.bol_balance, bol_collected:p.bol_collected, pads_received:p.pads_received, pads_returned:p.pads_returned, pickup_date:p.pickup_date, pickup_date_from:p.pickup_date_from, pickup_date_to:p.pickup_date_to, pickup_address:p.pickup_address, pickup_city:p.pickup_city, pickup_state:p.pickup_state, pickup_zip:p.pickup_zip, delivery_date:p.delivery_date, delivery_address:p.delivery_address, delivery_city:p.delivery_city, delivery_state:p.delivery_state, delivery_zip:p.delivery_zip, notes:p.notes, parts:[] });
      map.get(key).parts.push(p);
    }
    const arr = [...map.values()];
    if (tab === "dispatch") {
      // Most urgent FADD first; jobs with no FADD go to the bottom.
      arr.sort((a, b) => {
        const da = daysUntilFadd(a.fadd), db = daysUntilFadd(b.fadd);
        return (da === null ? Infinity : da) - (db === null ? Infinity : db);
      });
    } else {
      arr.sort((a, b) => {
        const ad = a.date_in || "", bd = b.date_in || "";
        if (sortBy === "date-asc") return ad > bd ? 1 : -1;
        if (sortBy === "customer") return (a.customer || "").localeCompare(b.customer || "");
        if (sortBy === "driver") return (a.driver || "").localeCompare(b.driver || "");
        return bd > ad ? 1 : -1;
      });
    }
    return arr;
  }, [jobs, storageById, tab, search, driverFilter, sortBy]);

  // Units view: manage the physical lockers themselves.
  const unitRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const data = records.filter(r => {
      if (r.space_type === "warehouse") return false;   // warehouses live in their own tab
      if (!q) return true;
      const hay = [r.brand, r.state, r.zip, r.address, r.unit, r.gate_code].join(" ").toLowerCase();
      return hay.includes(q);
    });
    data.sort((a, b) => {
      if (sortBy === "date-asc") return (a.date_opened || "") > (b.date_opened || "") ? 1 : -1;
      if (sortBy === "customer" || sortBy === "driver") return (a.brand || "").localeCompare(b.brand || "");
      return (b.date_opened || "") > (a.date_opened || "") ? 1 : -1;
    });
    return data;
  }, [records, search, sortBy]);

  const metrics = useMemo(() => {
    const activeParts = jobs.filter(j => !j.date_out);
    const deliveredParts = jobs.filter(j => j.date_out);
    const occupied = new Set(activeParts.map(j => j.storage_id));
    const withCost = records.filter(r => occupied.has(r.id) && r.monthly_cost && Number(r.monthly_cost) > 0);
    const totalCost = withCost.reduce((sum, r) => sum + Number(r.monthly_cost), 0);
    return {
      activeJobs: new Set(activeParts.map(jobKey)).size,
      deliveredJobs: new Set(deliveredParts.map(jobKey)).size,
      units: records.length,
      occupied: occupied.size,
      states: new Set(records.map(r => r.state).filter(Boolean)).size,
      totalCost,
    };
  }, [jobs, records]);

  // Payments coming due on active units (not Closed/Empty).
  const urgentPayments = useMemo(
    () => records.filter(r => sit(r) === "Open" && (() => { const d = daysUntilDue(r); return d !== null && d <= 5; })()).length,
    [records, sit]
  );
  const duePaymentsSoon = useMemo(
    () => records.filter(r => sit(r) === "Open" && (() => { const d = daysUntilDue(r); return d !== null && d <= 3; })())
      .map(r => ({ id:r.id, label: [r.brand, r.unit].filter(Boolean).join(" ") || r.address || `Unidad #${r.id}`, days: daysUntilDue(r) }))
      .sort((a, b) => a.days - b.days),
    [records, sit]
  );

  // FADD dispatching stats (distinct active jobs).
  const faddStats = useMemo(() => {
    const overdue = new Set(), dueWeek = new Set();
    for (const j of jobs) {
      if (j.date_out) continue;
      const d = daysUntilFadd(j.fadd);
      if (d === null) continue;
      if (d < 0) overdue.add(jobKey(j));
      else if (d <= 7) dueWeek.add(jobKey(j));
    }
    return { overdue: overdue.size, dueWeek: dueWeek.size };
  }, [jobs]);

  // Dispatching board: every non-delivered, non-cancelled job grouped by job
  // number, enriched with storage info, filtered by the active sub-tab + search.
  const dispatchGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const parts = jobs
      .filter(j => (!j.date_out && j.status !== "cancelled")
        || (j.job_type === "broker_delivery" && numv(j.bol_balance) > 0 && numv(j.bol_collected) < numv(j.bol_balance))) // keep broker deliveries with pending BOL visible
      .map(j => ({ ...j, storage: storageById[j.storage_id] || null }))
      .filter(j => {
        if (driverFilter && j.driver !== driverFilter) return false;
        if (q) {
          const s = j.storage || {};
          const hay = [j.job_number, j.customer, j.driver, j.notes, j.warehouse, j.lot_number, j.sticker_color,
            j.pickup_address, j.pickup_city, j.pickup_state, j.delivery_address, j.delivery_city, j.delivery_state, j.delivery_zip,
            s.brand, s.state, s.zip, s.address, s.unit].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    const map = new Map();
    for (const p of parts) {
      const key = jobKey(p);
      if (!map.has(key)) map.set(key, { key, job_number:p.job_number, customer:p.customer, driver:p.driver, date_in:p.date_in, fadd:p.fadd, volume:p.volume, lot_number:p.lot_number, sticker_color:p.sticker_color, job_type:p.job_type, status:p.status, broker_id:p.broker_id, rep:p.rep, client_phone:p.client_phone, client_email:p.client_email, driver_ids:p.driver_ids, extra_stops:p.extra_stops, price_per_cf:p.price_per_cf, fuel_surcharge_pct:p.fuel_surcharge_pct, estimate:p.estimate, deposit:p.deposit, carrier_notes:p.carrier_notes, billing_active:p.billing_active, client_monthly_rate:p.client_monthly_rate, first_month_free:p.first_month_free, billing_start_date:p.billing_start_date, pickup_balance:p.pickup_balance, delivery_balance:p.delivery_balance, closing_sheet_id:p.closing_sheet_id, carrier_rate_per_cf:p.carrier_rate_per_cf, bol_balance:p.bol_balance, bol_collected:p.bol_collected, pads_received:p.pads_received, pads_returned:p.pads_returned, pickup_date:p.pickup_date, pickup_date_from:p.pickup_date_from, pickup_date_to:p.pickup_date_to, pickup_address:p.pickup_address, pickup_city:p.pickup_city, pickup_state:p.pickup_state, pickup_zip:p.pickup_zip, delivery_date:p.delivery_date, delivery_address:p.delivery_address, delivery_city:p.delivery_city, delivery_state:p.delivery_state, delivery_zip:p.delivery_zip, notes:p.notes, parts:[] });
      map.get(key).parts.push(p);
    }
    let arr = [...map.values()];
    const td = today();
    if (dispatchFilter === "pickups_today") arr = arr.filter(g => { const f = g.pickup_date_from || g.pickup_date; return f && f <= td && td <= (g.pickup_date_to || f); });
    else if (dispatchFilter === "deliveries_today") arr = arr.filter(g => g.delivery_date === td);
    else if (dispatchFilter === "in_storage") arr = arr.filter(g => (g.status || "scheduled") === "in_storage");
    else if (dispatchFilter === "on_hold") arr = arr.filter(g => (g.status || "scheduled") === "on_hold");
    else if (dispatchFilter === "nofadd") arr = arr.filter(g => !g.fadd);
    // Most urgent FADD first; jobs with no FADD sink to the bottom.
    arr.sort((a, b) => {
      const da = daysUntilFadd(a.fadd), db = daysUntilFadd(b.fadd);
      return (da === null ? Infinity : da) - (db === null ? Infinity : db);
    });
    return arr;
  }, [jobs, storageById, search, driverFilter, dispatchFilter]);

  // Calendar: pickups grouped by job and indexed by date. A job with a date range
  // (pickup_date_from..pickup_date_to) is shown spanning every day in that range.
  const pickupEvents = useMemo(() => {
    const map = new Map();
    const byDate = {};
    for (const j of jobs) {
      const from = j.pickup_date_from || j.pickup_date;
      if (!from) continue;
      const k = jobKey(j);
      if (!map.has(k)) map.set(k, { key:k, job_number:j.job_number, customer:j.customer, status:j.status, job_type:j.job_type, driver:j.driver, driver_ids:j.driver_ids, pickup_date:j.pickup_date, pickup_date_from:from, pickup_date_to:(j.pickup_date_to || from), pickup_state:j.pickup_state, delivery_state:j.delivery_state });
    }
    for (const g of map.values()) {
      let d = g.pickup_date_from;
      const end = (g.pickup_date_to >= g.pickup_date_from) ? g.pickup_date_to : g.pickup_date_from;
      let guard = 0;
      while (d <= end && guard < 400) { (byDate[d] = byDate[d] || []).push(g); d = addDaysStr(d, 1); guard++; }
    }
    return byDate;
  }, [jobs]);

  // Top-bar metrics for the Dispatching page (distinct active jobs).
  const dispatchMetrics = useMemo(() => {
    const td = today();
    const pickups = new Set(), deliveries = new Set(), inStorage = new Set(), active = new Set(), seen = new Set();
    let puBal = 0, delBal = 0;
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    for (const j of jobs) {
      if (j.date_out || j.status === "cancelled") continue;
      const k = jobKey(j);
      active.add(k);
      { const f = j.pickup_date_from || j.pickup_date; if (f && f <= td && td <= (j.pickup_date_to || f)) pickups.add(k); }
      if (j.delivery_date === td) deliveries.add(k);
      if (j.status === "in_storage") inStorage.add(k);
      if (!seen.has(k)) {
        seen.add(k);
        if ((j.status || "scheduled") === "scheduled") puBal += num(j.pickup_balance); // pending until picked up
        delBal += num(j.delivery_balance); // pending until delivered
      }
    }
    return { pickups: pickups.size, deliveries: deliveries.size, inStorage: inStorage.size, active: active.size, puBal, delBal };
  }, [jobs]);

  // Dispatching alert banner: FADD overdue, or a pickup/delivery scheduled today
  // with no driver assigned. Grouped by job.
  const dispatchAlerts = useMemo(() => {
    const td = today();
    const map = new Map();
    for (const j of jobs) {
      if (j.date_out || j.status === "cancelled") continue;
      const d = daysUntilFadd(j.fadd);
      const overdue = d !== null && d < 0;
      const todayNoDriver = (j.pickup_date === td || j.delivery_date === td) && !j.driver;
      if (!overdue && !todayNoDriver) continue;
      const k = jobKey(j);
      if (!map.has(k)) map.set(k, { key:k, job_number:j.job_number, customer:j.customer, reason: overdue ? "FADD vencido" : "Sin driver para hoy" });
    }
    return [...map.values()];
  }, [jobs]);

  // Billing rows enriched with client/job/location info for the Billing table.
  const billingRows = useMemo(() => {
    const byId = {}; for (const j of jobs) byId[j.id] = j;
    return billing.map(b => {
      const j = byId[b.job_id];
      const s = j ? storageById[j.storage_id] : null;
      const loc = j && j.warehouse ? `Warehouse ${j.warehouse}`
        : (s ? [s.brand, s.unit && "U"+s.unit].filter(Boolean).join(" ") : "—");
      const dateIn = j?.date_in || null;
      const daysIn = dateIn ? Math.max(0, Math.round((startOfToday() - new Date(dateIn + "T00:00:00")) / ONE_DAY)) : null;
      return { ...b, customer: j?.customer || "—", job_number: j?.job_number || "—", location: loc, date_in: dateIn, daysIn };
    });
  }, [billing, jobs, storageById]);

  const billingMetrics = useMemo(() => {
    const td = today();
    const monthPrefix = td.slice(0, 7);
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    let pending = 0, overdueSum = 0, overdueCount = 0, weekSum = 0, weekCount = 0, collected = 0;
    for (const b of billing) {
      const amt = num(b.amount);
      if (b.status === "pending") {
        pending += amt;
        const d = b.billing_period_end ? Math.round((new Date(b.billing_period_end + "T00:00:00") - startOfToday()) / ONE_DAY) : null;
        if (d !== null && d >= 0 && d <= 7) { weekSum += amt; weekCount++; }
      } else if (b.status === "overdue") {
        pending += amt; overdueSum += amt; overdueCount++;
      } else if (b.status === "paid" && b.paid_date && b.paid_date.slice(0, 7) === monthPrefix) {
        collected += amt;
      }
    }
    return { pending, overdueSum, overdueCount, weekSum, weekCount, collected };
  }, [billing]);

  const billingOverdueCount = useMemo(() => billing.filter(b => b.status === "overdue").length, [billing]);

  // Clients derived from jobs, grouped by customer name.
  const clients = useMemo(() => {
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    const m = new Map();
    const seenJob = new Set();
    for (const j of jobs) {
      const name = (j.customer || "").trim();
      if (!name) continue;
      const k = name.toLowerCase();
      if (!m.has(k)) m.set(k, { name, phone:"", email:"", jobs:new Set(), active:new Set(), balance:0 });
      const c = m.get(k);
      if (j.client_phone && !c.phone) c.phone = j.client_phone;
      if (j.client_email && !c.email) c.email = j.client_email;
      const jk = jobKey(j);
      c.jobs.add(jk);
      if (!j.date_out && j.status !== "cancelled") c.active.add(jk);
      const bk = k + "|" + jk;
      if (!seenJob.has(bk)) { seenJob.add(bk); if (!j.date_out) c.balance += num(j.pickup_balance) + num(j.delivery_balance); }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [jobs]);

  // Sidebar alert badges.
  const sidebarBadges = useMemo(() => ({
    dispatching: faddStats.overdue,
    billing: billingOverdueCount,
    storage: urgentPayments,
  }), [faddStats.overdue, billingOverdueCount, urgentPayments]);

  // ── Carrier settlements derived data ──
  const sheetById = useMemo(() => { const m = {}; for (const s of closingSheets) m[s.id] = s; return m; }, [closingSheets]);
  // Distinct-by-job storage_jobs rows assigned to each closing sheet.
  const jobsBySheet = useMemo(() => {
    const m = {};
    const seen = new Set();
    for (const j of jobs) {
      if (!j.closing_sheet_id) continue;
      const k = j.closing_sheet_id + "|" + jobKey(j);
      if (seen.has(k)) continue; seen.add(k);
      (m[j.closing_sheet_id] = m[j.closing_sheet_id] || []).push(j);
    }
    return m;
  }, [jobs]);
  const sheetCalcById = useMemo(() => {
    const m = {};
    for (const s of closingSheets) m[s.id] = sheetCalc(s, jobsBySheet[s.id] || []);
    return m;
  }, [closingSheets, jobsBySheet]);
  const settlementMetrics = useMemo(() => {
    let openCount = 0, owesUs = 0, weOwe = 0, pendingBol = 0, padsValue = 0;
    for (const s of closingSheets) {
      const c = sheetCalcById[s.id] || {};
      if (s.status === "open") { openCount++; pendingBol += c.pending || 0; padsValue += c.padsCharge || 0; }
      if (s.status !== "settled") { if ((c.net || 0) > 0) owesUs += c.net; else weOwe += -(c.net || 0); }
    }
    return { openCount, owesUs, weOwe, pendingBol, padsValue };
  }, [closingSheets, sheetCalcById]);
  // Per-broker settlement rollup (non-settled sheets).
  const brokerSettleStats = useMemo(() => {
    const m = {};
    for (const s of closingSheets) {
      const c = sheetCalcById[s.id] || {};
      if (!s.broker_id) continue;
      if (!m[s.broker_id]) m[s.broker_id] = { open:0, owesUs:0, weOwe:0 };
      if (s.status === "open") m[s.broker_id].open++;
      if (s.status !== "settled") { if ((c.net||0) > 0) m[s.broker_id].owesUs += c.net; else m[s.broker_id].weOwe += -(c.net||0); }
    }
    return m;
  }, [closingSheets, sheetCalcById]);

  const sidebarBadgesPlus = useMemo(() => ({ ...sidebarBadges, settlements: settlementMetrics.openCount || 0 }), [sidebarBadges, settlementMetrics.openCount]);

  const detail = records.find(r => r.id === detailId);

  // All parts (units) of the job currently open in the job-detail modal.
  const jobDetail = useMemo(() => {
    if (!jobDetailKey) return null;
    const parts = jobs.filter(j => jobKey(j) === jobDetailKey).map(j => ({ ...j, storage: storageById[j.storage_id] || null }));
    if (!parts.length) return null;
    const f = parts[0];
    return { key:jobDetailKey, job_number:f.job_number, customer:f.customer, driver:f.driver, driver_ids:f.driver_ids, date_in:f.date_in, fadd:f.fadd, volume:f.volume, lot_number:f.lot_number, sticker_color:f.sticker_color, job_type:f.job_type, status:f.status, broker_id:f.broker_id, rep:f.rep, client_phone:f.client_phone, client_email:f.client_email, extra_stops:f.extra_stops, price_per_cf:f.price_per_cf, fuel_surcharge_pct:f.fuel_surcharge_pct, estimate:f.estimate, deposit:f.deposit, carrier_notes:f.carrier_notes, closing_sheet_id:f.closing_sheet_id, carrier_rate_per_cf:f.carrier_rate_per_cf, bol_balance:f.bol_balance, bol_collected:f.bol_collected, bol_payment_method:f.bol_payment_method, bol_payment_notes:f.bol_payment_notes, bol_collected_date:f.bol_collected_date, pads_received:f.pads_received, pads_returned:f.pads_returned, pickup_balance:f.pickup_balance, delivery_balance:f.delivery_balance, pickup_date:f.pickup_date, pickup_date_from:f.pickup_date_from, pickup_date_to:f.pickup_date_to, pickup_address:f.pickup_address, pickup_city:f.pickup_city, pickup_state:f.pickup_state, pickup_zip:f.pickup_zip, delivery_date:f.delivery_date, delivery_address:f.delivery_address, delivery_city:f.delivery_city, delivery_state:f.delivery_state, delivery_zip:f.delivery_zip, billing_active:f.billing_active, client_monthly_rate:f.client_monthly_rate, first_month_free:f.first_month_free, billing_start_date:f.billing_start_date, notes:f.notes, created_by:f.created_by, created_at:f.created_at, updated_by:f.updated_by, updated_at:f.updated_at, parts };
  }, [jobDetailKey, jobs, storageById]);

  const userEmail = session?.user?.email || null;

  function openAdd() { setForm(EMPTY_FORM); setEditId(null); setShowAdd(true); }
  function openEdit(r) {
    setForm({ brand:r.brand||"", state:r.state||"", zip:r.zip||"", address:r.address||"", unit:r.unit||"", size:r.size||"", gate_code:r.gate_code||"", lock:r.lock||"", email:r.email||"", account:r.account||"", phone:r.phone||"", situation:r.situation==="Close"?"Close":"Open", monthly_cost:r.monthly_cost||"", card_on_file:r.card_on_file||"", date_opened:r.date_opened||"", payment_due_date:r.payment_due_date||"" });
    setEditId(r.id); setShowAdd(true);
  }

  async function saveForm() {
    setSaving(true);
    const payload = { brand:form.brand||null, state:form.state||null, zip:form.zip||null, address:form.address||null, unit:form.unit||null, size:form.size||null, gate_code:form.gate_code||null, lock:form.lock||null, email:form.email||null, account:form.account||null, phone:form.phone||null, situation:form.situation, monthly_cost:form.monthly_cost ? parseFloat(form.monthly_cost) : null, card_on_file:form.card_on_file||null, date_opened:form.date_opened||null };
    // Auto-set payment due date (date_opened + 30) when empty — only if the column exists.
    if (!paymentColMissing) payload.payment_due_date = form.payment_due_date || (form.date_opened ? addDaysStr(form.date_opened, 30) : null);
    if (editId) { await supabase.from("storages").update({ ...payload, updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", editId); }
    else { await supabase.from("storages").insert([{ ...payload, created_by: userEmail }]); }
    setSaving(false); setShowAdd(false);
  }

  function openAddJob(storageId) { setEditingJobKey(null); setJobForm({ ...EMPTY_JOB, storage_ids: storageId ? [storageId] : [] }); setJobErr(null); setShowAddJob(true); }
  function openAddJobWarehouse(name) { setEditingJobKey(null); setJobForm({ ...EMPTY_JOB, warehouses: [name] }); setJobErr(null); setShowAddJob(true); }
  function openAddJobDate(dateStr) { setEditingJobKey(null); setJobForm({ ...EMPTY_JOB, pickup_date: dateStr, pickup_date_from: dateStr }); setJobErr(null); setShowAddJob(true); }
  function openEditJob(jd) {
    setEditingJobKey(jd.key);
    setJobForm({
      storage_ids: [...new Set(jd.parts.filter(p => p.storage_id).map(p => p.storage_id))],
      warehouses: [...new Set(jd.parts.filter(p => p.warehouse).map(p => p.warehouse))],
      driver_ids: Array.isArray(jd.driver_ids) ? jd.driver_ids : [],
      job_number: jd.job_number || "", customer: jd.customer || "", driver: jd.driver || "",
      date_in: jd.date_in || "", fadd: jd.fadd || "", volume: jd.volume || "", lot_number: jd.lot_number || "",
      sticker_color: jd.sticker_color || "",
      job_type: jd.job_type || "full", status: jd.status || "scheduled",
      broker_id: jd.broker_id || "", rep: jd.rep || "", client_phone: jd.client_phone || "", client_email: jd.client_email || "",
      extra_stops: jd.extra_stops || "", price_per_cf: jd.price_per_cf ?? "", fuel_surcharge_pct: jd.fuel_surcharge_pct ?? "", estimate: jd.estimate ?? "", deposit: jd.deposit ?? "",
      carrier_notes: jd.carrier_notes || "",
      pickup_balance: jd.pickup_balance ?? "", delivery_balance: jd.delivery_balance ?? "",
      pickup_date: jd.pickup_date || "", pickup_date_from: jd.pickup_date_from || jd.pickup_date || "", pickup_date_to: jd.pickup_date_to || "", pickup_address: jd.pickup_address || "", pickup_city: jd.pickup_city || "", pickup_state: jd.pickup_state || "", pickup_zip: jd.pickup_zip || "",
      delivery_date: jd.delivery_date || "", delivery_address: jd.delivery_address || "", delivery_city: jd.delivery_city || "", delivery_state: jd.delivery_state || "", delivery_zip: jd.delivery_zip || "",
      billing_active: !!jd.billing_active, client_monthly_rate: jd.client_monthly_rate ?? "", first_month_free: !!jd.first_month_free, billing_start_date: jd.billing_start_date || "",
      closing_sheet_id: jd.closing_sheet_id ?? "", carrier_rate_per_cf: jd.carrier_rate_per_cf ?? "", bol_balance: jd.bol_balance ?? "", bol_collected: jd.bol_collected ?? "", bol_payment_method: jd.bol_payment_method || "", bol_payment_notes: jd.bol_payment_notes || "", bol_collected_date: jd.bol_collected_date || "", pads_received: jd.pads_received ?? "", pads_returned: jd.pads_returned ?? "",
      notes: jd.notes || "",
    });
    setJobErr(null); setJobDetailKey(null); setShowAddJob(true);
  }
  function toggleJobUnit(id) {
    setJobForm(f => ({ ...f, storage_ids: f.storage_ids.includes(id) ? f.storage_ids.filter(x => x !== id) : [...f.storage_ids, id] }));
  }
  function toggleJobWarehouse(name) {
    setJobForm(f => ({ ...f, warehouses: f.warehouses.includes(name) ? f.warehouses.filter(x => x !== name) : [...f.warehouses, name] }));
  }
  async function saveJob() {
    // Storage is optional — a job can be saved with no unit/warehouse (storage_id null).
    if (!jobForm.job_number && !jobForm.customer && !jobForm.driver) { setJobErr("Completá al menos job, cliente o driver."); return; }
    setJobSaving(true); setJobErr(null);
    const fields = {
      job_number: jobForm.job_number || null,
      customer: jobForm.customer || null,
      driver: jobForm.driver || null,
      date_in: jobForm.date_in || today(),
      volume: jobForm.volume || null,
      lot_number: jobForm.lot_number || null,
      sticker_color: jobForm.sticker_color || null,
      delivery_address: jobForm.delivery_address || null,
      delivery_state: jobForm.delivery_state || null,
      delivery_zip: jobForm.delivery_zip || null,
      notes: jobForm.notes || null,
    };
    if (!faddColMissing) fields.fadd = jobForm.fadd || null;
    if (!jobColsMissing) {
      fields.job_type = jobForm.job_type || null;
      fields.status = jobForm.status || "scheduled";
      // Keep the legacy single pickup_date in sync with the range's start.
      fields.pickup_date = jobForm.pickup_date_from || jobForm.pickup_date || null;
      fields.pickup_address = jobForm.pickup_address || null;
      fields.pickup_city = jobForm.pickup_city || null;
      fields.pickup_state = jobForm.pickup_state || null;
      fields.pickup_zip = jobForm.pickup_zip || null;
      fields.delivery_date = jobForm.delivery_date || null;
      fields.delivery_city = jobForm.delivery_city || null;
    }
    if (!crmV2Missing) {
      fields.broker_id = jobForm.broker_id ? Number(jobForm.broker_id) : null;
      fields.pickup_balance = jobForm.pickup_balance !== "" ? Number(jobForm.pickup_balance) : null;
      fields.delivery_balance = jobForm.delivery_balance !== "" ? Number(jobForm.delivery_balance) : null;
    }
    if (!billingMissing) {
      fields.billing_active = !!jobForm.billing_active;
      fields.client_monthly_rate = jobForm.client_monthly_rate !== "" ? Number(jobForm.client_monthly_rate) : null;
      fields.first_month_free = !!jobForm.first_month_free;
      // Auto-calc billing start: first_month_free → date_in + 30, else date_in. Editable.
      const di = jobForm.date_in || today();
      fields.billing_start_date = jobForm.billing_start_date || (jobForm.first_month_free ? addDaysStr(di, 30) : di);
    }
    if (!crmV3Missing) {
      fields.rep = jobForm.rep || null;
      fields.client_phone = jobForm.client_phone || null;
      fields.client_email = jobForm.client_email || null;
      fields.extra_stops = jobForm.extra_stops || null;
      fields.carrier_notes = jobForm.carrier_notes || null;
      fields.price_per_cf = jobForm.price_per_cf !== "" ? Number(jobForm.price_per_cf) : null;
      fields.fuel_surcharge_pct = jobForm.fuel_surcharge_pct !== "" ? Number(jobForm.fuel_surcharge_pct) : null;
      fields.estimate = jobForm.estimate !== "" ? Number(jobForm.estimate) : null;
      fields.deposit = jobForm.deposit !== "" ? Number(jobForm.deposit) : null;
      fields.pickup_date_from = jobForm.pickup_date_from || null;
      fields.pickup_date_to = jobForm.pickup_date_to || null;
      const ids = Array.isArray(jobForm.driver_ids) ? jobForm.driver_ids.map(Number) : [];
      fields.driver_ids = ids;
      // Mirror driver names into the legacy text field for display/search/back-compat.
      const names = ids.map(id => driversList.find(d => d.id === id)?.name).filter(Boolean);
      if (names.length) fields.driver = names.join(", ");
    }
    if (!settlementsMissing) {
      // Resolve the closing sheet link: "__new__" creates a fresh open sheet for this broker.
      let csId = null;
      if (jobForm.closing_sheet_id === "__new__") {
        const { data } = await supabase.from("closing_sheets").insert([{ broker_id: jobForm.broker_id ? Number(jobForm.broker_id) : null, load_date: today(), status: "open" }]).select("id").single();
        csId = data?.id || null;
      } else if (jobForm.closing_sheet_id !== "" && jobForm.closing_sheet_id != null) {
        csId = Number(jobForm.closing_sheet_id);
      }
      fields.closing_sheet_id = csId;
      fields.carrier_rate_per_cf = jobForm.carrier_rate_per_cf !== "" ? Number(jobForm.carrier_rate_per_cf) : null;
      fields.bol_balance = jobForm.bol_balance !== "" ? Number(jobForm.bol_balance) : null;
      fields.bol_collected = jobForm.bol_collected !== "" ? Number(jobForm.bol_collected) : 0;
      fields.bol_payment_method = jobForm.bol_payment_method || null;
      fields.bol_payment_notes = jobForm.bol_payment_notes || null;
      fields.bol_collected_date = jobForm.bol_collected_date || null;
      fields.pads_received = jobForm.pads_received !== "" ? parseInt(jobForm.pads_received) : 0;
      fields.pads_returned = jobForm.pads_returned !== "" ? parseInt(jobForm.pads_returned) : 0;
    }

    const hasLoc = jobForm.storage_ids.length > 0 || jobForm.warehouses.length > 0;
    if (editingJobKey) {
      const current = jobs.filter(j => jobKey(j) === editingJobKey);
      const created = { ...fields, created_by: userEmail };
      let error = null;
      // Update job-level fields on every existing part first.
      if (current.length) ({ error } = await supabase.from("storage_jobs").update({ ...fields, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", current.map(p => p.id)));
      if (!error) {
        if (!hasLoc) {
          // No storage selected: collapse the job to a single unassigned row.
          if (current.length) {
            await supabase.from("storage_jobs").update({ storage_id: null, warehouse: null }).eq("id", current[0].id);
            const rest = current.slice(1).map(p => p.id);
            if (rest.length) ({ error } = await supabase.from("storage_jobs").delete().in("id", rest));
          } else {
            ({ error } = await supabase.from("storage_jobs").insert([{ ...created, storage_id: null, warehouse: null }]));
          }
        } else {
          // Reconcile selected units/warehouses against existing parts.
          const desiredUnits = new Set(jobForm.storage_ids);
          const desiredWhs = new Set(jobForm.warehouses);
          const toDelete = [], keptUnits = new Set(), keptWhs = new Set();
          for (const p of current) {
            if (p.storage_id) { desiredUnits.has(p.storage_id) ? keptUnits.add(p.storage_id) : toDelete.push(p.id); }
            else if (p.warehouse) { desiredWhs.has(p.warehouse) ? keptWhs.add(p.warehouse) : toDelete.push(p.id); }
            else toDelete.push(p.id); // drop a prior unassigned placeholder now that real locations exist
          }
          const newRows = [
            ...jobForm.storage_ids.filter(id => !keptUnits.has(id)).map(sid => ({ ...created, storage_id: sid, warehouse: null })),
            ...jobForm.warehouses.filter(w => !keptWhs.has(w)).map(w => ({ ...created, storage_id: null, warehouse: w })),
          ];
          if (toDelete.length) ({ error } = await supabase.from("storage_jobs").delete().in("id", toDelete));
          if (!error && newRows.length) ({ error } = await supabase.from("storage_jobs").insert(newRows));
        }
      }
      setJobSaving(false);
      if (error) { setJobErr(error.message); return; }
    } else {
      const created = { ...fields, created_by: userEmail };
      const rows = hasLoc ? [
        ...jobForm.storage_ids.map(sid => ({ ...created, storage_id: sid, warehouse: null })),
        ...jobForm.warehouses.map(w => ({ ...created, storage_id: null, warehouse: w })),
      ] : [{ ...created, storage_id: null, warehouse: null }];
      const { error } = await supabase.from("storage_jobs").insert(rows);
      setJobSaving(false);
      if (error) { setJobErr(error.message); return; }
    }
    setShowAddJob(false);
    loadJobs();
    if (!settlementsMissing) loadClosingSheets();
  }

  // Advance a job to its next status across all its parts. Reaching "delivered"
  // also stamps date_out (so it leaves the active lists). Falls back to the
  // delivered flag when the CRM status columns aren't present yet.
  async function advanceStatus(g) {
    if (!g?.parts?.length) return;
    if (jobColsMissing) { await deliverJobs(g.parts.map(p => p.id)); return; }
    const ns = nextStatus(g);
    if (!ns) return;
    const patch = { status: ns, updated_by: userEmail, updated_at: new Date().toISOString() };
    if (ns === "delivered") patch.date_out = today();
    if (ns === "picked_up" && !g.pickup_date) patch.pickup_date = today();
    await supabase.from("storage_jobs").update(patch).in("id", g.parts.map(p => p.id));
    loadJobs();
  }

  // ── Brokers CRUD ──
  function openAddBroker() { setEditingBrokerId(null); setBrokerForm(EMPTY_BROKER); setShowBrokerModal(true); }
  function openEditBroker(b) {
    setEditingBrokerId(b.id);
    setBrokerForm({ name:b.name||"", contact_name:b.contact_name||"", contact_phone:b.contact_phone||"", contact_email:b.contact_email||"", notes:b.notes||"" });
    setShowBrokerModal(true);
  }
  async function saveBroker() {
    if (!brokerForm.name.trim()) return;
    setBrokerSaving(true);
    const payload = { name:brokerForm.name.trim(), contact_name:brokerForm.contact_name||null, contact_phone:brokerForm.contact_phone||null, contact_email:brokerForm.contact_email||null, notes:brokerForm.notes||null };
    if (editingBrokerId) await supabase.from("brokers").update(payload).eq("id", editingBrokerId);
    else await supabase.from("brokers").insert([payload]);
    setBrokerSaving(false); setShowBrokerModal(false);
    loadBrokers();
  }
  async function deleteBroker(b) {
    if (!window.confirm(`Eliminar el broker "${b.name}"? Los jobs asociados quedan sin broker.`)) return;
    await supabase.from("brokers").delete().eq("id", b.id);
    loadBrokers();
  }

  // ── Drivers CRUD ──
  function openAddDriver() { setEditingDriverId(null); setDriverForm(EMPTY_DRIVER); setShowDriverModal(true); }
  function openEditDriver(d) {
    setEditingDriverId(d.id);
    setDriverForm({ name:d.name||"", phone:d.phone||"", whatsapp_group_link:d.whatsapp_group_link||"", truck_id:d.truck_id||"", notes:d.notes||"", active: d.active !== false });
    setShowDriverModal(true);
  }
  async function saveDriver() {
    if (!driverForm.name.trim()) return;
    setDriverSaving(true);
    const payload = { name:driverForm.name.trim(), phone:driverForm.phone||null, whatsapp_group_link:driverForm.whatsapp_group_link||null, truck_id:driverForm.truck_id||null, notes:driverForm.notes||null, active: !!driverForm.active };
    if (editingDriverId) await supabase.from("drivers").update(payload).eq("id", editingDriverId);
    else await supabase.from("drivers").insert([payload]);
    setDriverSaving(false); setShowDriverModal(false);
    loadDrivers();
  }
  async function deleteDriver(d) {
    if (!window.confirm(`Eliminar el driver "${d.name}"?`)) return;
    await supabase.from("drivers").delete().eq("id", d.id);
    loadDrivers();
  }
  function toggleJobDriver(id) {
    setJobForm(f => { const cur = Array.isArray(f.driver_ids) ? f.driver_ids : []; return { ...f, driver_ids: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }; });
  }

  // ── Carrier settlements handlers ──
  function openAddCs() {
    setEditingCsId(null); setCsForm(EMPTY_CS); setCsJobSearch(""); setShowCsModal(true);
  }
  function openEditCs(s) {
    setEditingCsId(s.id);
    const assigned = [...new Set(jobs.filter(j => j.closing_sheet_id === s.id).map(jobKey))];
    setCsForm({
      closing_sheet_number: s.closing_sheet_number || "", broker_id: s.broker_id || "", driver_id: s.driver_id || "",
      load_date: s.load_date || "", status: s.status || "open",
      charge_per_pad: s.charge_per_pad ?? "7",
      trip_cost: s.trip_cost ?? "", labor_charges: s.labor_charges ?? "", other_fees: s.other_fees ?? "", other_fees_description: s.other_fees_description || "",
      notes: s.notes || "", document_url: s.document_url || "", job_keys: assigned,
    });
    setCsJobSearch(""); setShowCsModal(true);
  }
  function csToggleJob(k) {
    setCsForm(f => ({ ...f, job_keys: f.job_keys.includes(k) ? f.job_keys.filter(x => x !== k) : [...f.job_keys, k] }));
  }
  async function saveCs() {
    setCsSaving(true);
    const payload = {
      closing_sheet_number: csForm.closing_sheet_number || null,
      broker_id: csForm.broker_id ? Number(csForm.broker_id) : null,
      driver_id: csForm.driver_id ? Number(csForm.driver_id) : null,
      load_date: csForm.load_date || null,
      status: csForm.status || "open",
      charge_per_pad: csForm.charge_per_pad !== "" ? Number(csForm.charge_per_pad) : 7,
      trip_cost: csForm.trip_cost !== "" ? Number(csForm.trip_cost) : 0,
      labor_charges: csForm.labor_charges !== "" ? Number(csForm.labor_charges) : 0,
      other_fees: csForm.other_fees !== "" ? Number(csForm.other_fees) : 0,
      other_fees_description: csForm.other_fees_description || null,
      notes: csForm.notes || null,
      document_url: csForm.document_url || null,
    };
    let sheetId = editingCsId;
    let error = null;
    if (editingCsId) {
      ({ error } = await supabase.from("closing_sheets").update(payload).eq("id", editingCsId));
    } else {
      const { data, error: insErr } = await supabase.from("closing_sheets").insert([payload]).select("id").single();
      error = insErr; sheetId = data?.id;
    }
    if (!error && sheetId) {
      // Reconcile job assignment: set closing_sheet_id on selected jobs, clear de-selected.
      const wanted = new Set(csForm.job_keys);
      const toSet = jobs.filter(j => wanted.has(jobKey(j)) && j.closing_sheet_id !== sheetId).map(j => j.id);
      const toClear = jobs.filter(j => j.closing_sheet_id === sheetId && !wanted.has(jobKey(j))).map(j => j.id);
      if (toSet.length) await supabase.from("storage_jobs").update({ closing_sheet_id: sheetId, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", toSet);
      if (toClear.length) await supabase.from("storage_jobs").update({ closing_sheet_id: null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", toClear);
    }
    setCsSaving(false);
    if (error) { window.alert(error.message); return; }
    setShowCsModal(false);
    loadClosingSheets(); loadJobs();
    if (sheetId && !editingCsId) setCsDetailId(sheetId);
  }
  async function setCsStatus(s, status) {
    await supabase.from("closing_sheets").update({ status }).eq("id", s.id);
    loadClosingSheets();
  }
  async function deleteCs(s) {
    if (!window.confirm(`Eliminar el closing sheet #${s.closing_sheet_number || s.id}? Los jobs quedan sin asignar.`)) return;
    await supabase.from("storage_jobs").update({ closing_sheet_id: null }).eq("closing_sheet_id", s.id);
    await supabase.from("closing_sheets").delete().eq("id", s.id);
    setCsDetailId(null); loadClosingSheets(); loadJobs();
  }
  // Inline-edit a per-job settlement field (carrier_rate_per_cf, bol_balance, volume) on all its parts.
  async function updateJobBol(jobKeyStr, field, value) {
    const ids = jobs.filter(j => jobKey(j) === jobKeyStr).map(j => j.id);
    if (!ids.length) return;
    await supabase.from("storage_jobs").update({ [field]: value === "" ? null : value, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    loadJobs();
  }
  // Create a fresh open closing sheet for a job's broker and link the job to it.
  async function addJobToNewSheet(jobKeyStr, brokerId) {
    const { data } = await supabase.from("closing_sheets").insert([{ broker_id: brokerId || null, load_date: today(), status: "open" }]).select("id").single();
    if (data?.id) { await updateJobBol(jobKeyStr, "closing_sheet_id", data.id); loadClosingSheets(); }
  }
  async function savePayment() {
    if (!payModal) return;
    const ids = jobs.filter(j => jobKey(j) === payModal.jobKey).map(j => j.id);
    if (!ids.length) { setPayModal(null); return; }
    await supabase.from("storage_jobs").update({
      bol_collected: numv(payModal.amount), bol_payment_method: payModal.method || null, bol_payment_notes: payModal.notes || null,
      bol_collected_date: payModal.date || today(), updated_by: userEmail, updated_at: new Date().toISOString(),
    }).in("id", ids);
    setPayModal(null);
    loadJobs();
  }
  async function uploadCsDoc(file, sheet) {
    if (!file) return;
    setDocUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      const path = `cs-${sheet?.id || "new"}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("closing-sheet-docs").upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (error) { window.alert("Error al subir: " + error.message); setDocUploading(false); return; }
      const { data } = supabase.storage.from("closing-sheet-docs").getPublicUrl(path);
      const url = data?.publicUrl || "";
      if (sheet?.id) { await supabase.from("closing_sheets").update({ document_url: url }).eq("id", sheet.id); loadClosingSheets(); }
      else { setCsForm(f => ({ ...f, document_url: url })); }
    } catch (e) { window.alert("Error: " + e.message); }
    setDocUploading(false);
  }
  function exportCsPdf(sheet, calc, brokerNm, driverNm, jobsIn) {
    const m = (n) => `$${Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2})}`;
    const rows = jobsIn.map(j => `<tr><td>${j.job_number||"-"}</td><td>${j.customer||"-"}</td><td>${Math.round(parseCf(j.volume))} CF</td><td>${m(numv(j.carrier_rate_per_cf))}</td><td>${m(parseCf(j.volume)*numv(j.carrier_rate_per_cf))}</td><td>${m(numv(j.bol_balance))}</td><td>${m(numv(j.bol_collected))}</td></tr>`).join("");
    const net = calc.net >= 0 ? `Broker te debe ${m(calc.net)}` : `Le debés al broker ${m(-calc.net)}`;
    const html = `<html><head><meta charset="utf-8"><title>CS ${sheet.closing_sheet_number||""}</title>
      <style>body{font-family:system-ui,sans-serif;padding:30px;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#f5f5f5}.box{border:1px solid #ddd;border-radius:8px;padding:12px;margin-top:10px}.r{display:flex;justify-content:space-between;font-size:13px;margin:3px 0}</style></head>
      <body><h1>Closing Sheet #${sheet.closing_sheet_number||"-"}</h1>
      <div>Broker: <b>${brokerNm||"-"}</b> · Driver: ${driverNm||"-"} · Load date: ${sheet.load_date||"-"} · Status: ${sheet.status}</div>
      <table><thead><tr><th>Job #</th><th>Cliente</th><th>CF</th><th>Rate/CF</th><th>Carrier fee</th><th>BOL balance</th><th>Collected</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="box"><div class="r"><span>Carrier fee subtotal</span><b>${m(calc.carrierFee)}</b></div>
      <div class="r"><span>− Trip cost</span><span>${m(numv(sheet.trip_cost))}</span></div>
      <div class="r"><span>− Labor</span><span>${m(numv(sheet.labor_charges))}</span></div>
      <div class="r"><span>− Other fees</span><span>${m(numv(sheet.other_fees))}</span></div>
      <div class="r"><span>− Pads (${calc.padsMissing})</span><span>${m(calc.padsCharge)}</span></div>
      <div class="r" style="border-top:1px solid #ddd;padding-top:6px;margin-top:6px"><span><b>Broker te debe</b></span><b>${m(calc.netCarrier)}</b></div></div>
      <div class="box"><div class="r"><span>BOL cobrado a clientes</span><b>${m(calc.bolCollected)}</b></div><div class="r"><span>Pendiente de cobro</span><span>${m(calc.pending)}</span></div></div>
      <div class="box" style="text-align:center;font-size:16px;font-weight:700">${net}</div>
      </body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); }
  }

  // ── Capacity & billing handlers ──
  function openCapacity(target) { setCapTarget(target); }
  async function saveCapacity() {
    if (!capTarget) return;
    const val = capTarget.value !== "" ? Number(capTarget.value) : null;
    if (capTarget.kind === "unit") {
      await supabase.from("storages").update({ total_capacity_cf: val, space_type: "rented", updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", capTarget.id);
    } else if (capTarget.kind === "warehouse") {
      const existing = warehouseMeta[capTarget.name];
      if (existing) await supabase.from("storages").update({ total_capacity_cf: val, updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", existing.id);
      else await supabase.from("storages").insert([{ brand: capTarget.name, space_type: "warehouse", situation: "Open", total_capacity_cf: val, created_by: userEmail }]);
    }
    setCapTarget(null);
  }
  async function markBillingPaid(b) {
    await supabase.from("storage_billing").update({ status: "paid", paid_date: today() }).eq("id", b.id);
    loadBilling();
  }

  // Per-broker stats: active jobs count + pending balance (distinct jobs).
  const brokerStats = useMemo(() => {
    const num = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
    const m = {};
    const seen = new Set();
    for (const j of jobs) {
      if (!j.broker_id) continue;
      const k = jobKey(j);
      if (!m[j.broker_id]) m[j.broker_id] = { jobs: new Set(), balance: 0 };
      m[j.broker_id].jobs.add(k);
      const sk = j.broker_id + "|" + k;
      if (!seen.has(sk) && !j.date_out && j.status !== "cancelled") {
        seen.add(sk);
        m[j.broker_id].balance += num(j.pickup_balance) + num(j.delivery_balance);
      }
    }
    return m;
  }, [jobs]);

  // Mark every part of a job (all its units) as delivered.
  async function deliverJobs(ids) {
    if (!ids || !ids.length) return;
    await supabase.from("storage_jobs").update({ date_out: today(), updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    loadJobs();
  }

  // Revert a delivery (e.g. marked by mistake): clears the delivery date.
  async function undeliverJobs(ids) {
    if (!ids || !ids.length) return;
    await supabase.from("storage_jobs").update({ date_out: null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", ids);
    loadJobs();
  }

  // Quick-set the FADD on every part of a job (from the Dispatching table).
  async function setJobFadd(group, dateStr) {
    if (faddColMissing || !group?.parts?.length) return;
    await supabase.from("storage_jobs").update({ fadd: dateStr || null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", group.parts.map(p => p.id));
    loadJobs();
  }

  // Inline-edit a single job-level field across all parts of a job.
  async function updateJobField(parts, field, value) {
    if (!parts?.length) return;
    if (field === "fadd" && faddColMissing) return;
    await supabase.from("storage_jobs").update({ [field]: value || null, updated_by: userEmail, updated_at: new Date().toISOString() }).in("id", parts.map(p => p.id));
    loadJobs();
  }

  async function deleteRecord(id) {
    if (!window.confirm("Eliminar este storage?")) return;
    await supabase.from("storages").delete().eq("id", id);
    setDetailId(null);
  }

  // Renew the payment: push the due date 30 days forward from its current value.
  async function renewPayment(r) {
    const base = paymentDueDate(r) || startOfToday();
    base.setDate(base.getDate() + 30);
    await supabase.from("storages").update({ payment_due_date: fmtDateLocal(base), updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", r.id);
  }

  // Close a storage: mark it Closed and clear its payment due date.
  async function closeStorage(r) {
    await supabase.from("storages").update({ situation: "Close", payment_due_date: null, updated_by: userEmail, updated_at: new Date().toISOString() }).eq("id", r.id);
    setDetailId(null);
  }

  function openImportModal() { setShowImport(true); setImportTab("paste"); setPasteText(""); setPending([]); setExcluded({}); setZipStatus(""); setZipName(""); }
  function previewPaste() { setPending(parsePastedMessages(pasteText)); setExcluded({}); }

  async function handleZip(file) {
    if (!file) return;
    setZipName(file.name); setZipStatus("Leyendo ZIP...");
    try {
      const { default: JSZip } = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
      const zip = await JSZip.loadAsync(file);
      let chatFile = Object.keys(zip.files).find(n => /chat.*\.txt$/i.test(n) && !zip.files[n].dir);
      if (!chatFile) chatFile = Object.keys(zip.files).find(n => /\.txt$/i.test(n) && !zip.files[n].dir);
      if (!chatFile) { setZipStatus("No se encontro un archivo .txt dentro del ZIP."); return; }
      const text = await zip.files[chatFile].async("string");
      const parsed = parseWhatsAppExport(text);
      if (!parsed.length) { setZipStatus("No se detectaron mensajes con datos de storage."); return; }
      setPending(parsed); setExcluded({});
      setZipStatus(`${parsed.length} storage(s) detectados en "${chatFile}".`);
    } catch (err) { setZipStatus("Error: " + err.message); }
  }

  async function confirmImport() {
    const toAdd = pending.filter((_, i) => !excluded[i]);
    if (!toAdd.length) return;
    setSaving(true);
    await supabase.from("storages").insert(toAdd);
    setSaving(false); setShowImport(false);
  }

  const tabStyle = (t) => ({ fontSize:13, fontWeight: tab === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: tab === t ? "#111" : "#999", borderBottom: tab === t ? "2px solid #111" : "2px solid transparent" });
  const impTabStyle = (t) => ({ flex:1, fontSize:13, padding:"8px", borderRadius:7, cursor:"pointer", border:"none", background: importTab === t ? "#fff" : "none", color: importTab === t ? "#111" : "#888", fontWeight: importTab === t ? 600 : 400, boxShadow: importTab === t ? "0 1px 4px rgba(0,0,0,0.08)" : "none" });

  if (session === undefined) return null;
  if (!session) return <LoginScreen />;

  if (loading) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, color:"#888", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ width:32, height:32, border:"3px solid #f0f0f0", borderTop:"3px solid #111", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontSize:14 }}>Cargando storages...</span>
    </div>
  );

  if (error) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, color:"#b91c1c", fontFamily:"system-ui,sans-serif", padding:24 }}>
      <span style={{ fontSize:15, fontWeight:600 }}>Error de conexion</span>
      <span style={{ fontSize:13, color:"#888" }}>{error}</span>
      <button onClick={loadData} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", cursor:"pointer", fontSize:13 }}>Reintentar</button>
    </div>
  );

  return (
    <div style={{ fontFamily:"system-ui,-apple-system,sans-serif", color:"#111", display:"flex", minHeight:"100vh", background:"#fafafa" }}>
      <Sidebar page={page} setPage={setPage} onSignOut={() => supabase.auth.signOut()} badges={sidebarBadgesPlus} />
      <div style={{ flex:1, minWidth:0, padding:"20px 24px 40px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:18, flexWrap:"wrap" }}>
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <h1 style={{ fontSize:22, fontWeight:700, margin:0, letterSpacing:"-0.02em" }}>{PAGE_META[page].title}</h1>
            <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:20, background: liveIndicator ? "#EAF3DE" : "#f5f5f5", color: liveIndicator ? "#3B6D11" : "#aaa", transition:"all .3s" }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background: liveIndicator ? "#639922" : "#ccc", transition:"all .3s" }} />
              {liveIndicator ? "Actualizado" : "Live"}
            </span>
          </div>
          <div style={{ fontSize:13, color:"#999", marginTop:2 }}>{PAGE_META[page].sub}</div>
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          {page === "storage" && <Btn onClick={openImportModal}>Importar WhatsApp</Btn>}
          {page === "storage" && <Btn onClick={openAdd}>+ Unidad</Btn>}
          {page === "drivers" && <Btn primary disabled={crmV3Missing} onClick={openAddDriver}>+ Driver</Btn>}
          {page === "brokers" && <Btn primary disabled={crmV2Missing} onClick={openAddBroker}>+ Broker</Btn>}
          {page === "settlements" && !csDetailId && <Btn primary disabled={settlementsMissing} onClick={openAddCs}>+ Closing sheet</Btn>}
          {(page === "dispatching" || page === "jobs" || page === "calendario") && <Btn primary disabled={!dbReady} onClick={() => openAddJob("")}>+ Nuevo job</Btn>}
        </div>
      </div>

      {dbSetupNeeded && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>El historial de jobs por unidad necesita crear la tabla <strong>storage_jobs</strong> una sola vez.</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver instrucciones</button>
        </div>
      )}

      {paymentColMissing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B" }}>
          Para el seguimiento de pagos, agregá la columna una sola vez en Supabase (SQL Editor):
          <code style={{ display:"block", marginTop:6, fontFamily:"monospace", fontSize:12 }}>alter table public.storages add column if not exists payment_due_date date;</code>
        </div>
      )}

      {faddColMissing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B" }}>
          Para el FADD / Dispatching, agregá la columna una sola vez en Supabase (SQL Editor):
          <code style={{ display:"block", marginTop:6, fontFamily:"monospace", fontSize:12 }}>alter table public.storage_jobs add column if not exists fadd date;</code>
        </div>
      )}

      {jobColsMissing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B" }}>
          Para el CRM de Dispatching (tipo de job, estados, pickup/delivery), agregá estas columnas una sola vez en Supabase (SQL Editor):
          <code style={{ display:"block", marginTop:6, fontFamily:"monospace", fontSize:12, whiteSpace:"pre-wrap" }}>{JOB_COLS_SQL}</code>
        </div>
      )}

      {crmV2Missing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>Para Brokers y los balances de pickup/delivery, corré este SQL una sola vez en Supabase (SQL Editor).</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver SQL</button>
        </div>
      )}

      {billingMissing && page !== "billing" && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>Para Billing y la ocupación de storage (capacidad CF), corré el SQL de configuración una sola vez en Supabase.</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver SQL</button>
        </div>
      )}

      {crmV3Missing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>Para Drivers, multi-asignación, rep y los campos financieros nuevos, corré el SQL de configuración una sola vez en Supabase.</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver SQL</button>
        </div>
      )}

      {page === "storage" && duePaymentsSoon.length > 0 && (
        <div style={{ background:"#FCEBEB", border:"1px solid #E24B4A", borderRadius:10, padding:"12px 14px", marginBottom:16, fontSize:13, color:"#A32D2D" }}>
          <strong>⚠️ {duePaymentsSoon.length} pago(s) vencen en 3 días o menos:</strong>
          <div style={{ marginTop:6, display:"flex", flexWrap:"wrap", gap:8 }}>
            {duePaymentsSoon.map(p => (
              <span key={p.id} onClick={() => setDetailId(p.id)} style={{ background:"#fff", border:"1px solid #f3c9c9", borderRadius:20, padding:"3px 10px", cursor:"pointer", whiteSpace:"nowrap" }}>
                {p.label} · {p.days < 0 ? "vencido" : p.days === 0 ? "hoy" : `${p.days}d`}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ───────────────────────── DISPATCHING ───────────────────────── */}
      {page === "dispatching" && (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10, marginBottom:16 }}>
            {[
              { label:"Pickups hoy", value:dispatchMetrics.pickups, color:"#185FA5" },
              { label:"Deliveries hoy", value:dispatchMetrics.deliveries, color:"#3B6D11" },
              { label:"FADD overdue", value:faddStats.overdue, color:"#A32D2D" },
              { label:"FADD esta semana", value:faddStats.dueWeek, color:"#C2410C" },
              { label:"En storage", value:dispatchMetrics.inStorage, color:"#7C3AED" },
              { label:"Balance pickup pend.", value:"$"+dispatchMetrics.puBal.toLocaleString(), color:"#1A8A4E" },
              { label:"Balance delivery pend.", value:"$"+dispatchMetrics.delBal.toLocaleString(), color:"#1A8A4E" },
              { label:"Billing overdue", value:billingOverdueCount, color:"#A32D2D" },
            ].map(m => (
              <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                <div style={{ fontSize:11, color:"#aaa", fontWeight:500, marginBottom:4 }}>{m.label}</div>
                <div style={{ fontSize:22, fontWeight:700, color:m.color }}>{m.value}</div>
              </div>
            ))}
          </div>

          {dispatchAlerts.length > 0 && !bannerDismissed && (
            <div style={{ background:"#FCEBEB", border:"1px solid #E24B4A", borderRadius:10, padding:"12px 14px", marginBottom:14, fontSize:13, color:"#A32D2D", display:"flex", alignItems:"flex-start", gap:10 }}>
              <div style={{ flex:1 }}>
                <strong>⚠️ {dispatchAlerts.length} job(s) requieren atención:</strong>
                <div style={{ marginTop:6, display:"flex", flexWrap:"wrap", gap:8 }}>
                  {dispatchAlerts.map(a => (
                    <span key={a.key} onClick={() => setJobDetailKey(a.key)} style={{ background:"#fff", border:"1px solid #f3c9c9", borderRadius:20, padding:"3px 10px", cursor:"pointer", whiteSpace:"nowrap" }}>
                      <strong style={{ fontFamily:"monospace" }}>{a.job_number || "(job)"}</strong> · {a.customer || "—"} · {a.reason}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => setBannerDismissed(true)} title="Descartar" style={{ background:"none", border:"none", fontSize:18, lineHeight:1, cursor:"pointer", color:"#A32D2D", flexShrink:0 }}>×</button>
            </div>
          )}

          <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
            {[["all","Todos"],["pickups_today","Pick ups hoy"],["deliveries_today","Deliveries hoy"],["in_storage","En storage"],["on_hold","On hold"],["nofadd","Sin FADD"]].map(([t,l]) => (
              <button key={t} onClick={() => setDispatchFilter(t)}
                style={{ fontSize:13, fontWeight: dispatchFilter === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: dispatchFilter === t ? "#111" : "#999", borderBottom: dispatchFilter === t ? "2px solid #111" : "2px solid transparent" }}>{l}</button>
            ))}
          </div>

          <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por job #, cliente, driver, pickup, delivery..."
              style={{ ...inp, flex:1, minWidth:180 }} />
            <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={{ ...inp, minWidth:150 }}>
              <option value="">Todos los drivers</option>
              {drivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["Estado","Job #","Tipo","Broker","Rep","Cliente","FADD","Pickup","Delivery","CF","Sticker","Driver","Bal. pickup","Bal. delivery","Storage","Acciones"].map((h, i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dispatchGroups.length === 0 ? (
                    <tr><td colSpan={16} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin jobs para despachar en este filtro.</td></tr>
                  ) : dispatchGroups.map(g => {
                    const stores = [...new Set(g.parts.map(p => p.warehouse ? `Warehouse ${p.warehouse}` : [p.storage?.brand, p.storage?.unit && "U"+p.storage.unit, p.storage?.state].filter(Boolean).join(" ")).filter(Boolean))];
                    const storeLabel = stores.join(" · ");
                    const mapHref = routeUrl(g);
                    const ns = nextStatus(g);
                    const pickupAddr = [g.pickup_address, [g.pickup_city, g.pickup_state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
                    const deliveryAddr = [g.delivery_address, [g.delivery_city, g.delivery_state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
                    return (
                    <tr key={g.key} style={{ borderBottom:"1px solid #fafafa", verticalAlign:"top" }}>
                      <td style={{ padding:"12px" }}><StatusBadge status={g.status} /></td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                        <span style={{ display:"inline-flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                          {!g.sticker_color && <span title="Sticker sin asignar" style={{ cursor:"help" }}>⚠️</span>}
                          <button onClick={() => setJobDetailKey(g.key)} style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{g.job_number || "(ver)"}</button>
                          {g.job_type === "broker_delivery" && (g.status === "delivered" || g.parts?.some(p => p.date_out)) && numv(g.bol_collected) < numv(g.bol_balance) && numv(g.bol_balance) > 0 && (
                            <span title="Cobro BOL pendiente" style={{ fontSize:9.5, fontWeight:700, color:"#C2410C", background:"#FDE3CF", borderRadius:10, padding:"1px 6px" }}>Cobro pendiente</span>
                          )}
                        </span>
                      </td>
                      <td style={{ padding:"12px" }}><TypeBadge type={g.job_type} /></td>
                      <td style={{ padding:"12px", fontSize:12, whiteSpace:"nowrap" }}>{brokerName(g.broker_id) || "—"}</td>
                      <td style={{ padding:"12px", fontSize:12, whiteSpace:"nowrap" }}>{g.rep || "—"}</td>
                      <td style={{ padding:"12px" }}>{g.customer||"—"}</td>
                      <td style={{ padding:"12px" }}><FaddCell group={g} onSet={setJobFadd} /></td>
                      <td style={{ padding:"12px", fontSize:12, minWidth:130 }}>
                        <div style={{ fontWeight:600 }}>{(() => { const f = g.pickup_date_from || g.pickup_date; if (!f) return "—"; const t = g.pickup_date_to; return t && t !== f ? `${f} → ${t}` : f; })()}</div>
                        {pickupAddr && <div style={{ color:"#888", marginTop:2 }}>{pickupAddr}</div>}
                      </td>
                      <td style={{ padding:"12px", fontSize:12, minWidth:130 }}>
                        <div style={{ fontWeight:600 }}>{g.delivery_date || "—"}</div>
                        {deliveryAddr && <div style={{ color:"#888", marginTop:2 }}>{deliveryAddr}</div>}
                      </td>
                      <td style={{ padding:"12px" }}>{g.volume||"—"}</td>
                      <td style={{ padding:"12px" }}>
                        <Sticker color={g.sticker_color} />
                        {g.lot_number && <div style={{ fontFamily:"monospace", fontSize:11, color:"#888", marginTop:2 }}>{g.lot_number}</div>}
                      </td>
                      <td style={{ padding:"12px" }}>{jobDriverNames(g)||"—"}</td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:600, color: money(g.pickup_balance) ? "#1A8A4E" : "#bbb" }}>{money(g.pickup_balance) || "—"}</td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:600, color: money(g.delivery_balance) ? "#1A8A4E" : "#bbb" }}>{money(g.delivery_balance) || "—"}</td>
                      <td style={{ padding:"12px", fontSize:12, color:"#555" }}>
                        {stores.length ? stores.map((s, i) => <div key={i} style={{ marginBottom: i < stores.length-1 ? 3 : 0 }}>{s}</div>) : "—"}
                      </td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                        <div style={{ display:"flex", flexDirection:"column", gap:5, alignItems:"flex-start" }}>
                          {mapHref && <a href={mapHref} target="_blank" rel="noreferrer" style={{ color:"#185FA5", textDecoration:"none", fontSize:12 }}>🗺️ Ruta</a>}
                          <a href={waLink(g, storeLabel, brokerName(g.broker_id), jobGroupLink(g))} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E", textDecoration:"none", fontSize:12 }}>💬 WhatsApp</a>
                          {ns && <Btn onClick={() => advanceStatus(g)} style={{ padding:"4px 9px", fontSize:11 }}>→ {statusMeta(ns).l}</Btn>}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{dispatchGroups.length} job(s)</div>
          </div>
        </>
      )}

      {/* ───────────────────────── CALENDARIO ───────────────────────── */}
      {page === "calendario" && (() => {
        const range = calView === "week" ? weekDays(calAnchor) : null;
        const grid = calView === "month" ? monthGrid(calAnchor) : null;
        const anchorD = new Date(calAnchor + "T00:00:00");
        const title = calView === "week"
          ? (() => { const w = weekDays(calAnchor); return `${w[0]} → ${w[6]}`; })()
          : `${MONTHS_ES[anchorD.getMonth()]} ${anchorD.getFullYear()}`;
        const step = calView === "week" ? 7 : 30;
        const Event = ({ g }) => {
          const c = calEventColor(g);
          const route = [g.pickup_state, g.delivery_state].filter(Boolean).join(" to ");
          const drv = jobDriverNames(g);
          return (
            <div onClick={() => setJobDetailKey(g.key)} title={`${g.job_number || ""} ${g.customer || ""}`}
              style={{ background:c.bg, color:c.text, borderLeft:`3px solid ${c.bar}`, borderRadius:5, padding:"3px 6px", marginBottom:4, cursor:"pointer", fontSize:10.5, lineHeight:1.3 }}>
              <div style={{ fontWeight:700, fontFamily:"monospace" }}>{g.job_number || "(job)"}</div>
              {route && <div>{route}</div>}
              {drv && <div style={{ opacity:0.85 }}>🧑‍✈️ {drv}</div>}
            </div>
          );
        };
        return (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
              <Btn onClick={() => setCalAnchor(shiftDate(calAnchor, -step))}>←</Btn>
              <Btn onClick={() => setCalAnchor(today())}>Hoy</Btn>
              <Btn onClick={() => setCalAnchor(shiftDate(calAnchor, step))}>→</Btn>
              <strong style={{ fontSize:15, marginLeft:6 }}>{title}</strong>
              <span style={{ flex:1 }} />
              <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3 }}>
                {[["week","Semana"],["month","Mes"]].map(([v,l]) => (
                  <button key={v} onClick={() => setCalView(v)} style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: calView===v?"#fff":"none", color: calView===v?"#111":"#888", fontWeight: calView===v?600:400, boxShadow: calView===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
                ))}
              </div>
            </div>

            <div style={{ display:"flex", gap:10, marginBottom:12, flexWrap:"wrap", fontSize:11, color:"#666" }}>
              {[["#639922","Activo"],["#FACC15","On hold / Redispatch"],["#E24B4A","Cancelado"],["#7C3AED","Long haul"],["#378ADD","Entregado"]].map(([c,l]) => (
                <span key={l} style={{ display:"inline-flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:3, background:c }} />{l}</span>
              ))}
            </div>

            {calView === "week" ? (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:8 }}>
                {range.map(ds => {
                  const d = new Date(ds + "T00:00:00");
                  const evs = pickupEvents[ds] || [];
                  const isToday = ds === today();
                  return (
                    <div key={ds} style={{ background:"#fff", border:`1px solid ${isToday?"#378ADD":"#efefef"}`, borderRadius:10, minHeight:160, display:"flex", flexDirection:"column" }}>
                      <div onClick={() => openAddJobDate(ds)} title="Crear pick up" style={{ padding:"7px 9px", borderBottom:"1px solid #f3f3f3", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ fontSize:11, fontWeight:600 }}>{DOW_ES[d.getDay()]} {d.getDate()}</span>
                        <span style={{ color:"#bbb", fontSize:13 }}>+</span>
                      </div>
                      <div style={{ padding:7, flex:1 }}>{evs.map(g => <Event key={g.key} g={g} />)}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ background:"#fff", border:"1px solid #efefef", borderRadius:10, overflow:"hidden" }}>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)" }}>
                  {DOW_ES.map(d => <div key={d} style={{ padding:"8px 6px", textAlign:"center", fontSize:10, fontWeight:700, color:"#aaa", textTransform:"uppercase", borderBottom:"1px solid #efefef" }}>{d}</div>)}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)" }}>
                  {grid.map(({ date, inMonth }) => {
                    const d = new Date(date + "T00:00:00");
                    const evs = pickupEvents[date] || [];
                    const isToday = date === today();
                    return (
                      <div key={date} style={{ borderRight:"1px solid #f4f4f4", borderBottom:"1px solid #f4f4f4", minHeight:96, padding:5, background: inMonth?"#fff":"#fafafa", opacity: inMonth?1:0.6 }}>
                        <div onClick={() => openAddJobDate(date)} style={{ cursor:"pointer", fontSize:10.5, fontWeight:600, color: isToday?"#185FA5":"#666", marginBottom:3 }}>{d.getDate()}</div>
                        {evs.slice(0,3).map(g => <Event key={g.key} g={g} />)}
                        {evs.length > 3 && <div style={{ fontSize:9, color:"#999" }}>+{evs.length-3} más</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* ───────────────────────── BROKERS ───────────────────────── */}
      {page === "brokers" && (
        <>
          <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
            <Btn primary disabled={crmV2Missing} onClick={openAddBroker}>+ Nuevo broker</Btn>
          </div>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["Broker","Contacto","Teléfono","Jobs","Balance pend.","CS abiertos","Nos debe","Le debemos","Net","" ].map((h, i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {brokers.length === 0 ? (
                    <tr><td colSpan={10} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{crmV2Missing ? "Corré el SQL de configuración para activar brokers." : "Sin brokers cargados."}</td></tr>
                  ) : brokers.map(b => {
                    const st = brokerStats[b.id] || { jobs:new Set(), balance:0 };
                    const count = st.jobs.size;
                    const ss = brokerSettleStats[b.id] || { open:0, owesUs:0, weOwe:0 };
                    const net = ss.owesUs - ss.weOwe;
                    return (
                      <tr key={b.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", fontWeight:600 }}><button onClick={() => setBrokerDetailId(b.id)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#111", fontWeight:600, textDecoration:"underline" }}>{b.name}</button></td>
                        <td style={{ padding:"12px" }}>{b.contact_name||"—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{b.contact_phone ? <a href={`tel:${b.contact_phone}`} style={{ color:"#185FA5", textDecoration:"none" }}>{b.contact_phone}</a> : "—"}</td>
                        <td style={{ padding:"12px" }}><span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: count>0?"#EAF3DE":"#f5f5f5", color: count>0?"#3B6D11":"#bbb" }}>{count}</span></td>
                        <td style={{ padding:"12px", fontWeight:600, color: st.balance>0 ? "#1A8A4E" : "#bbb", whiteSpace:"nowrap" }}>${st.balance.toLocaleString()}</td>
                        <td style={{ padding:"12px" }}>{ss.open || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", color: ss.owesUs>0?"#1A8A4E":"#bbb" }}>${Math.round(ss.owesUs).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", color: ss.weOwe>0?"#A32D2D":"#bbb" }}>${Math.round(ss.weOwe).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:700, color: net>=0?"#1A8A4E":"#A32D2D" }}>{net>=0?`+$${Math.round(net).toLocaleString()}`:`−$${Math.round(-net).toLocaleString()}`}</td>
                        <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                          <Btn onClick={() => openEditBroker(b)} style={{ padding:"4px 10px", fontSize:12 }}>Editar</Btn>
                          <Btn danger onClick={() => deleteBroker(b)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Eliminar</Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{brokers.length} broker(s)</div>
          </div>
        </>
      )}

      {/* ───────────────────────── DRIVERS ───────────────────────── */}
      {page === "drivers" && (
        <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Driver","Teléfono","Grupo WhatsApp","Jobs activos","Estado",""].map((h,i) => (
                    <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {driversList.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{crmV3Missing ? "Corré el SQL de configuración para activar drivers." : "Sin drivers. Agregá uno con “+ Driver”."}</td></tr>
                ) : driversList.map(d => {
                  const act = new Set(jobs.filter(j => !j.date_out && j.status !== "cancelled" && ((Array.isArray(j.driver_ids) && j.driver_ids.includes(d.id)) || (j.driver && d.name && j.driver.includes(d.name)))).map(jobKey)).size;
                  return (
                    <tr key={d.id} style={{ borderBottom:"1px solid #fafafa" }}>
                      <td style={{ padding:"12px", fontWeight:600 }}>
                        <button onClick={() => setDriverDetailId(d.id)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#111", fontWeight:600, textDecoration:"underline" }}>{d.name}</button>
                      </td>
                      <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{d.phone ? <a href={`tel:${d.phone}`} style={{ color:"#185FA5", textDecoration:"none" }}>{d.phone}</a> : "—"}</td>
                      <td style={{ padding:"12px" }}>{d.whatsapp_group_link ? <a href={d.whatsapp_group_link} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E", textDecoration:"none" }}>Abrir grupo ↗</a> : "—"}</td>
                      <td style={{ padding:"12px" }}><span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: act>0?"#EAF3DE":"#f5f5f5", color: act>0?"#3B6D11":"#bbb" }}>{act}</span></td>
                      <td style={{ padding:"12px" }}><span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background: d.active!==false?"#EAF3DE":"#f1f1f1", color: d.active!==false?"#3B6D11":"#888" }}>{d.active!==false?"Activo":"Inactivo"}</span></td>
                      <td style={{ padding:"12px", textAlign:"right", whiteSpace:"nowrap" }}>
                        <Btn onClick={() => openEditDriver(d)} style={{ padding:"4px 10px", fontSize:12 }}>Editar</Btn>
                        <Btn danger onClick={() => deleteDriver(d)} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Eliminar</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{driversList.length} driver(s)</div>
        </div>
      )}

      {/* ───────────────────────── CLIENTES ───────────────────────── */}
      {page === "clientes" && (
        <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Cliente","Teléfono","Email","Jobs activos","Total jobs","Balance pendiente"].map((h,i) => (
                    <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {clients.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin clientes todavía.</td></tr>
                ) : clients.map(c => (
                  <tr key={c.name} style={{ borderBottom:"1px solid #fafafa" }}>
                    <td style={{ padding:"12px", fontWeight:600 }}>
                      <button onClick={() => setClientDetail(c.name)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", color:"#111", fontWeight:600, textDecoration:"underline" }}>{c.name}</button>
                    </td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{c.phone ? <a href={`tel:${c.phone}`} style={{ color:"#185FA5", textDecoration:"none" }}>{c.phone}</a> : "—"}</td>
                    <td style={{ padding:"12px" }}>{c.email ? <a href={`mailto:${c.email}`} style={{ color:"#185FA5", textDecoration:"none" }}>{c.email}</a> : "—"}</td>
                    <td style={{ padding:"12px" }}><span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: c.active.size>0?"#EAF3DE":"#f5f5f5", color: c.active.size>0?"#3B6D11":"#bbb" }}>{c.active.size}</span></td>
                    <td style={{ padding:"12px", color:"#888" }}>{c.jobs.size}</td>
                    <td style={{ padding:"12px", fontWeight:600, color: c.balance>0?"#1A8A4E":"#bbb", whiteSpace:"nowrap" }}>${c.balance.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{clients.length} cliente(s)</div>
        </div>
      )}

      {/* ───────────────────────── SETTLEMENTS (list) ───────────────────────── */}
      {page === "settlements" && !csDetailId && (
        <>
          {settlementsMissing && (
            <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <span>Para Carrier Settlements (closing sheets + cobros BOL + subida de documentos), corré el SQL de configuración una sola vez en Supabase.</span>
              <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver SQL</button>
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:10, marginBottom:16 }}>
            {[
              { label:"Closing sheets abiertos", value:settlementMetrics.openCount, color:"#185FA5" },
              { label:"Broker nos debe", value:"$"+Math.round(settlementMetrics.owesUs).toLocaleString(), color:"#1A8A4E" },
              { label:"Le debemos a brokers", value:"$"+Math.round(settlementMetrics.weOwe).toLocaleString(), color:"#A32D2D" },
              { label:"Cobros BOL pendientes", value:"$"+Math.round(settlementMetrics.pendingBol).toLocaleString(), color:"#C2410C" },
              { label:"Pads pendientes ($)", value:"$"+Math.round(settlementMetrics.padsValue).toLocaleString(), color:"#92760B" },
            ].map(m => (
              <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{m.label}</div>
                <div style={{ fontSize:20, fontWeight:800, color:m.color, marginTop:3 }}>{m.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
            {[["open","Open"],["settled","Settled"],["disputed","Disputed"],["all","All"]].map(([t,l]) => (
              <button key={t} onClick={() => setCsTab(t)} style={{ fontSize:13, fontWeight: csTab===t?600:400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: csTab===t?"#111":"#999", borderBottom: csTab===t?"2px solid #111":"2px solid transparent" }}>{l}</button>
            ))}
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["CS #","Broker","Driver","Load date","Jobs","Total CF","Carrier fee","BOL cobrado","Net settlement","Estado","Acciones"].map((h,i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {closingSheets.filter(s => csTab==="all" || s.status===csTab).length === 0 ? (
                    <tr><td colSpan={11} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{settlementsMissing ? "Corré el SQL para activar settlements." : "Sin closing sheets. Creá uno con “+ Closing sheet”."}</td></tr>
                  ) : closingSheets.filter(s => csTab==="all" || s.status===csTab).map(s => {
                    const c = sheetCalcById[s.id] || {};
                    const ageDays = s.created_at ? Math.round((startOfToday() - new Date(s.created_at)) / ONE_DAY) : 0;
                    const stale = s.status === "open" && ageDays >= 30;
                    return (
                      <tr key={s.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <button onClick={() => setCsDetailId(s.id)} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{s.closing_sheet_number || `#${s.id}`}</button>
                          {stale && <span title={`Abierto hace ${ageDays} días`} style={{ marginLeft:6, fontSize:10, fontWeight:700, color:"#92760B", background:"#FEF3C7", borderRadius:10, padding:"1px 6px" }}>⚠ {ageDays}d</span>}
                        </td>
                        <td style={{ padding:"12px" }}>{brokerName(s.broker_id) || "—"}</td>
                        <td style={{ padding:"12px" }}>{driverById[s.driver_id]?.name || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{s.load_date || "—"}</td>
                        <td style={{ padding:"12px" }}>{c.jobCount || 0}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{Math.round(c.totalCf || 0).toLocaleString()} CF</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>${Math.round(c.carrierFee || 0).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>${Math.round(c.bolCollected || 0).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap", fontWeight:700, color: (c.net||0) >= 0 ? "#1A8A4E" : "#A32D2D" }}>{(c.net||0) >= 0 ? `+$${Math.round(c.net||0).toLocaleString()}` : `−$${Math.round(-(c.net||0)).toLocaleString()}`}</td>
                        <td style={{ padding:"12px" }}><CSBadge status={s.status} /></td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <Btn onClick={() => setCsDetailId(s.id)} style={{ padding:"4px 10px", fontSize:12 }}>Ver</Btn>
                          {s.status !== "settled" && <Btn onClick={() => setCsStatus(s, "settled")} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Settled</Btn>}
                          {s.status !== "disputed" && <Btn danger onClick={() => setCsStatus(s, "disputed")} style={{ padding:"4px 10px", fontSize:12, marginLeft:6 }}>Dispute</Btn>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{closingSheets.filter(s => csTab==="all" || s.status===csTab).length} closing sheet(s)</div>
          </div>
        </>
      )}

      {/* ───────────────────────── SETTLEMENTS (detail) ───────────────────────── */}
      {page === "settlements" && csDetailId && (() => {
        const s = sheetById[csDetailId];
        if (!s) return <div style={{ color:"#bbb" }}>Closing sheet no encontrado. <button onClick={() => setCsDetailId(null)} style={{ color:"#185FA5", background:"none", border:"none", cursor:"pointer" }}>Volver</button></div>;
        const jobsIn = jobsBySheet[csDetailId] || [];
        const c = sheetCalc(s, jobsIn);
        const brokerNm = brokerName(s.broker_id);
        const driverNm = driverById[s.driver_id]?.name || "";
        const isImg = s.document_url && /\.(jpe?g|png|gif|webp|heic)$/i.test(s.document_url);
        const m = (n) => `$${Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2})}`;
        const ageDays = s.created_at ? Math.round((startOfToday() - new Date(s.created_at)) / ONE_DAY) : 0;
        return (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
              <Btn onClick={() => setCsDetailId(null)}>← Volver</Btn>
              <span style={{ flex:1 }} />
              <Btn onClick={() => exportCsPdf(s, c, brokerNm, driverNm, jobsIn)}>📄 Export PDF</Btn>
              <a href={settlementWaLink(s, c, brokerNm, driverNm)} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn>💬 WhatsApp broker</Btn></a>
              <Btn onClick={() => openEditCs(s)}>Editar</Btn>
              {s.status !== "settled" && <Btn primary onClick={() => setCsStatus(s, "settled")}>Mark settled</Btn>}
            </div>

            {s.status === "open" && ageDays >= 30 && (
              <div style={{ background:"#FEF3C7", border:"1px solid #EAB308", borderRadius:10, padding:"9px 13px", marginBottom:14, fontSize:13, color:"#92760B" }}>⚠️ Este closing sheet está abierto hace {ageDays} días.</div>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 280px", gap:14, marginBottom:14 }}>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ fontSize:20, fontWeight:800, fontFamily:"monospace" }}>#{s.closing_sheet_number || s.id}</span>
                  <CSBadge status={s.status} />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:12 }}>
                  <DetailRow label="Broker" value={brokerNm} />
                  <DetailRow label="Driver" value={driverNm} />
                  <DetailRow label="Load date" value={s.load_date} />
                  <DetailRow label="Jobs · CF" value={`${c.jobCount} · ${Math.round(c.totalCf)} CF`} />
                </div>
                <div style={{ marginTop:12 }}>
                  <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:5 }}>Notas</div>
                  <textarea defaultValue={s.notes || ""} onBlur={e => { if ((e.target.value||"") !== (s.notes||"")) supabase.from("closing_sheets").update({ notes: e.target.value || null }).eq("id", s.id).then(loadClosingSheets); }}
                    placeholder="Notas del closing sheet..." style={{ ...inp, minHeight:60, resize:"vertical", fontFamily:"inherit" }} />
                </div>
              </div>

              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:8 }}>Documento original</div>
                <label style={{ display:"block", border:"2px dashed #ddd", borderRadius:10, padding:"14px", textAlign:"center", cursor:"pointer", background:"#fafafa" }}
                  onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) uploadCsDoc(f, s); }}>
                  <input type="file" accept="image/*,application/pdf" style={{ display:"none" }} onChange={e => uploadCsDoc(e.target.files?.[0], s)} />
                  {docUploading ? <div style={{ fontSize:12, color:"#888" }}>Subiendo…</div>
                    : s.document_url ? (
                      isImg ? <img src={s.document_url} alt="doc" style={{ maxWidth:"100%", maxHeight:160, borderRadius:6 }} />
                        : <div style={{ fontSize:13 }}>📄 <a href={s.document_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color:"#185FA5" }}>Ver documento (PDF)</a></div>
                    ) : <div style={{ fontSize:12, color:"#999" }}>Arrastrá o hacé clic para subir foto/PDF del closing sheet</div>}
                </label>
                {s.document_url && <div style={{ fontSize:11, color:"#aaa", marginTop:6, textAlign:"center" }}>Clic en el área para reemplazar</div>}
              </div>
            </div>

            {/* Jobs table */}
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden", marginBottom:14 }}>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead>
                    <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                      {["Job #","Cliente","From → To","CF","Pads","Rate/CF","Carrier fee","BOL balance","Cobrado","Método","Cobro","Acciones"].map((h,i) => (
                        <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {jobsIn.length === 0 ? (
                      <tr><td colSpan={12} style={{ padding:"40px", textAlign:"center", color:"#bbb" }}>Sin jobs asignados. Usá “Editar” para agregar jobs.</td></tr>
                    ) : jobsIn.map(j => {
                      const k = jobKey(j);
                      const cs = collectionStatus(j);
                      const fee = parseCf(j.volume) * numv(j.carrier_rate_per_cf);
                      const route = [[j.pickup_city, j.pickup_state].filter(Boolean).join(" "), [j.delivery_city, j.delivery_state].filter(Boolean).join(" ")].filter(Boolean).join(" → ");
                      return (
                        <tr key={j.id} style={{ borderBottom:"1px solid #fafafa" }}>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}><button onClick={() => setJobDetailKey(k)} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button></td>
                          <td style={{ padding:"10px 12px" }}>{j.customer || "—"}</td>
                          <td style={{ padding:"10px 12px", fontSize:12, color:"#555" }}>{route || "—"}</td>
                          <td style={{ padding:"10px 12px" }}><input defaultValue={parseCf(j.volume) || ""} onBlur={e => { if (e.target.value !== String(parseCf(j.volume))) updateJobBol(k, "volume", e.target.value); }} style={{ ...inp, width:64, padding:"5px 7px" }} /></td>
                          <td style={{ padding:"10px 12px", fontSize:12, whiteSpace:"nowrap" }}>{numv(j.pads_received)} rec{jobPadsMissing(j) > 0 && <span style={{ color:"#A32D2D", fontWeight:700 }}> · {jobPadsMissing(j)} falt</span>}</td>
                          <td style={{ padding:"10px 12px" }}><input defaultValue={j.carrier_rate_per_cf ?? ""} onBlur={e => { if ((e.target.value||"") !== String(j.carrier_rate_per_cf ?? "")) updateJobBol(k, "carrier_rate_per_cf", e.target.value === "" ? "" : Number(e.target.value)); }} placeholder="0" style={{ ...inp, width:64, padding:"5px 7px" }} /></td>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap", fontWeight:600 }}>${Math.round(fee).toLocaleString()}</td>
                          <td style={{ padding:"10px 12px" }}><input defaultValue={j.bol_balance ?? ""} onBlur={e => { if ((e.target.value||"") !== String(j.bol_balance ?? "")) updateJobBol(k, "bol_balance", e.target.value === "" ? "" : Number(e.target.value)); }} placeholder="0" style={{ ...inp, width:72, padding:"5px 7px" }} /></td>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap", fontWeight:600, color:"#1A8A4E" }}>{money(j.bol_collected) || "$0"}</td>
                          <td style={{ padding:"10px 12px", fontSize:12 }}>{j.bol_payment_method ? (PAY_METHODS.find(p=>p.v===j.bol_payment_method)?.l || j.bol_payment_method) : "—"}</td>
                          <td style={{ padding:"10px 12px" }}><span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background:cs.bg, color:cs.text }}><span style={{ width:6, height:6, borderRadius:"50%", background:cs.dot }} />{cs.l}</span></td>
                          <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}><Btn onClick={() => setPayModal({ jobKey:k, amount: j.bol_collected ?? "", method: j.bol_payment_method || "", date: j.bol_collected_date || today(), notes:"", entries:[{ method:"cash", amount:"" }] })} style={{ padding:"4px 9px", fontSize:11 }}>Record payment</Btn></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pads + Deductions + Settlement */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Pads (por job)</div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead><tr style={{ color:"#aaa", fontSize:10, textTransform:"uppercase" }}>
                    <th style={{ textAlign:"left", padding:"3px 4px" }}>Job</th><th style={{ textAlign:"right", padding:"3px 4px" }}>Recib.</th><th style={{ textAlign:"right", padding:"3px 4px" }}>Devuel.</th><th style={{ textAlign:"right", padding:"3px 4px" }}>Falt.</th>
                  </tr></thead>
                  <tbody>
                    {jobsIn.map(j => { const miss = jobPadsMissing(j); return (
                      <tr key={j.id} style={{ borderTop:"1px solid #f4f4f4" }}>
                        <td style={{ padding:"3px 4px", fontFamily:"monospace" }}>{j.job_number || "-"}</td>
                        <td style={{ padding:"3px 4px", textAlign:"right" }}>{numv(j.pads_received)}</td>
                        <td style={{ padding:"3px 4px", textAlign:"right" }}>{numv(j.pads_returned)}</td>
                        <td style={{ padding:"3px 4px", textAlign:"right", color: miss>0?"#C2410C":"#111", fontWeight: miss>0?700:400 }}>{miss}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
                <div style={{ borderTop:"1px solid #eee", marginTop:8, paddingTop:8 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Total enviados</span><b>{c.padsSent}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Total devueltos</span><b>{c.padsReturned}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Total faltantes</span><b style={{ color: c.padsMissing>0?"#C2410C":"#111" }}>{c.padsMissing}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"3px 0" }}><span>Cargo por pad</span><b>{m(s.charge_per_pad != null ? s.charge_per_pad : 7)}</b></div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"6px 0 0", borderTop:"1px solid #f0f0f0", paddingTop:6 }}><span>Total pads charge</span><b>{m(c.padsCharge)}</b></div>
                </div>
              </div>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Deducciones del broker</div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Trip cost</span><b>{m(s.trip_cost)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Labor</span><b>{m(s.labor_charges)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Other fees{s.other_fees_description ? ` (${s.other_fees_description})` : ""}</span><b>{m(s.other_fees)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"6px 0 0", borderTop:"1px solid #f0f0f0", paddingTop:6 }}><span>Total deducciones</span><b>{m(c.deductions)}</b></div>
              </div>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Broker nos debe</div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0" }}><span>Carrier fee subtotal</span><b>{m(c.carrierFee)}</b></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Trip cost</span><span>{m(s.trip_cost)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Labor</span><span>{m(s.labor_charges)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Other fees</span><span>{m(s.other_fees)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, margin:"4px 0", color:"#A32D2D" }}><span>− Pads charge</span><span>{m(c.padsCharge)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:15, margin:"8px 0 0", borderTop:"1px solid #eee", paddingTop:8, fontWeight:800 }}><span>Total broker nos debe</span><span>{m(c.netCarrier)}</span></div>
              </div>
              <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px 18px" }}>
                <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Cobrado a clientes (BOL)</div>
                {jobsIn.map(j => (
                  <div key={j.id} style={{ display:"flex", justifyContent:"space-between", fontSize:12, margin:"4px 0", color:"#555" }}><span style={{ fontFamily:"monospace" }}>{j.job_number || "-"}</span><span>{money(j.bol_collected) || "$0"} / {money(j.bol_balance) || "$0"}</span></div>
                ))}
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:15, margin:"8px 0 0", borderTop:"1px solid #eee", paddingTop:8, fontWeight:800 }}><span>Total cobrado</span><span>{m(c.bolCollected)}</span></div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginTop:4, color:"#C2410C" }}><span>Pendiente</span><span>{m(c.pending)}</span></div>
              </div>
            </div>

            <div style={{ background: c.net >= 0 ? "#EAF3DE" : "#FCEBEB", border:`1px solid ${c.net >= 0 ? "#639922" : "#E24B4A"}`, borderRadius:12, padding:"18px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
              <div>
                <div style={{ fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em", color: c.net >= 0 ? "#3B6D11" : "#A32D2D" }}>Resultado neto</div>
                <div style={{ fontSize:22, fontWeight:800, color: c.net >= 0 ? "#3B6D11" : "#A32D2D", marginTop:3 }}>{c.net >= 0 ? `Broker te debe ${m(c.net)}` : `Le debés al broker ${m(-c.net)}`}</div>
              </div>
              {s.status !== "settled" && <Btn primary onClick={() => setCsStatus(s, "settled")}>Mark as settled</Btn>}
            </div>
          </>
        );
      })()}

      {/* ───────────────────────── TRUCKS ───────────────────────── */}
      {page === "trucks" && (
        <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"40px", textAlign:"center", color:"#999" }}>
          <div style={{ fontSize:36, marginBottom:10 }}>🚛</div>
          <div style={{ fontSize:15, fontWeight:600, color:"#555", marginBottom:6 }}>Gestión de flota</div>
          <div style={{ fontSize:13, maxWidth:420, margin:"0 auto", lineHeight:1.6 }}>El registro de camiones llega pronto. Por ahora los drivers se administran desde la sección Drivers y se notifican por WhatsApp.</div>
        </div>
      )}

      {/* ───────────────────────── SETTINGS ───────────────────────── */}
      {page === "settings" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14, maxWidth:640 }}>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10 }}>Cuenta</div>
            <DetailRow label="Usuario" value={userEmail} />
            <DetailRow label="Base de datos" value={SUPABASE_URL} />
            <div style={{ marginTop:14 }}><Btn onClick={() => supabase.auth.signOut()}>Cerrar sesión</Btn></div>
          </div>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10 }}>Warehouses propios</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
              {WAREHOUSES.map(w => <span key={w} style={{ background:"#f5f5f5", borderRadius:20, padding:"4px 12px", fontSize:13 }}>🏭 {w}</span>)}
            </div>
          </div>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px" }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10 }}>Base de datos</div>
            <Btn onClick={() => setShowSetup(true)}>Ver SQL de configuración (storage_jobs, brokers, balances)</Btn>
          </div>
        </div>
      )}

      {/* ───────────────────────── BILLING ───────────────────────── */}
      {page === "billing" && (
        <>
          {billingMissing && (
            <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <span>Para el módulo de billing, corré el SQL de configuración una sola vez en Supabase.</span>
              <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver SQL</button>
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:16 }}>
            {[
              { label:"Total pendiente", value:"$"+billingMetrics.pending.toLocaleString(), color:"#A32D2D" },
              { label:"Overdue", value:`${billingMetrics.overdueCount} · $${billingMetrics.overdueSum.toLocaleString()}`, color:"#A32D2D" },
              { label:"Vence esta semana", value:`${billingMetrics.weekCount} · $${billingMetrics.weekSum.toLocaleString()}`, color:"#C2410C" },
              { label:"Cobrado este mes", value:"$"+billingMetrics.collected.toLocaleString(), color:"#1A8A4E" },
            ].map(m => (
              <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
                <div style={{ fontSize:11, color:"#aaa", fontWeight:500, marginBottom:4 }}>{m.label}</div>
                <div style={{ fontSize:20, fontWeight:700, color:m.color }}>{m.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
            {[["all","Todos"],["pending","Pendientes"],["overdue","Overdue"],["paid","Pagados"]].map(([t,l]) => (
              <button key={t} onClick={() => setBillingTab(t)}
                style={{ fontSize:13, fontWeight: billingTab === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: billingTab === t ? "#111" : "#999", borderBottom: billingTab === t ? "2px solid #111" : "2px solid transparent" }}>{l}</button>
            ))}
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["Estado","Cliente","Job #","Storage","Días en storage","Período","Monto","Acciones"].map((h,i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const rows = billingRows.filter(b => billingTab === "all" || b.status === billingTab);
                    if (rows.length === 0) return <tr><td colSpan={8} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{billingMissing ? "Corré el SQL para activar billing." : "Sin registros de billing."}</td></tr>;
                    return rows.map(b => (
                      <tr key={b.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px" }}><BillingBadge status={b.status} /></td>
                        <td style={{ padding:"12px" }}>{b.customer}</td>
                        <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{b.job_number}</td>
                        <td style={{ padding:"12px", fontSize:12, color:"#555" }}>{b.location}</td>
                        <td style={{ padding:"12px" }}>{b.daysIn != null ? `${b.daysIn} días` : "—"}</td>
                        <td style={{ padding:"12px", fontSize:12, color:"#555", whiteSpace:"nowrap" }}>{b.billing_period_start || "—"} → {b.billing_period_end || "—"}</td>
                        <td style={{ padding:"12px", fontWeight:600 }}>${Number(b.amount || 0).toLocaleString()}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                            {b.status !== "paid"
                              ? <Btn onClick={() => markBillingPaid(b)} style={{ padding:"4px 9px", fontSize:11 }}>Marcar pagado</Btn>
                              : <span style={{ fontSize:11, color:"#888" }}>{b.paid_date ? `Pagado ${b.paid_date}` : "Pagado"}</span>}
                            {b.status !== "paid" && <a href={billingReminderLink(b)} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E", textDecoration:"none", fontSize:12 }}>💬 Recordatorio</a>}
                          </div>
                        </td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{billingRows.filter(b => billingTab === "all" || b.status === billingTab).length} registro(s)</div>
          </div>
        </>
      )}

      {/* ───────────────────────── ANALYTICS ───────────────────────── */}
      {page === "analytics" && (
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:20 }}>
        {[
          { label:"Jobs activos", value:metrics.activeJobs, color:"#3B6D11" },
          { label:"Entregados", value:metrics.deliveredJobs, color:"#888" },
          { label:"Unidades", value:metrics.units, color:"#111" },
          { label:"Unidades ocupadas", value:metrics.occupied, color:"#185FA5" },
          { label:"Pagos urgentes", value:urgentPayments, color:"#A32D2D" },
          { label:"Overdue FADD", value:faddStats.overdue, color:"#A32D2D" },
          { label:"Due this week", value:faddStats.dueWeek, color:"#C2410C" },
          { label:"Costo mensual", value:"$"+metrics.totalCost.toLocaleString(), color:"#185FA5" },
          { label:"Estados USA", value:metrics.states, color:"#888" },
        ].map(m => (
          <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
            <div style={{ fontSize:11, color:"#aaa", fontWeight:500, marginBottom:4 }}>{m.label}</div>
            <div style={{ fontSize:22, fontWeight:700, color:m.color }}>{m.value}</div>
          </div>
        ))}
      </div>
      )}

      {/* ANALYTICS CHARTS */}
      {page === "analytics" && (
        <div style={{ marginBottom:20 }}>

          {/* Fila 1: Aperturas vs Cierres + Costo por mes */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Aperturas vs cierres por mes</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Evolucion mensual de tu operacion</div>
              {(() => {
                const monthNames = {"01":"Ene","02":"Feb","03":"Mar","04":"Abr","05":"May","06":"Jun","07":"Jul","08":"Ago","09":"Sep","10":"Oct","11":"Nov","12":"Dic"};
                const opens = records.reduce((acc,r)=>{ if(r.date_opened){ const m=r.date_opened.slice(0,7); acc[m]=(acc[m]||0)+1; } return acc; },{});
                const months = Object.keys(opens).sort().slice(-8);
                const maxVal = Math.max(...months.map(m=>opens[m]||0), 1);
                return months.map(month => {
                  const [year, m] = month.split("-");
                  const label = `${monthNames[m]} ${year.slice(2)}`;
                  const openCount = opens[month]||0;
                  return (
                    <div key={month} style={{ marginBottom:10 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4 }}>
                        <span style={{ fontWeight:500 }}>{label}</span>
                        <span style={{ color:"#3B6D11" }}>+{openCount} abiertos</span>
                      </div>
                      <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                        <div style={{ background:"#3B6D11", borderRadius:6, height:8, width:`${(openCount/maxVal)*100}%`, transition:"width .4s" }} />
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Gasto mensual por empresa</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Cuanto le pagas a cada cadena de storages</div>
              {(() => {
                const byBrand = records.filter(r=>sit(r)==="Open" && r.monthly_cost && r.brand).reduce((acc,r)=>{ const b=r.brand.trim(); acc[b]=(acc[b]||0)+Number(r.monthly_cost); return acc; },{});
                const sorted = Object.entries(byBrand).sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                if(!sorted.length) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Carga costos para ver este grafico</p>;
                return sorted.map(([brand,cost]) => (
                  <div key={brand} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                      <span style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"65%" }}>{brand}</span>
                      <span style={{ fontSize:13, color:"#888", flexShrink:0 }}>${Number(cost).toLocaleString()}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                      <div style={{ background:"#A32D2D", borderRadius:6, height:8, width:`${(cost/max)*100}%`, transition:"width .4s" }} />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Fila 2: Storages por estado + Costo por estado */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Storages activos por estado</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Donde tenes mas exposicion operativa</div>
              {(() => {
                const byState = records.filter(r=>sit(r)==="Open").reduce((acc,r)=>{ if(r.state){acc[r.state]=(acc[r.state]||0)+1;} return acc; },{});
                const sorted = Object.entries(byState).sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                return sorted.map(([state,count]) => (
                  <div key={state} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                      <span style={{ fontSize:13, fontWeight:500 }}>{state}</span>
                      <span style={{ fontSize:13, color:"#888" }}>{count}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                      <div style={{ background:"#3B6D11", borderRadius:6, height:8, width:`${(count/max)*100}%`, transition:"width .4s" }} />
                    </div>
                  </div>
                ));
              })()}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Costo mensual por estado</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Donde gastas mas dinero en storages</div>
              {(() => {
                const byCost = records.filter(r=>sit(r)==="Open" && r.monthly_cost && r.state).reduce((acc,r)=>{ acc[r.state]=(acc[r.state]||0)+Number(r.monthly_cost); return acc; },{});
                const sorted = Object.entries(byCost).sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                if(!sorted.length) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Carga costos para ver este grafico</p>;
                return sorted.map(([state,cost]) => (
                  <div key={state} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                      <span style={{ fontSize:13, fontWeight:500 }}>{state}</span>
                      <span style={{ fontSize:13, color:"#888" }}>${Number(cost).toLocaleString()}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                      <div style={{ background:"#185FA5", borderRadius:6, height:8, width:`${(cost/max)*100}%`, transition:"width .4s" }} />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* CRM charts: revenue by broker + jobs by status */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Revenue por broker</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Estimate total de jobs por broker</div>
              {(() => {
                const num = v => (v && !isNaN(Number(v))) ? Number(v) : 0;
                const map = new Map(); const seen = new Set();
                for (const j of jobs) { const k = jobKey(j); if (seen.has(k)) continue; seen.add(k); if (!j.broker_id) continue; map.set(j.broker_id, (map.get(j.broker_id)||0) + (num(j.estimate) || num(j.pickup_balance)+num(j.delivery_balance))); }
                const sorted = [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                if (!sorted.length) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Cargá brokers y estimates para ver esto</p>;
                return sorted.map(([bid,val]) => (
                  <div key={bid} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:5 }}>
                      <span style={{ fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"65%" }}>{brokerName(bid) || `#${bid}`}</span>
                      <span style={{ color:"#888" }}>${val.toLocaleString()}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}><div style={{ background:"#185FA5", borderRadius:6, height:8, width:`${(val/max)*100}%` }} /></div>
                  </div>
                ));
              })()}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Jobs por estado</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Distribución de jobs activos e históricos</div>
              {(() => {
                const counts = {}; const seen = new Set();
                for (const j of jobs) { const k = jobKey(j); if (seen.has(k)) continue; seen.add(k); const s = j.status || "scheduled"; counts[s] = (counts[s]||0)+1; }
                const total = Object.values(counts).reduce((a,b)=>a+b,0);
                if (!total) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Sin jobs</p>;
                let acc = 0; const segs = [];
                for (const st of STATUSES) { const c = counts[st.v]||0; if (!c) continue; const from = acc/total*360; acc += c; const to = acc/total*360; segs.push(`${st.dot} ${from}deg ${to}deg`); }
                return (
                  <div style={{ display:"flex", alignItems:"center", gap:18 }}>
                    <div style={{ width:120, height:120, borderRadius:"50%", flexShrink:0, background:`conic-gradient(${segs.join(",")})`, position:"relative" }}>
                      <div style={{ position:"absolute", inset:18, background:"#fff", borderRadius:"50%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
                        <div style={{ fontSize:22, fontWeight:800 }}>{total}</div><div style={{ fontSize:10, color:"#aaa" }}>jobs</div>
                      </div>
                    </div>
                    <div style={{ flex:1 }}>
                      {STATUSES.filter(st => counts[st.v]).map(st => (
                        <div key={st.v} style={{ display:"flex", alignItems:"center", gap:7, fontSize:12, marginBottom:5 }}>
                          <span style={{ width:9, height:9, borderRadius:2, background:st.dot }} />
                          <span style={{ flex:1 }}>{st.l}</span>
                          <span style={{ color:"#888", fontWeight:600 }}>{counts[st.v]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* CRM charts: CF per month + top drivers */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>CF movidos por mes</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Volumen total (pies cúbicos) por mes</div>
              {(() => {
                const by = {}; const seen = new Set();
                for (const j of jobs) { const k = jobKey(j); if (seen.has(k)) continue; seen.add(k); const d = j.pickup_date || j.date_in; if (!d) continue; const m = d.slice(0,7); by[m] = (by[m]||0) + parseCf(j.volume); }
                const months = Object.keys(by).sort().slice(-8);
                const max = Math.max(...months.map(m=>by[m]), 1);
                if (!months.length) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Sin datos de volumen</p>;
                return (
                  <div style={{ display:"flex", alignItems:"flex-end", gap:8, height:140 }}>
                    {months.map(m => (
                      <div key={m} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:5 }}>
                        <div style={{ fontSize:9, color:"#888" }}>{Math.round(by[m]).toLocaleString()}</div>
                        <div style={{ width:"100%", background:"#3B6D11", borderRadius:"4px 4px 0 0", height:`${Math.max(4,(by[m]/max)*110)}px` }} />
                        <div style={{ fontSize:9, color:"#aaa" }}>{m.slice(5)}/{m.slice(2,4)}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Top drivers</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Por jobs entregados</div>
              {(() => {
                const counts = {}; const seen = new Set();
                for (const j of jobs) { if (!j.date_out) continue; const k = jobKey(j); if (seen.has(k)) continue; seen.add(k); const names = (jobDriverNames(j) || "").split(",").map(s=>s.trim()).filter(Boolean); for (const n of names) counts[n] = (counts[n]||0)+1; }
                const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                if (!sorted.length) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Sin entregas todavía</p>;
                return sorted.map(([name,c]) => (
                  <div key={name} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:5 }}>
                      <span style={{ fontWeight:500 }}>{name}</span><span style={{ color:"#888" }}>{c}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}><div style={{ background:"#7C3AED", borderRadius:6, height:8, width:`${(c/max)*100}%` }} /></div>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Panel IA */}
          <AIPanel records={records} />

        </div>
      )}

      <datalist id="drivers-list">{drivers.map(d => <option key={d} value={d} />)}</datalist>
      <datalist id="brands-list">{brands.map(b => <option key={b} value={b} />)}</datalist>
      <datalist id="states-list">{US_STATES.map(s => <option key={s} value={s} />)}</datalist>
      <datalist id="sticker-colors-list">{STICKER_COLORS.map(c => <option key={c} value={c} />)}</datalist>
      <datalist id="sizes-list">{sizes.map(s => <option key={s} value={s} />)}</datalist>

      {page === "storage" && (
        <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
          {[["storage_units","Storage Units"], ...WAREHOUSES.map(w => [w, `🏭 ${w}`])].map(([t,l]) => (
            <button key={t} onClick={() => setStorageTab(t)}
              style={{ fontSize:13, fontWeight: storageTab === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: storageTab === t ? "#111" : "#999", borderBottom: storageTab === t ? "2px solid #111" : "2px solid transparent" }}>{l}</button>
          ))}
        </div>
      )}

      {/* Nested tabs inside Storage Units */}
      {page === "storage" && storageTab === "storage_units" && (
        <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14 }}>
          {[["units","Unidades"],["unit_jobs","Jobs en unidades"]].map(([t,l]) => (
            <button key={t} onClick={() => setUnitsSubTab(t)}
              style={{ fontSize:13, padding:"6px 14px", borderRadius:7, cursor:"pointer", border:"none", background: unitsSubTab === t ? "#fff" : "none", color: unitsSubTab === t ? "#111" : "#888", fontWeight: unitsSubTab === t ? 600 : 400, boxShadow: unitsSubTab === t ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>{l}</button>
          ))}
        </div>
      )}

      {/* JOBS EN UNIDADES — active jobs stored in rented units, one row per unit */}
      {page === "storage" && storageTab === "storage_units" && unitsSubTab === "unit_jobs" && (
        <>
          <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por job #, cliente, driver, empresa, unidad..."
              style={{ ...inp, flex:1, minWidth:180 }} />
          </div>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                    {["Empresa","Unidad","Ubicación","Job #","Cliente","Volumen","Lot #","Sticker","Driver","FADD","Estado",""].map((h,i) => (
                      <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {unitJobRows.length === 0 ? (
                    <tr><td colSpan={12} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin jobs activos en unidades alquiladas.</td></tr>
                  ) : unitJobRows.map(j => {
                    const s = j.storage || {};
                    return (
                      <tr key={j.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", fontWeight:600 }}>{s.brand || "—"}</td>
                        <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12 }}>{s.unit || "—"}</td>
                        <td style={{ padding:"12px", fontSize:12, color:"#555" }}>{[s.address, s.state, s.zip].filter(Boolean).join(", ") || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <button onClick={() => setJobDetailKey(jobKey(j))} style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                        </td>
                        <td style={{ padding:"12px" }}>{j.customer || "—"}</td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{j.volume || "—"}</td>
                        <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{j.lot_number || "—"}</td>
                        <td style={{ padding:"12px" }}><Sticker color={j.sticker_color} /></td>
                        <td style={{ padding:"12px" }}>{j.driver || "—"}</td>
                        <td style={{ padding:"12px" }}><FaddBadge fadd={j.fadd} /></td>
                        <td style={{ padding:"12px" }}><StatusBadge status={j.status} /></td>
                        <td style={{ padding:"12px", textAlign:"right" }}>
                          <span onClick={() => { setJobDetailKey(null); setDetailId(j.storage_id); }} style={{ fontSize:12, color:"#185FA5", cursor:"pointer", textDecoration:"underline", whiteSpace:"nowrap" }}>Ver unidad</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{unitJobRows.length} job(s) en unidades</div>
          </div>
        </>
      )}

      {/* WAREHOUSE (owned) — one tab per warehouse: occupancy header + jobs table */}
      {page === "storage" && WAREHOUSES.includes(storageTab) && (() => {
        const name = storageTab;
        const meta = warehouseMeta[name];
        const cap = meta && meta.total_capacity_cf != null ? Number(meta.total_capacity_cf) : null;
        const used = usedCfByWarehouse[name] || 0;
        const free = cap != null ? Math.max(0, cap - used) : null;
        const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
        const inside = jobs.filter(j => !j.date_out && j.warehouse === name);
        const byJob = []; const seen = new Set();
        for (const j of inside) { const k = jobKey(j); if (!seen.has(k)) { seen.add(k); byJob.push(j); } }
        return (
          <>
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"18px 20px", marginBottom:14 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap", marginBottom:14 }}>
                <div>
                  <div style={{ fontSize:18, fontWeight:700 }}>🏭 {name}</div>
                  <div style={{ fontSize:12, color:"#999" }}>Warehouse propio · {byJob.length} job(s) activo(s)</div>
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn primary disabled={!dbReady} onClick={() => openAddJobWarehouse(name)} style={{ padding:"7px 14px" }}>+ Job a este warehouse</Btn>
                  <Btn onClick={() => openCapacity({ kind:"warehouse", name, value: cap != null ? String(cap) : "" })} style={{ padding:"7px 14px" }}>Editar capacidad</Btn>
                </div>
              </div>
              {cap != null ? (
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:6 }}>
                    <span style={{ fontWeight:700, color:occColor(pct) }}>{pct}% ocupado</span>
                    <span style={{ color:"#888" }}>{Math.round(used).toLocaleString()} usado · {Math.round(free).toLocaleString()} libre · {cap.toLocaleString()} CF total</span>
                  </div>
                  <div style={{ background:"#f0f0f0", borderRadius:8, height:16, overflow:"hidden" }}>
                    <div style={{ background:occColor(pct), height:16, width:`${pct}%`, transition:"width .4s" }} />
                  </div>
                </div>
              ) : (
                <div style={{ fontSize:13, color:"#999", display:"flex", alignItems:"center", gap:8 }}>
                  Capacidad sin configurar · {Math.round(used).toLocaleString()} CF en uso.
                  <span onClick={() => openCapacity({ kind:"warehouse", name, value:"" })} style={{ color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>Configurar capacidad</span>
                </div>
              )}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead>
                    <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                      {["Job #","Cliente","Lot #","Sticker","Volumen","Driver","FADD","Estado",""].map((h,i) => (
                        <th key={i} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {byJob.length === 0 ? (
                      <tr><td colSpan={9} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin jobs activos en este warehouse.</td></tr>
                    ) : byJob.map(j => (
                      <tr key={j.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                          <button onClick={() => setJobDetailKey(jobKey(j))} style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                        </td>
                        <td style={{ padding:"12px" }}>{j.customer || "—"}</td>
                        <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{j.lot_number || "—"}</td>
                        <td style={{ padding:"12px" }}><Sticker color={j.sticker_color} /></td>
                        <td style={{ padding:"12px", whiteSpace:"nowrap" }}>{j.volume || "—"}</td>
                        <td style={{ padding:"12px" }}>{j.driver || "—"}</td>
                        <td style={{ padding:"12px" }}><FaddBadge fadd={j.fadd} /></td>
                        <td style={{ padding:"12px" }}><StatusBadge status={j.status} /></td>
                        <td style={{ padding:"12px", textAlign:"right" }}>
                          <span onClick={() => setJobDetailKey(jobKey(j))} style={{ fontSize:12, color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>Ver</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>{byJob.length} job(s) en {name}</div>
            </div>
          </>
        );
      })()}

      {page === "jobs" && (
        <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
          {[["active","Activos"],["delivered","Entregados"],
            ...WAREHOUSES.map(w => [`wh:${w}`, `Warehouse ${w}`])].map(([t,l]) => (
            <button key={t} onClick={() => setTab(t)} style={tabStyle(t)}>{l}</button>
          ))}
        </div>
      )}

      {((page === "storage" && storageTab === "storage_units" && unitsSubTab === "units") || page === "jobs") && (<>
      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder={page === "storage" ? "Buscar empresa, ubicación, zip, unidad..." : "Buscar por job #, cliente, driver, zip, ubicación..."}
          style={{ ...inp, flex:1, minWidth:180 }} />
        {page !== "storage" && (
          <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={{ ...inp, minWidth:150 }}>
            <option value="">Todos los drivers</option>
            {drivers.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inp, minWidth:150 }}>
          <option value="date-desc">Mas reciente</option>
          <option value="date-asc">Mas antiguo</option>
          <option value="customer">Cliente A-Z</option>
          <option value="driver">Driver A-Z</option>
        </select>
      </div>

      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          {page === "storage" ? (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13, tableLayout:"fixed" }}>
              <colgroup>
                <col style={{width:120}}/><col style={{width:55}}/><col style={{width:70}}/><col style={{width:150}}/>
                <col style={{width:65}}/><col style={{width:110}}/><col style={{width:100}}/><col style={{width:85}}/><col style={{width:75}}/><col style={{width:80}}/><col style={{width:140}}/>
              </colgroup>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Empresa","Estado","Zip","Direccion","Unidad","Gate Code","Apertura","Payment","Jobs activos","Situacion","Ocupación"].map(h => (
                    <th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unitRows.length === 0 ? (
                  <tr><td colSpan={11} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin unidades</td></tr>
                ) : unitRows.map(r => {
                  const n = activeJobsByStorage[r.id] || 0;
                  const cap = r.total_capacity_cf != null ? Number(r.total_capacity_cf) : null;
                  const used = usedCfByStorage[r.id] || 0;
                  return (
                    <tr key={r.id} onClick={() => setDetailId(r.id)}
                      style={{ borderBottom:"1px solid #fafafa", cursor:"pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background="#fafafa"}
                      onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                      <td style={{ padding:"10px 12px", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.brand||"—"}</td>
                      <td style={{ padding:"10px 12px" }}>{r.state||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>{r.zip||"—"}</td>
                      <td style={{ padding:"10px 12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.address||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>{r.unit||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:11 }}>
                        <span style={{ display:"inline-flex", alignItems:"center", maxWidth:"100%" }}>
                          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.gate_code||"—"}</span>
                          {r.gate_code && <CopyButton value={r.gate_code} />}
                        </span>
                      </td>
                      <td style={{ padding:"10px 12px", fontSize:12, color:"#555", whiteSpace:"nowrap" }}>{r.date_opened||"—"}</td>
                      <td style={{ padding:"10px 12px" }}><PaymentBadge record={r} situation={sit(r)} /></td>
                      <td style={{ padding:"10px 12px" }}>
                        <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: n>0?"#EAF3DE":"#f5f5f5", color: n>0?"#3B6D11":"#bbb" }}>{n}</span>
                      </td>
                      <td style={{ padding:"10px 12px" }}><Badge situation={sit(r)} /></td>
                      <td style={{ padding:"10px 12px" }} onClick={e => e.stopPropagation()}>
                        {cap != null ? <OccupancyBar used={used} total={cap} />
                          : <Btn onClick={() => openCapacity({ kind:"unit", id:r.id, value:"" })} style={{ padding:"4px 9px", fontSize:11 }}>Set capacity</Btn>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Job #","Cliente","Lot #","Sticker","Volumen","Empresa","Ubicación","Zip","Driver","Map", tab==="delivered"?"Entregado":""].filter(Boolean).map(h => (
                    <th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                  <th style={{ width:150 }} />
                </tr>
              </thead>
              <tbody>
                {jobGroups.length === 0 ? (
                  <tr><td colSpan={12} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{tab==="delivered" ? "Sin jobs entregados" : "Sin jobs activos. Cargá uno con \"+ Nuevo job\"."}</td></tr>
                ) : jobGroups.map(g => {
                  const empresas = [...new Set(g.parts.map(p => p.storage?.brand).filter(Boolean))];
                  const locs = [...new Set(g.parts.map(p => p.warehouse ? `Warehouse ${p.warehouse}` : p.storage?.address).filter(Boolean))];
                  const zips = [...new Set(g.parts.map(p => p.storage?.zip).filter(Boolean))];
                  const mapHref = routeUrl(g);
                  return (
                  <tr key={g.key} style={{ borderBottom:"1px solid #fafafa", verticalAlign:"top" }}>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      <button onClick={() => setJobDetailKey(g.key)}
                        style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>
                        {g.job_number || "(ver)"}
                      </button>
                    </td>
                    <td style={{ padding:"12px" }}>{g.customer||"—"}</td>
                    <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{g.lot_number||"—"}</td>
                    <td style={{ padding:"12px" }}><Sticker color={g.sticker_color} /></td>
                    <td style={{ padding:"12px" }}>{g.volume||"—"}</td>
                    <td style={{ padding:"12px", fontWeight:500 }}>{empresas.length ? empresas.join(", ") : "—"}</td>
                    <td style={{ padding:"12px", fontSize:12, color:"#555" }}>
                      {locs.length ? locs.map((a, i) => <div key={i} style={{ marginBottom: i < locs.length-1 ? 3 : 0 }}>{a}</div>) : "—"}
                    </td>
                    <td style={{ padding:"12px", fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{zips.length ? zips.join(", ") : "—"}</td>
                    <td style={{ padding:"12px" }}>{g.driver||"—"}</td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      {mapHref ? <a href={mapHref} target="_blank" rel="noreferrer" style={{ color:"#185FA5", textDecoration:"none", fontSize:13 }}>🗺️ Ruta</a> : "—"}
                    </td>
                    {tab === "delivered" ? (
                      <>
                        <td style={{ padding:"12px", fontSize:12, color:"#888", whiteSpace:"nowrap" }}>{g.parts.map(p => p.date_out).filter(Boolean)[0] || "—"}</td>
                        <td style={{ padding:"12px", textAlign:"right" }}>
                          <Btn onClick={() => undeliverJobs(g.parts.map(p => p.id))} style={{ padding:"5px 10px", fontSize:12 }}>Desentregar</Btn>
                        </td>
                      </>
                    ) : (
                      <td style={{ padding:"12px", textAlign:"right" }}>
                        <Btn onClick={() => deliverJobs(g.parts.map(p => p.id))} style={{ padding:"5px 10px", fontSize:12 }}>Marcar entregado</Btn>
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>
          {page === "storage" ? `${unitRows.length} de ${records.length} unidades` : `${jobGroups.length} job(s)`}
        </div>
      </div>
      </>)}

      </div>{/* end page content */}

      {jobDetail && (
        <Modal title={`Job ${jobDetail.job_number || ""}`.trim()} onClose={() => setJobDetailKey(null)}
          footer={<>
            <Btn onClick={() => openEditJob(jobDetail)}>Editar</Btn>
            <Btn onClick={() => window.open(waLink(jobDetail, (jobDetail.parts||[]).map(p => p.warehouse ? `Warehouse ${p.warehouse}` : [p.storage?.brand, p.storage?.unit && "U"+p.storage.unit, p.storage?.state].filter(Boolean).join(" ")).filter(Boolean).join(" · "), brokerName(jobDetail.broker_id), jobGroupLink(jobDetail)), "_blank")}>💬 WhatsApp</Btn>
            {nextStatus(jobDetail) && <Btn onClick={() => advanceStatus(jobDetail)}>→ {statusMeta(nextStatus(jobDetail)).l}</Btn>}
            {jobDetail.parts.some(p => !p.date_out) && (
              <Btn onClick={() => deliverJobs(jobDetail.parts.filter(p => !p.date_out).map(p => p.id))}>Marcar todo entregado</Btn>
            )}
            {jobDetail.parts.some(p => p.date_out) && (
              <Btn onClick={() => undeliverJobs(jobDetail.parts.filter(p => p.date_out).map(p => p.id))}>Desentregar todo</Btn>
            )}
            <Btn primary onClick={() => setJobDetailKey(null)}>Cerrar</Btn>
          </>}>
          <SectionLabel>Datos del job <span style={{ textTransform:"none", letterSpacing:0, fontWeight:400, color:"#bbb" }}>· click para editar</span></SectionLabel>
          {(() => { const P = jobDetail.parts; const set = (f) => (v) => updateJobField(P, f, v); return (
          <>
          <EditRow label="Job #"><InlineField mono value={jobDetail.job_number} onSave={set("job_number")} /></EditRow>
          <EditRow label="Cliente"><InlineField value={jobDetail.customer} onSave={set("customer")} /></EditRow>
          <EditRow label="Broker">
            <select value={jobDetail.broker_id || ""} onChange={e => set("broker_id")(e.target.value ? Number(e.target.value) : "")}
              style={{ fontSize:13, padding:"4px 8px", borderRadius:8, border:"1px solid #e5e5e5", outline:"none", background:"#fff" }}>
              <option value="">— Sin broker —</option>
              {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </EditRow>
          <EditRow label="Tipo"><TypeBadge type={jobDetail.job_type} /></EditRow>
          <EditRow label="Estado"><span style={{ display:"inline-flex", alignItems:"center", gap:8 }}><StatusBadge status={jobDetail.status} />{nextStatus(jobDetail) && <button onClick={() => advanceStatus(jobDetail)} style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:7, border:"1px solid #e5e5e5", background:"#fff", cursor:"pointer" }}>→ {statusMeta(nextStatus(jobDetail)).l}</button>}</span></EditRow>
          <EditRow label="Driver (quién lo dejó)"><InlineField listId="drivers-list" value={jobDetail.driver} onSave={set("driver")} /></EditRow>
          <EditRow label="Volumen (CF)"><InlineField value={jobDetail.volume} onSave={set("volume")} /></EditRow>
          <EditRow label="Lot number (sticker)"><InlineField mono value={jobDetail.lot_number} onSave={set("lot_number")} /></EditRow>
          <EditRow label="Color del sticker"><InlineField type="text" listId="sticker-colors-list" value={jobDetail.sticker_color} onSave={set("sticker_color")} display={jobDetail.sticker_color ? <Sticker color={jobDetail.sticker_color} /> : null} /></EditRow>
          <EditRow label="FADD"><InlineField type="date" value={jobDetail.fadd} onSave={set("fadd")} display={<FaddBadge fadd={jobDetail.fadd} />} /></EditRow>
          <EditRow label="Pick up from"><InlineField type="date" value={jobDetail.pickup_date_from || jobDetail.pickup_date} onSave={(v) => { updateJobField(P, "pickup_date_from", v); updateJobField(P, "pickup_date", v); }} /></EditRow>
          <EditRow label="Pick up to (opcional)"><InlineField type="date" value={jobDetail.pickup_date_to} onSave={set("pickup_date_to")} /></EditRow>
          <EditRow label="Pickup address"><InlineField value={jobDetail.pickup_address} onSave={set("pickup_address")} /></EditRow>
          <EditRow label="Pickup city"><InlineField value={jobDetail.pickup_city} onSave={set("pickup_city")} /></EditRow>
          <EditRow label="Pickup estado"><InlineField listId="states-list" transform={v => v.toUpperCase()} value={jobDetail.pickup_state} onSave={set("pickup_state")} /></EditRow>
          <EditRow label="Pickup zip"><InlineField value={jobDetail.pickup_zip} onSave={set("pickup_zip")} /></EditRow>
          <EditRow label="Balance pickup ($)"><InlineField value={jobDetail.pickup_balance} onSave={set("pickup_balance")} display={money(jobDetail.pickup_balance)} /></EditRow>
          <EditRow label="Date in (a storage)"><InlineField type="date" value={jobDetail.date_in} onSave={set("date_in")} /></EditRow>
          <EditRow label="Delivery date"><InlineField type="date" value={jobDetail.delivery_date} onSave={set("delivery_date")} /></EditRow>
          <EditRow label="Delivery address"><InlineField value={jobDetail.delivery_address} onSave={set("delivery_address")} /></EditRow>
          <EditRow label="Delivery city"><InlineField value={jobDetail.delivery_city} onSave={set("delivery_city")} /></EditRow>
          <EditRow label="Delivery estado"><InlineField listId="states-list" transform={v => v.toUpperCase()} value={jobDetail.delivery_state} onSave={set("delivery_state")} /></EditRow>
          <EditRow label="Delivery zip"><InlineField value={jobDetail.delivery_zip} onSave={set("delivery_zip")} /></EditRow>
          <EditRow label="Balance delivery ($)"><InlineField value={jobDetail.delivery_balance} onSave={set("delivery_balance")} display={money(jobDetail.delivery_balance)} /></EditRow>
          {routeUrl(jobDetail) && (
            <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}>
              <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>Ruta</span>
              <a href={routeUrl(jobDetail)} target="_blank" rel="noreferrer" style={{ fontWeight:500, color:"#185FA5", textDecoration:"none" }}>🗺️ Ver ruta storage → delivery en Google Maps</a>
            </div>
          )}
          <EditRow label="Billing al cliente">
            {jobDetail.billing_active
              ? <span style={{ color:"#3B6D11", fontWeight:600 }}>Activo · {money(jobDetail.client_monthly_rate) || "$0"}/mes{jobDetail.first_month_free ? " · 1er mes gratis" : ""}{jobDetail.billing_start_date ? ` · desde ${jobDetail.billing_start_date}` : ""}</span>
              : <span style={{ color:"#bbb" }}>No se cobra storage</span>}
          </EditRow>
          <EditRow label="Notas"><InlineField value={jobDetail.notes} onSave={set("notes")} /></EditRow>
          </>
          ); })()}

          {!settlementsMissing && (
            <>
              <SectionLabel>Carrier Settlement</SectionLabel>
              {(() => {
                const linkedId = jobDetail.closing_sheet_id;
                const linked = linkedId ? closingSheets.find(s => s.id === Number(linkedId)) : null;
                const openSheets = closingSheets.filter(s => s.status === "open");
                const selStyle = { fontSize:12, padding:"4px 8px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff" };
                const onMove = (v) => {
                  if (!v) return;
                  if (v === "__unlink") updateJobBol(jobDetail.key, "closing_sheet_id", "");
                  else if (v === "__new") addJobToNewSheet(jobDetail.key, jobDetail.broker_id);
                  else updateJobBol(jobDetail.key, "closing_sheet_id", Number(v));
                };
                return (
                  <EditRow label="Closing sheet">
                    {linked ? (
                      <span style={{ display:"inline-flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                        <button onClick={() => { setJobDetailKey(null); setPage("settlements"); setCsDetailId(linked.id); }} style={{ fontFamily:"monospace", fontWeight:700, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>#{linked.closing_sheet_number || linked.id}</button>
                        <CSBadge status={linked.status} />
                        <select value="" onChange={e => onMove(e.target.value)} style={selStyle}>
                          <option value="">Mover…</option>
                          {openSheets.filter(s => s.id !== linked.id).map(s => <option key={s.id} value={String(s.id)}>→ #{s.closing_sheet_number || s.id}</option>)}
                          <option value="__new">→ ➕ Nuevo</option>
                          <option value="__unlink">Quitar del closing sheet</option>
                        </select>
                      </span>
                    ) : (
                      <select value="" onChange={e => onMove(e.target.value)} style={selStyle}>
                        <option value="">+ Agregar a closing sheet…</option>
                        {openSheets.map(s => <option key={s.id} value={String(s.id)}>#{s.closing_sheet_number || s.id} · {brokerName(s.broker_id) || "sin broker"}</option>)}
                        <option value="__new">➕ Crear nuevo</option>
                      </select>
                    )}
                  </EditRow>
                );
              })()}
              {(() => { const P = jobDetail.parts; return (<>
                <EditRow label="Carrier rate / CF"><InlineField value={jobDetail.carrier_rate_per_cf} onSave={(v) => updateJobField(P, "carrier_rate_per_cf", v === "" ? null : Number(v))} display={money(jobDetail.carrier_rate_per_cf)} /></EditRow>
                <EditRow label="Carrier fee (auto)"><span style={{ fontWeight:600 }}>{money(parseCf(jobDetail.volume) * numv(jobDetail.carrier_rate_per_cf)) || "$0"}</span></EditRow>
                <EditRow label="BOL balance a cobrar"><InlineField value={jobDetail.bol_balance} onSave={(v) => updateJobField(P, "bol_balance", v === "" ? null : Number(v))} display={money(jobDetail.bol_balance)} /></EditRow>
                <EditRow label="BOL cobrado">
                  <span style={{ display:"inline-flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontWeight:600, color:"#1A8A4E" }}>{money(jobDetail.bol_collected) || "$0"}</span>
                    {(() => { const cs = collectionStatus(jobDetail); return <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:20, background:cs.bg, color:cs.text }}><span style={{ width:6, height:6, borderRadius:"50%", background:cs.dot }} />{cs.l}</span>; })()}
                    <Btn onClick={() => setPayModal({ jobKey:jobDetail.key, amount: jobDetail.bol_collected ?? "", method: jobDetail.bol_payment_method || "", date: jobDetail.bol_collected_date || today(), notes:"", entries:[{ method:"cash", amount:"" }] })} style={{ padding:"3px 9px", fontSize:11 }}>Record payment</Btn>
                  </span>
                </EditRow>
              </>); })()}
            </>
          )}

          <SectionLabel>{jobDetail.parts.length === 1 ? "Dónde está guardado" : `Dónde está guardado (${jobDetail.parts.length})`}</SectionLabel>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {jobDetail.parts.map(p => {
              const s = p.storage || {};
              const delivered = !!p.date_out;
              const isWh = !!p.warehouse;
              return (
                <div key={p.id} style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", background: delivered ? "#fafafa" : "#fff" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <span style={jobBadgeStyle(delivered)}>
                      <span style={{ width:6, height:6, borderRadius:"50%", background: delivered ? "#bbb" : "#639922" }} />
                      {delivered ? "Entregado" : "Activo"}
                    </span>
                    <strong style={{ fontSize:13 }}>{isWh ? `🏭 Warehouse ${p.warehouse}` : (s.brand || "Unidad")}</strong>
                    <span style={{ flex:1 }} />
                    {!delivered
                      ? <Btn onClick={() => deliverJobs([p.id])} style={{ padding:"4px 10px", fontSize:12 }}>Marcar entregado</Btn>
                      : <Btn onClick={() => undeliverJobs([p.id])} style={{ padding:"4px 10px", fontSize:12 }}>Desentregar</Btn>}
                  </div>
                  <div style={{ fontSize:13, color:"#444", display:"flex", flexDirection:"column", gap:3 }}>
                    {isWh ? (
                      <div>📍 Warehouse propio — {p.warehouse}</div>
                    ) : (
                      <>
                        {s.address && <div>📍 {s.address}</div>}
                        <div>Unidad: <strong style={{ fontFamily:"monospace" }}>{s.unit || "—"}</strong></div>
                        {s.gate_code && (
                          <div style={{ display:"inline-flex", alignItems:"center" }}>Gate code: <span style={{ fontFamily:"monospace", marginLeft:4 }}>{s.gate_code}</span><CopyButton value={s.gate_code} /></div>
                        )}
                      </>
                    )}
                    <div style={{ color:"#888" }}>In: {p.date_in || "—"}{delivered ? ` · Out: ${p.date_out}` : ""}</div>
                  </div>
                  {!isWh && (
                    <div style={{ marginTop:6 }}>
                      <span onClick={() => { setJobDetailKey(null); setDetailId(p.storage_id); }}
                        style={{ fontSize:12, color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>Ver unidad completa →</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <AuditInfo rec={jobDetail} />
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.brand||"Unidad"}${detail.unit ? " — "+detail.unit : ""}${detail.state ? " · "+detail.state : ""}`} onClose={() => setDetailId(null)}
          footer={<>
            <Btn danger onClick={() => deleteRecord(detail.id)}>Eliminar</Btn>
            <Btn onClick={() => { setDetailId(null); openEdit(detail); }}>Editar unidad</Btn>
            <Btn primary onClick={() => openAddJob(detail.id)}>+ Agregar job</Btn>
          </>}>
          <div style={{ marginBottom:10, display:"flex", alignItems:"center", gap:10 }}>
            <Badge situation={sit(detail)} />
            <span style={{ fontSize:13, color:"#888" }}>{activeJobsByStorage[detail.id] || 0} job(s) activo(s)</span>
          </div>
          <SectionLabel>Unidad</SectionLabel>
          <DetailRow label="Empresa" value={detail.brand} />
          <DetailRow label="Direccion" value={detail.address} />
          <DetailRow label="Estado" value={detail.state} />
          <DetailRow label="Zip code" value={detail.zip} />
          <DetailRow label="Unidad" value={detail.unit} />
          <DetailRow label="Tamano" value={detail.size} />
          <DetailRow label="Gate Code" value={detail.gate_code} />
          <DetailRow label="Lock / Combo" value={detail.lock} />
          <SectionLabel>Cuenta</SectionLabel>
          <DetailRow label="Email" value={detail.email} />
          <DetailRow label="Account #" value={detail.account} />
          <DetailRow label="Teléfono" value={detail.phone} />
          <DetailRow label="Tarjeta" value={detail.card_on_file} />
          <DetailRow label="Costo mensual" value={detail.monthly_cost ? "$" + detail.monthly_cost : null} />
          <DetailRow label="Fecha de apertura" value={detail.date_opened} />

          <SectionLabel>Pago</SectionLabel>
          <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13, alignItems:"center" }}>
            <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>Vencimiento de pago</span>
            <span style={{ fontWeight:500 }}>{fmtDateLocal(paymentDueDate(detail)) || "—"}</span>
            <span style={{ flex:1 }} />
            <PaymentBadge record={detail} situation={sit(detail)} />
          </div>
          <div style={{ display:"flex", gap:8, marginTop:10 }}>
            <Btn onClick={() => renewPayment(detail)}>Renovar — sumar 30 días</Btn>
            {sit(detail) !== "Close" && <Btn danger onClick={() => closeStorage(detail)}>Cerrar storage</Btn>}
          </div>

          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", margin:"16px 0 8px" }}>
            <span style={{ fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em" }}>Job History</span>
            <span style={{ fontSize:11, color:"#bbb" }}>{activeJobsByStorage[detail.id] || 0} activo(s)</span>
          </div>
          <JobHistory
            storageId={detail.id}
            jobs={jobs.filter(j => j.storage_id === detail.id)}
            dbReady={dbReady}
            onSetup={() => setShowSetup(true)}
            onChange={loadJobs}
          />
          <AuditInfo rec={detail} />
        </Modal>
      )}

      {showAdd && (
        <Modal title={editId ? "Editar unidad" : "Nueva unidad"} onClose={() => setShowAdd(false)}
          footer={<>
            <Btn onClick={() => setShowAdd(false)}>Cancelar</Btn>
            <Btn primary disabled={saving} onClick={saveForm}>{saving ? "Guardando..." : "Guardar"}</Btn>
          </>}>
          <p style={{ fontSize:12, color:"#999", margin:"0 0 12px" }}>Datos fijos de la unidad. Los clientes y jobs se cargan aparte en el historial.</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Empresa"><input style={inp} list="brands-list" value={form.brand} onChange={e => setForm(f => ({...f, brand:e.target.value}))} placeholder="Elegí o escribí (CubeSmart...)" /></Field>
            <Field label="Estado"><input style={inp} list="states-list" value={form.state} onChange={e => setForm(f => ({...f, state:e.target.value.toUpperCase()}))} placeholder="TN" /></Field>
            <Field label="Zip code"><input style={inp} value={form.zip} onChange={e => setForm(f => ({...f, zip:e.target.value}))} placeholder="38555" /></Field>
            <Field label="Direccion" full><input style={inp} value={form.address} onChange={e => setForm(f => ({...f, address:e.target.value}))} placeholder="1870 West Ave, Crossville, TN 38555" /></Field>
            <Field label="Unidad #"><input style={inp} value={form.unit} onChange={e => setForm(f => ({...f, unit:e.target.value}))} placeholder="G13" /></Field>
            <Field label="Tamano"><input style={inp} list="sizes-list" value={form.size} onChange={e => setForm(f => ({...f, size:e.target.value}))} placeholder="10x10" /></Field>
            <Field label="Gate Code"><input style={inp} value={form.gate_code} onChange={e => setForm(f => ({...f, gate_code:e.target.value}))} placeholder="*130438#" /></Field>
            <Field label="Lock / Combo"><input style={inp} value={form.lock} onChange={e => setForm(f => ({...f, lock:e.target.value}))} placeholder="use 8141 to unlock..." /></Field>
            <Field label="Email"><input style={inp} value={form.email} onChange={e => setForm(f => ({...f, email:e.target.value}))} placeholder="service@..." /></Field>
            <Field label="Account #"><input style={inp} value={form.account} onChange={e => setForm(f => ({...f, account:e.target.value}))} placeholder="NONE" /></Field>
            <Field label="Teléfono"><input style={inp} value={form.phone} onChange={e => setForm(f => ({...f, phone:e.target.value}))} placeholder="(931) 555-0199" /></Field>
            <Field label="Estado de la unidad">
              <select style={inp} value={form.situation} onChange={e => setForm(f => ({...f, situation:e.target.value}))}>
                <option value="Open">Activa (automático según jobs)</option>
                <option value="Close">Cerrada</option>
              </select>
            </Field>
            <Field label="Costo mensual ($)"><input style={inp} type="number" value={form.monthly_cost} onChange={e => setForm(f => ({...f, monthly_cost:e.target.value}))} placeholder="0" /></Field>
            <Field label="Tarjeta"><input style={inp} value={form.card_on_file} onChange={e => setForm(f => ({...f, card_on_file:e.target.value}))} placeholder="Visa ****1234" /></Field>
            <Field label="Fecha de apertura"><input style={inp} type="date" value={form.date_opened} onChange={e => setForm(f => ({...f, date_opened:e.target.value}))} /></Field>
            <Field label="Vencimiento de pago"><input style={inp} type="date" value={form.payment_due_date} onChange={e => setForm(f => ({...f, payment_due_date:e.target.value}))} /></Field>
          </div>
        </Modal>
      )}

      {showAddJob && (
        <Modal title={editingJobKey ? "Editar job" : "Nuevo job"} onClose={() => setShowAddJob(false)}
          footer={<>
            <Btn onClick={() => setShowAddJob(false)}>Cancelar</Btn>
            <Btn primary disabled={jobSaving} onClick={saveJob}>{jobSaving ? "Guardando..." : (editingJobKey ? "Guardar cambios" : "Guardar job")}</Btn>
          </>}>
          {(() => {
            const t = jobForm.job_type;
            const u = (k) => (e) => setJobForm(f => ({ ...f, [k]: e.target.value }));
            const uUp = (k) => (e) => setJobForm(f => ({ ...f, [k]: e.target.value.toUpperCase() }));

            const basicInfo = (
              <FormSection title="Información básica">
                <div style={fgrid}>
                  <Field label="Job # *"><input style={inp} value={jobForm.job_number} onChange={u("job_number")} placeholder="B8417142" /></Field>
                  <Field label="Tipo de job *">
                    <select style={inp} value={jobForm.job_type} onChange={u("job_type")}>
                      {JOB_TYPES.map(x => <option key={x.v} value={x.v}>{x.l}{x.v==="full"?" (pickup → storage → delivery)":x.v==="direct"?" (pickup → delivery)":" (solo delivery)"}</option>)}
                    </select>
                  </Field>
                  <Field label="Broker">
                    <select style={inp} value={jobForm.broker_id} onChange={u("broker_id")}>
                      <option value="">— Sin broker —</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Cliente *"><input style={inp} value={jobForm.customer} onChange={u("customer")} placeholder="Nombre del cliente" /></Field>
                  <Field label="Teléfono del cliente"><input style={inp} value={jobForm.client_phone} onChange={u("client_phone")} placeholder="(555) 123-4567" /></Field>
                  <Field label="Email del cliente"><input style={inp} value={jobForm.client_email} onChange={u("client_email")} placeholder="cliente@email.com" /></Field>
                  <Field label="Rep (interno)"><input style={inp} value={jobForm.rep} onChange={u("rep")} placeholder="Rep" /></Field>
                  <Field label="Estado">
                    <select style={inp} value={jobForm.status} onChange={u("status")}>{STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}</select>
                  </Field>
                </div>
                <div style={{ marginTop:10 }}>
                  <label style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>Driver{(jobForm.driver_ids?.length) ? ` (${jobForm.driver_ids.length})` : ""}</label>
                  {driversList.length === 0 ? (
                    <input style={{ ...inp, marginTop:4 }} list="drivers-list" value={jobForm.driver} onChange={u("driver")} placeholder="Cargá drivers en la sección Drivers para multi-asignar" />
                  ) : (
                    <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:130, overflowY:"auto", background:"#fff", marginTop:4 }}>
                      {driversList.filter(d => d.active !== false).map(d => {
                        const checked = Array.isArray(jobForm.driver_ids) && jobForm.driver_ids.includes(d.id);
                        return (
                          <label key={d.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                            <input type="checkbox" checked={checked} onChange={() => toggleJobDriver(d.id)} />
                            <span>🧑‍✈️ {d.name}{d.truck_id ? ` · ${d.truck_id}` : ""}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </FormSection>
            );

            const pickup = (
              <FormSection title="Pick up">
                <div style={fgrid}>
                  <Field label="Pick up from"><input style={inp} type="date" value={jobForm.pickup_date_from} onChange={u("pickup_date_from")} /></Field>
                  <Field label="Pick up to (opcional)"><input style={inp} type="date" value={jobForm.pickup_date_to} onChange={u("pickup_date_to")} /></Field>
                  <Field label="Pickup address" full><input style={inp} value={jobForm.pickup_address} onChange={u("pickup_address")} placeholder="Dirección de pickup" /></Field>
                  <Field label="Pickup city"><input style={inp} value={jobForm.pickup_city} onChange={u("pickup_city")} placeholder="Ciudad" /></Field>
                  <Field label="Pickup estado"><input style={inp} list="states-list" value={jobForm.pickup_state} onChange={uUp("pickup_state")} placeholder="NY" /></Field>
                  <Field label="Pickup zip"><input style={inp} value={jobForm.pickup_zip} onChange={u("pickup_zip")} placeholder="10001" /></Field>
                  <Field label="Extra stops" full><input style={inp} value={jobForm.extra_stops} onChange={u("extra_stops")} placeholder="paradas adicionales" /></Field>
                </div>
              </FormSection>
            );

            const delivery = (
              <FormSection title="Delivery">
                <div style={fgrid}>
                  <Field label="FADD *"><input style={inp} type="date" value={jobForm.fadd} onChange={u("fadd")} /></Field>
                  <Field label="Delivery date"><input style={inp} type="date" value={jobForm.delivery_date} onChange={u("delivery_date")} /></Field>
                  <Field label="Delivery address" full><input style={inp} value={jobForm.delivery_address} onChange={u("delivery_address")} placeholder="Dirección de entrega" /></Field>
                  <Field label="Delivery city"><input style={inp} value={jobForm.delivery_city} onChange={u("delivery_city")} placeholder="Ciudad" /></Field>
                  <Field label="Delivery estado"><input style={inp} list="states-list" value={jobForm.delivery_state} onChange={uUp("delivery_state")} placeholder="NJ" /></Field>
                  <Field label="Delivery zip"><input style={inp} value={jobForm.delivery_zip} onChange={u("delivery_zip")} placeholder="07030" /></Field>
                </div>
              </FormSection>
            );

            const load = (
              <FormSection title="Load / Carga">
                <div style={fgrid}>
                  <Field label="Volumen (CF)"><input style={inp} value={jobForm.volume} onChange={u("volume")} placeholder="ej: 1200" /></Field>
                  <Field label="Color del sticker">
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ width:18, height:18, borderRadius:"50%", flexShrink:0, background: colorHex(jobForm.sticker_color) || "#fff", border:"1px solid #ccc" }} />
                      <input style={inp} list="sticker-colors-list" value={jobForm.sticker_color} onChange={u("sticker_color")} placeholder="Rojo, Azul..." />
                    </div>
                  </Field>
                  <Field label="Lot number"><input style={inp} value={jobForm.lot_number} onChange={u("lot_number")} placeholder="LOT-4821" /></Field>
                  <Field label="Carrier notes" full><input style={inp} value={jobForm.carrier_notes} onChange={u("carrier_notes")} placeholder="Notas para el carrier/driver" /></Field>
                  <Field label="Notas internas" full><input style={inp} value={jobForm.notes} onChange={u("notes")} placeholder="Notas del job" /></Field>
                </div>
              </FormSection>
            );

            const padsMissingForm = Math.max(0, (jobForm.pads_received !== "" ? parseInt(jobForm.pads_received) : 0) - (jobForm.pads_returned !== "" ? parseInt(jobForm.pads_returned) : 0));
            const pads = (
              <FormSection title="Pads">
                <div style={fgrid}>
                  <Field label="Pads recibidos del broker"><input style={inp} type="number" value={jobForm.pads_received} onChange={u("pads_received")} placeholder="0" /></Field>
                  <Field label="Pads devueltos (post-delivery)"><input style={inp} type="number" value={jobForm.pads_returned} onChange={u("pads_returned")} placeholder="0" /></Field>
                  <Field label="Pads faltantes (auto)"><div style={{ ...inp, background:"#fafafa", fontWeight:700, color: padsMissingForm > 0 ? "#A32D2D" : "#111" }}>{padsMissingForm}</div></Field>
                </div>
              </FormSection>
            );

            const financialsFull = (
              <FormSection title="Financiero">
                <div style={fgrid}>
                  <Field label="Estimate ($)"><input style={inp} type="number" value={jobForm.estimate} onChange={u("estimate")} placeholder="0" /></Field>
                  <Field label="Deposit ($)"><input style={inp} type="number" value={jobForm.deposit} onChange={u("deposit")} placeholder="0" /></Field>
                  <Field label="Balance en pickup ($)"><input style={inp} type="number" value={jobForm.pickup_balance} onChange={u("pickup_balance")} placeholder="0" /></Field>
                  <Field label="Balance en delivery ($)"><input style={inp} type="number" value={jobForm.delivery_balance} onChange={u("delivery_balance")} placeholder="0" /></Field>
                  <Field label="Precio / CF ($)"><input style={inp} type="number" value={jobForm.price_per_cf} onChange={u("price_per_cf")} placeholder="0.65" /></Field>
                  <Field label="Fuel surcharge (%)"><input style={inp} type="number" value={jobForm.fuel_surcharge_pct} onChange={u("fuel_surcharge_pct")} placeholder="5" /></Field>
                </div>
              </FormSection>
            );

            const carrierTotal = parseCf(jobForm.volume) * numv(jobForm.carrier_rate_per_cf);
            const financialsBroker = (
              <FormSection title="Financiero (broker delivery)">
                <div style={fgrid}>
                  <Field label="BOL balance a cobrar al cliente ($)"><input style={inp} type="number" value={jobForm.bol_balance} onChange={u("bol_balance")} placeholder="0" /></Field>
                  <Field label="Carrier rate / CF ($)"><input style={inp} type="number" value={jobForm.carrier_rate_per_cf} onChange={u("carrier_rate_per_cf")} placeholder="0.55" /></Field>
                  <Field label="Carrier total (CF × rate)"><div style={{ ...inp, background:"#fafafa", fontWeight:700 }}>{money(carrierTotal) || "$0"}</div></Field>
                  {!settlementsMissing && (
                    <Field label="Closing sheet" full>
                      <select style={inp} value={jobForm.closing_sheet_id === "" || jobForm.closing_sheet_id == null ? "" : String(jobForm.closing_sheet_id)} onChange={e => setJobForm(f => ({...f, closing_sheet_id: e.target.value === "" ? "" : (e.target.value === "__new__" ? "__new__" : Number(e.target.value))}))}>
                        <option value="">— Sin closing sheet —</option>
                        {(() => { const cur = jobForm.closing_sheet_id; const linked = cur && cur !== "__new__" ? closingSheets.find(s => s.id === Number(cur)) : null; return (linked && linked.status !== "open") ? <option value={String(linked.id)}>#{linked.closing_sheet_number || linked.id} ({linked.status})</option> : null; })()}
                        {closingSheets.filter(s => s.status === "open").map(s => <option key={s.id} value={String(s.id)}>#{s.closing_sheet_number || s.id} · {brokerName(s.broker_id) || "sin broker"}</option>)}
                        <option value="__new__">➕ Crear nuevo closing sheet</option>
                      </select>
                    </Field>
                  )}
                  <Field label="BOL cobrado ($)"><input style={inp} type="number" value={jobForm.bol_collected} onChange={u("bol_collected")} placeholder="0" /></Field>
                  <Field label="Método de pago"><PaymentMethodSelect style={inp} value={jobForm.bol_payment_method} onChange={v => setJobForm(f => ({...f, bol_payment_method: v || ""}))} /></Field>
                  <Field label="Fecha de cobro"><input style={inp} type="date" value={jobForm.bol_collected_date} onChange={u("bol_collected_date")} /></Field>
                </div>
              </FormSection>
            );

            const storageBlock = (
              <FormSection title={`Storage (opcional)${(jobForm.storage_ids.length + jobForm.warehouses.length) ? ` · ${jobForm.storage_ids.length + jobForm.warehouses.length}` : ""}`} defaultOpen={false}>
                <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:200, overflowY:"auto", background:"#fff" }}>
                  {(() => { const none = jobForm.storage_ids.length === 0 && jobForm.warehouses.length === 0; return (
                    <label onClick={() => setJobForm(f => ({ ...f, storage_ids: [], warehouses: [] }))}
                      style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: none ? "#f0fdf4" : "#fff" }}>
                      <input type="radio" readOnly checked={none} />
                      <span style={{ color: none ? "#111" : "#888" }}>— Sin asignar —</span>
                    </label>
                  ); })()}
                  <div style={{ padding:"6px 10px", fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", background:"#fafafa" }}>Warehouses propios</div>
                  {WAREHOUSES.map(w => {
                    const checked = jobForm.warehouses.includes(w);
                    return (
                      <label key={w} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleJobWarehouse(w)} /><span>🏭 Warehouse {w}</span>
                      </label>
                    );
                  })}
                  <div style={{ padding:"6px 10px", fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", background:"#fafafa" }}>Unidades alquiladas</div>
                  {records.filter(r => r.space_type !== "warehouse").length === 0 ? (
                    <div style={{ padding:"10px 12px", fontSize:12, color:"#bbb" }}>No hay unidades cargadas todavía.</div>
                  ) : records.filter(r => r.space_type !== "warehouse").map(r => {
                    const checked = jobForm.storage_ids.includes(r.id);
                    return (
                      <label key={r.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleJobUnit(r.id)} />
                        <span>{[r.brand, r.unit && `Unidad ${r.unit}`, r.state].filter(Boolean).join(" · ") || `Unidad #${r.id}`}</span>
                      </label>
                    );
                  })}
                </div>
                <Field label="Date in (a storage)"><input style={{ ...inp, marginTop:8, maxWidth:200 }} type="date" value={jobForm.date_in} onChange={u("date_in")} /></Field>
              </FormSection>
            );

            const billingBlock = (
              <FormSection title="Storage billing al cliente (opcional)" defaultOpen={false}>
                <label style={{ display:"flex", alignItems:"center", gap:10, fontSize:13, cursor:"pointer", padding:"4px 0" }}>
                  <input type="checkbox" checked={!!jobForm.billing_active} onChange={e => setJobForm(f => ({...f, billing_active:e.target.checked}))} />
                  <span>Cobrar a este cliente por guardar (cada 30 días)</span>
                </label>
                {jobForm.billing_active && (
                  <div style={{ ...fgrid, marginTop:8 }}>
                    <Field label="Tarifa mensual ($)"><input style={inp} type="number" value={jobForm.client_monthly_rate} onChange={u("client_monthly_rate")} placeholder="ej: 150" /></Field>
                    <Field label="¿Primer mes gratis?">
                      <select style={inp} value={jobForm.first_month_free ? "yes" : "no"} onChange={e => setJobForm(f => ({...f, first_month_free: e.target.value === "yes"}))}>
                        <option value="no">No</option><option value="yes">Sí — cobra a los 30 días</option>
                      </select>
                    </Field>
                    <Field label="Inicio de billing (auto, editable)" full>
                      <input style={inp} type="date" value={jobForm.billing_start_date || (jobForm.date_in ? (jobForm.first_month_free ? addDaysStr(jobForm.date_in, 30) : jobForm.date_in) : "")} onChange={u("billing_start_date")} />
                    </Field>
                  </div>
                )}
              </FormSection>
            );

            const directPickDeliver = (
              <FormSection title="Pick up + Delivery (mismo día)">
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))", gap:14 }}>
                  <div>
                    <div style={{ fontSize:10, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Pick up</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      <Field label="Pickup date"><input style={inp} type="date" value={jobForm.pickup_date_from} onChange={u("pickup_date_from")} /></Field>
                      <Field label="Pickup address"><input style={inp} value={jobForm.pickup_address} onChange={u("pickup_address")} placeholder="Dirección de pickup" /></Field>
                      <Field label="Pickup city"><input style={inp} value={jobForm.pickup_city} onChange={u("pickup_city")} placeholder="Ciudad" /></Field>
                      <Field label="Pickup estado"><input style={inp} list="states-list" value={jobForm.pickup_state} onChange={uUp("pickup_state")} placeholder="NY" /></Field>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:10, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 }}>Delivery</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      <Field label="FADD *"><input style={inp} type="date" value={jobForm.fadd} onChange={u("fadd")} /></Field>
                      <Field label="Delivery address"><input style={inp} value={jobForm.delivery_address} onChange={u("delivery_address")} placeholder="Dirección de entrega" /></Field>
                      <Field label="Delivery city"><input style={inp} value={jobForm.delivery_city} onChange={u("delivery_city")} placeholder="Ciudad" /></Field>
                      <Field label="Delivery estado"><input style={inp} list="states-list" value={jobForm.delivery_state} onChange={uUp("delivery_state")} placeholder="NJ" /></Field>
                    </div>
                  </div>
                </div>
              </FormSection>
            );

            return (
              <>
                {basicInfo}
                {t === "broker_delivery" && <>{delivery}{load}{pads}{financialsBroker}{storageBlock}</>}
                {t === "full" && <>{pickup}{delivery}{load}{pads}{financialsFull}{storageBlock}{billingBlock}</>}
                {t === "direct" && <>{directPickDeliver}{load}{pads}{financialsFull}</>}
              </>
            );
          })()}
          {jobErr && <div style={{ fontSize:12, color:"#b91c1c", marginTop:10 }}>{jobErr}</div>}
        </Modal>
      )}

      {capTarget && (
        <Modal title={capTarget.kind === "warehouse" ? `Capacidad — ${capTarget.name}` : "Capacidad de la unidad"} onClose={() => setCapTarget(null)}
          footer={<>
            <Btn onClick={() => setCapTarget(null)}>Cancelar</Btn>
            <Btn primary onClick={saveCapacity}>Guardar</Btn>
          </>}>
          <Field label="Capacidad total (CF)">
            <input style={inp} type="number" autoFocus value={capTarget.value}
              onChange={e => setCapTarget(t => ({ ...t, value:e.target.value }))}
              onKeyDown={e => { if (e.key === "Enter") saveCapacity(); }}
              placeholder="ej: 10000" />
          </Field>
          <p style={{ fontSize:12, color:"#999", marginTop:8 }}>Capacidad en pies cúbicos. La ocupación se calcula con el volumen (CF) de los jobs activos.</p>
        </Modal>
      )}

      {showImport && (
        <Modal title="Importar desde WhatsApp" onClose={() => setShowImport(false)}
          footer={<>
            <Btn onClick={() => setShowImport(false)}>Cancelar</Btn>
            {importTab === "paste" && <Btn onClick={previewPaste}>Previsualizar</Btn>}
            <Btn primary disabled={saving || !pending.filter((_,i) => !excluded[i]).length} onClick={confirmImport}>
              {saving ? "Importando..." : `Importar (${pending.filter((_,i) => !excluded[i]).length})`}
            </Btn>
          </>}>
          <div style={{ display:"flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14 }}>
            <button onClick={() => { setImportTab("paste"); setPending([]); }} style={impTabStyle("paste")}>Pegar texto</button>
            <button onClick={() => { setImportTab("zip"); setPending([]); }} style={impTabStyle("zip")}>Subir ZIP del chat</button>
          </div>
          {importTab === "paste" && (
            <>
              <p style={{ fontSize:13, color:"#888", marginBottom:10 }}>Pega uno o varios mensajes del grupo de WhatsApp.</p>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)}
                placeholder={"Storage para: Elvin Medina\nGo Store It!\nsize: 10x10\nAddress: 1870 West Avenue, Crossville, TN\nUnit Number: G13\nGate Code: 130438"}
                style={{ ...inp, fontFamily:"monospace", fontSize:12, resize:"vertical", minHeight:120, display:"block", marginBottom:8 }} />
            </>
          )}
          {importTab === "zip" && (
            <>
              <p style={{ fontSize:13, color:"#888", marginBottom:10 }}>Subi el .zip exportado del chat de WhatsApp. Se procesa en tu navegador.</p>
              <div onDragOver={e => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)}
                onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleZip(f); }}
                onClick={() => fileRef.current.click()}
                style={{ border:`2px dashed ${isDragging ? "#378ADD" : "#ddd"}`, borderRadius:10, padding:"28px 16px", textAlign:"center", cursor:"pointer", background: isDragging ? "#E6F1FB" : "#fafafa", transition:"all .15s" }}>
                <div style={{ fontSize:28, marginBottom:8 }}>zip</div>
                <p style={{ fontSize:13, color:"#888" }}>Hace clic o arrastra el archivo .zip aca</p>
                {zipName && <p style={{ fontSize:13, fontWeight:600, color:"#111", marginTop:6 }}>{zipName}</p>}
              </div>
              <input ref={fileRef} type="file" accept=".zip" style={{ display:"none" }} onChange={e => handleZip(e.target.files[0])} />
              {zipStatus && <p style={{ fontSize:12, color: zipStatus.includes("Error")||zipStatus.includes("No se") ? "#b91c1c" : "#3B6D11", marginTop:8 }}>{zipStatus}</p>}
            </>
          )}
          {pending.length > 0 && (
            <div style={{ marginTop:14 }}>
              <div style={{ fontSize:12, fontWeight:600, color:"#3B6D11", marginBottom:8 }}>{pending.length} storage(s) detectados:</div>
              <div style={{ maxHeight:260, overflowY:"auto", display:"flex", flexDirection:"column", gap:6 }}>
                {pending.map((r, i) => (
                  <label key={i} style={{ display:"flex", alignItems:"flex-start", gap:8, fontSize:12, background: excluded[i] ? "#fafafa" : "#f0fdf4", borderRadius:8, padding:"8px 10px", cursor:"pointer", border:"1px solid", borderColor: excluded[i] ? "#efefef" : "#bbf7d0" }}>
                    <input type="checkbox" checked={!excluded[i]} onChange={e => setExcluded(ex => ({...ex, [i]: !e.target.checked}))} style={{ marginTop:1 }} />
                    <div>
                      <span style={{ fontWeight:600 }}>{r.driver||"Sin nombre"}</span>
                      <span style={{ color:"#666" }}> · {r.brand||"?"} · Unidad {r.unit||"?"}</span>
                      {r.address && <div style={{ color:"#888", marginTop:2 }}>{r.address}</div>}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}

      {showSetup && (() => {
        const allSql = [STORAGE_JOBS_SQL, JOB_COLS_SQL, CRM_V2_SQL, BILLING_SQL, CRM_V3_SQL, SETTLEMENTS_SQL].join("\n\n");
        return (
        <Modal title="Configuración de base de datos" onClose={() => setShowSetup(false)}
          footer={<Btn primary onClick={() => setShowSetup(false)}>Listo</Btn>}>
          <p style={{ fontSize:13, color:"#555", lineHeight:1.6, marginTop:0 }}>
            La clave pública no permite crear tablas/columnas. Ejecutá este SQL <strong>una sola vez</strong> en el
            SQL Editor de Supabase. Incluye <strong>storage_jobs</strong>, las columnas de Dispatching, la tabla
            <strong> brokers</strong> (con los brokers comunes pre-cargados) y los balances. Después recargá.
          </p>
          <pre style={{ background:"#0f172a", color:"#e2e8f0", borderRadius:10, padding:"14px", fontSize:11.5, lineHeight:1.5, overflowX:"auto", whiteSpace:"pre" }}>{allSql}</pre>
          <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
            <Btn onClick={() => {
              navigator.clipboard?.writeText(allSql).then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500); }).catch(() => {});
            }}>{sqlCopied ? "✓ Copiado" : "Copiar SQL"}</Btn>
          </div>
        </Modal>
        );
      })()}

      {showBrokerModal && (
        <Modal title={editingBrokerId ? "Editar broker" : "Nuevo broker"} onClose={() => setShowBrokerModal(false)}
          footer={<>
            <Btn onClick={() => setShowBrokerModal(false)}>Cancelar</Btn>
            <Btn primary disabled={brokerSaving || !brokerForm.name.trim()} onClick={saveBroker}>{brokerSaving ? "Guardando..." : "Guardar"}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Nombre" full><input style={inp} value={brokerForm.name} onChange={e => setBrokerForm(f => ({...f, name:e.target.value}))} placeholder="Allied Van Lines" /></Field>
            <Field label="Contacto"><input style={inp} value={brokerForm.contact_name} onChange={e => setBrokerForm(f => ({...f, contact_name:e.target.value}))} placeholder="Nombre del contacto" /></Field>
            <Field label="Teléfono"><input style={inp} value={brokerForm.contact_phone} onChange={e => setBrokerForm(f => ({...f, contact_phone:e.target.value}))} placeholder="(555) 123-4567" /></Field>
            <Field label="Email" full><input style={inp} value={brokerForm.contact_email} onChange={e => setBrokerForm(f => ({...f, contact_email:e.target.value}))} placeholder="ops@broker.com" /></Field>
            <Field label="Notas" full><input style={inp} value={brokerForm.notes} onChange={e => setBrokerForm(f => ({...f, notes:e.target.value}))} placeholder="Notas" /></Field>
          </div>
        </Modal>
      )}

      {showDriverModal && (
        <Modal title={editingDriverId ? "Editar driver" : "Nuevo driver"} onClose={() => setShowDriverModal(false)}
          footer={<>
            <Btn onClick={() => setShowDriverModal(false)}>Cancelar</Btn>
            <Btn primary disabled={driverSaving || !driverForm.name.trim()} onClick={saveDriver}>{driverSaving ? "Guardando..." : "Guardar"}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Nombre" full><input style={inp} value={driverForm.name} onChange={e => setDriverForm(f => ({...f, name:e.target.value}))} placeholder="Nombre del chofer" /></Field>
            <Field label="Teléfono"><input style={inp} value={driverForm.phone} onChange={e => setDriverForm(f => ({...f, phone:e.target.value}))} placeholder="(555) 123-4567" /></Field>
            <Field label="Truck ID"><input style={inp} value={driverForm.truck_id} onChange={e => setDriverForm(f => ({...f, truck_id:e.target.value}))} placeholder="ej: T-12" /></Field>
            <Field label="Link del grupo de WhatsApp" full><input style={inp} value={driverForm.whatsapp_group_link} onChange={e => setDriverForm(f => ({...f, whatsapp_group_link:e.target.value}))} placeholder="https://chat.whatsapp.com/..." /></Field>
            <Field label="Notas" full><input style={inp} value={driverForm.notes} onChange={e => setDriverForm(f => ({...f, notes:e.target.value}))} placeholder="Notas" /></Field>
            <Field label="Estado">
              <select style={inp} value={driverForm.active ? "yes" : "no"} onChange={e => setDriverForm(f => ({...f, active: e.target.value === "yes"}))}>
                <option value="yes">Activo</option><option value="no">Inactivo</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {showCsModal && (
        <Modal title={editingCsId ? "Editar closing sheet" : "Nuevo closing sheet"} onClose={() => setShowCsModal(false)}
          footer={<>
            <Btn onClick={() => setShowCsModal(false)}>Cancelar</Btn>
            <Btn primary disabled={csSaving} onClick={saveCs}>{csSaving ? "Guardando..." : (editingCsId ? "Guardar cambios" : "Crear")}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="CS number"><input style={inp} value={csForm.closing_sheet_number} onChange={e => setCsForm(f => ({...f, closing_sheet_number:e.target.value}))} placeholder="CS-1024" /></Field>
            <Field label="Load date"><input style={inp} type="date" value={csForm.load_date} onChange={e => setCsForm(f => ({...f, load_date:e.target.value}))} /></Field>
            <Field label="Broker">
              <select style={inp} value={csForm.broker_id} onChange={e => setCsForm(f => ({...f, broker_id:e.target.value}))}>
                <option value="">— Sin broker —</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Driver">
              <select style={inp} value={csForm.driver_id} onChange={e => setCsForm(f => ({...f, driver_id:e.target.value}))}>
                <option value="">— Sin driver —</option>{driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Estado">
              <select style={inp} value={csForm.status} onChange={e => setCsForm(f => ({...f, status:e.target.value}))}>
                <option value="open">Open</option><option value="settled">Settled</option><option value="disputed">Disputed</option>
              </select>
            </Field>
          </div>

          <SectionLabel>Documento (foto o PDF)</SectionLabel>
          <label style={{ display:"block", border:"2px dashed #ddd", borderRadius:10, padding:"12px", textAlign:"center", cursor:"pointer", background:"#fafafa" }}
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) uploadCsDoc(f, null); }}>
            <input type="file" accept="image/*,application/pdf" style={{ display:"none" }} onChange={e => uploadCsDoc(e.target.files?.[0], null)} />
            {docUploading ? <span style={{ fontSize:12, color:"#888" }}>Subiendo…</span>
              : csForm.document_url ? <span style={{ fontSize:12, color:"#3B6D11" }}>✓ Documento cargado — clic para reemplazar</span>
              : <span style={{ fontSize:12, color:"#999" }}>Arrastrá o hacé clic para subir</span>}
          </label>

          <SectionLabel>Jobs en este closing sheet{csForm.job_keys.length ? ` (${csForm.job_keys.length})` : ""}</SectionLabel>
          <input style={{ ...inp, marginBottom:8 }} value={csJobSearch} onChange={e => setCsJobSearch(e.target.value)} placeholder="Buscar job # o cliente para agregar..." />
          <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:180, overflowY:"auto", background:"#fff" }}>
            {(() => {
              const q = csJobSearch.trim().toLowerCase();
              const seen = new Set(); const rows = [];
              for (const j of jobs) { const k = jobKey(j); if (seen.has(k)) continue; seen.add(k);
                const inOther = j.closing_sheet_id && j.closing_sheet_id !== editingCsId;
                const hay = [j.job_number, j.customer, j.driver].join(" ").toLowerCase();
                if (q && !hay.includes(q)) continue;
                if (!q && !csForm.job_keys.includes(k)) continue; // when not searching, show only selected
                rows.push({ j, k, inOther });
              }
              if (!rows.length) return <div style={{ padding:"10px 12px", fontSize:12, color:"#bbb" }}>{q ? "Sin resultados." : "Buscá un job para agregarlo."}</div>;
              return rows.slice(0, 60).map(({ j, k, inOther }) => {
                const checked = csForm.job_keys.includes(k);
                return (
                  <label key={k} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor: inOther?"not-allowed":"pointer", borderBottom:"1px solid #f5f5f5", background: checked?"#f0fdf4":"#fff", opacity: inOther?0.5:1 }}>
                    <input type="checkbox" disabled={inOther} checked={checked} onChange={() => csToggleJob(k)} />
                    <span style={{ fontFamily:"monospace", fontWeight:600 }}>{j.job_number || "(job)"}</span>
                    <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.customer || "—"}</span>
                    {inOther && <span style={{ fontSize:10, color:"#999" }}>en otro CS</span>}
                  </label>
                );
              });
            })()}
          </div>

          <SectionLabel>Pads</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Cargo por pad faltante ($)"><input style={inp} type="number" value={csForm.charge_per_pad} onChange={e => setCsForm(f => ({...f, charge_per_pad:e.target.value}))} placeholder="7" /></Field>
          </div>
          <div style={{ fontSize:11, color:"#999", marginTop:4 }}>Los pads enviados/devueltos se cargan por job (sección Pads del job) y se suman acá automáticamente.</div>

          <SectionLabel>Deducciones del broker</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Trip cost ($)"><input style={inp} type="number" value={csForm.trip_cost} onChange={e => setCsForm(f => ({...f, trip_cost:e.target.value}))} placeholder="0" /></Field>
            <Field label="Labor charges ($)"><input style={inp} type="number" value={csForm.labor_charges} onChange={e => setCsForm(f => ({...f, labor_charges:e.target.value}))} placeholder="0" /></Field>
            <Field label="Other fees ($)"><input style={inp} type="number" value={csForm.other_fees} onChange={e => setCsForm(f => ({...f, other_fees:e.target.value}))} placeholder="0" /></Field>
            <Field label="Descripción other fees"><input style={inp} value={csForm.other_fees_description} onChange={e => setCsForm(f => ({...f, other_fees_description:e.target.value}))} placeholder="ej: detention" /></Field>
            <Field label="Notas" full><input style={inp} value={csForm.notes} onChange={e => setCsForm(f => ({...f, notes:e.target.value}))} placeholder="Notas" /></Field>
          </div>
          {editingCsId && <div style={{ marginTop:12 }}><Btn danger onClick={() => { setShowCsModal(false); deleteCs(closingSheets.find(x=>x.id===editingCsId)); }}>Eliminar closing sheet</Btn></div>}
        </Modal>
      )}

      {payModal && (
        <Modal title="Registrar cobro (BOL)" onClose={() => setPayModal(null)}
          footer={<>
            <Btn onClick={() => setPayModal(null)}>Cancelar</Btn>
            <Btn primary onClick={savePayment}>Guardar cobro</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Monto cobrado ($)"><input style={inp} type="number" value={payModal.amount} onChange={e => setPayModal(p => ({...p, amount:e.target.value}))} placeholder="0" /></Field>
            <Field label="Fecha de cobro"><input style={inp} type="date" value={payModal.date} onChange={e => setPayModal(p => ({...p, date:e.target.value}))} /></Field>
            <Field label="Método de pago" full>
              <PaymentMethodSelect style={inp} value={payModal.method} onChange={v => setPayModal(p => ({...p, method: v || ""}))} />
            </Field>
            <Field label="Notas" full><input style={inp} value={payModal.notes} onChange={e => setPayModal(p => ({...p, notes:e.target.value}))} placeholder="Notas del cobro (ej: split cash + zelle)" /></Field>
          </div>
        </Modal>
      )}

      {(() => {
        // Shared job-list panel for broker / driver / client detail modals.
        const JobsPanel = ({ predicate }) => {
          const map = new Map();
          for (const j of jobs) { if (!predicate(j)) continue; const k = jobKey(j); if (!map.has(k)) map.set(k, j); }
          const rows = [...map.values()];
          if (!rows.length) return <div style={{ fontSize:13, color:"#bbb", padding:"10px 0" }}>Sin jobs.</div>;
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:8 }}>
              {rows.map(j => (
                <div key={j.id} style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, borderBottom:"1px solid #f4f4f4", paddingBottom:6 }}>
                  <button onClick={() => { setBrokerDetailId(null); setDriverDetailId(null); setClientDetail(null); setJobDetailKey(jobKey(j)); }} style={{ fontFamily:"monospace", fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>{j.job_number || "(ver)"}</button>
                  <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{j.customer || "—"}</span>
                  <StatusBadge status={j.status} />
                  {j.fadd && <span style={{ fontSize:11, color:"#888" }}>{j.fadd}</span>}
                </div>
              ))}
            </div>
          );
        };
        const brokerD = brokers.find(b => b.id === brokerDetailId);
        const driverD = driversList.find(d => d.id === driverDetailId);
        return (
          <>
            {brokerD && (
              <Modal title={`Broker · ${brokerD.name}`} onClose={() => setBrokerDetailId(null)} footer={<Btn primary onClick={() => setBrokerDetailId(null)}>Cerrar</Btn>}>
                <DetailRow label="Contacto" value={brokerD.contact_name} />
                <DetailRow label="Teléfono" value={brokerD.contact_phone} />
                <DetailRow label="Email" value={brokerD.contact_email} />
                <SectionLabel>Jobs del broker</SectionLabel>
                <JobsPanel predicate={j => j.broker_id === brokerD.id} />
              </Modal>
            )}
            {driverD && (
              <Modal title={`Driver · ${driverD.name}`} onClose={() => setDriverDetailId(null)} footer={<Btn primary onClick={() => setDriverDetailId(null)}>Cerrar</Btn>}>
                <DetailRow label="Teléfono" value={driverD.phone} />
                <DetailRow label="Truck" value={driverD.truck_id} />
                {driverD.whatsapp_group_link && <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}><span style={{ color:"#888", minWidth:150 }}>Grupo WhatsApp</span><a href={driverD.whatsapp_group_link} target="_blank" rel="noreferrer" style={{ color:"#1A8A4E", textDecoration:"none" }}>Abrir grupo ↗</a></div>}
                <SectionLabel>Historial de jobs</SectionLabel>
                <JobsPanel predicate={j => (Array.isArray(j.driver_ids) && j.driver_ids.includes(driverD.id)) || (j.driver && driverD.name && j.driver.includes(driverD.name))} />
              </Modal>
            )}
            {clientDetail && (
              <Modal title={`Cliente · ${clientDetail}`} onClose={() => setClientDetail(null)} footer={<Btn primary onClick={() => setClientDetail(null)}>Cerrar</Btn>}>
                <SectionLabel>Jobs del cliente</SectionLabel>
                <JobsPanel predicate={j => (j.customer || "").trim().toLowerCase() === clientDetail.trim().toLowerCase()} />
              </Modal>
            )}
          </>
        );
      })()}
    </div>
  );
}
