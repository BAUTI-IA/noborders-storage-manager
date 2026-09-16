// Unit tests for src/geoData.js — which scheduled jobs become pins on the
// Trips / Live Load map, checked without a browser or a database.
//
//   node scripts/test-geo-pins.mjs
import { scheduledJobGroups, mapJobStops, JOB_PIN_DAYS } from "../src/geoData.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
};

const FROM = "2026-09-16";                       // window start for every case below
const keys = (rows) => rows.map(r => r.key).sort();
const groups = (jobs, days = JOB_PIN_DAYS) => scheduledJobGroups(jobs, { from: FROM, days });

// Enough of a job for jobKey() to group on and for the window rules to bite.
const job = (over = {}) => ({
  id: over.id ?? Math.floor(Math.random() * 1e9),
  job_number: "J1", customer: "Acme", status: "scheduled",
  pickup_address: "1 Main St", pickup_city: "Miami", pickup_state: "FL", pickup_zip: "33125",
  delivery_address: "2 Oak Ave", delivery_city: "Newark", delivery_state: "NJ", delivery_zip: "07102",
  ...over,
});

console.log("\nThe window");
check("a pickup inside the window is in",
  groups([job({ pickup_date: "2026-09-20" })]).length === 1);
check("a delivery inside the window is in",
  groups([job({ delivery_date: "2026-09-20" })]).length === 1);
check("a job with no dates at all is out",
  groups([job({})]).length === 0);
check("the first day of the window counts",
  groups([job({ pickup_date: FROM })]).length === 1);
check("the last day of the window counts",
  groups([job({ pickup_date: "2026-09-30" })]).length === 1);
check("the day after the window is out",
  groups([job({ pickup_date: "2026-10-01" })]).length === 0);
check("yesterday is out",
  groups([job({ pickup_date: "2026-09-15" })]).length === 0);
// A range that starts before the window but runs into it is still work to do.
check("a pickup range straddling the window start is in",
  groups([job({ pickup_date_from: "2026-09-10", pickup_date_to: "2026-09-18" })]).length === 1);
check("a pickup range straddling the window end is in",
  groups([job({ pickup_date_from: "2026-09-28", pickup_date_to: "2026-10-10" })]).length === 1);
check("a pickup range entirely in the past is out",
  groups([job({ pickup_date_from: "2026-09-01", pickup_date_to: "2026-09-10" })]).length === 0);
check("a wider window pulls in a later job",
  groups([job({ pickup_date: "2026-10-10" })], 30).length === 1);

console.log("\nJobs that are off the board");
for (const st of ["delivered", "cancelled"]) {
  check(`status ${st} is out`,
    groups([job({ status: st, pickup_date: "2026-09-20" })]).length === 0);
}
check("calendar_status cancelled is out, whatever the workflow status says",
  groups([job({ calendar_status: "cancelled", pickup_date: "2026-09-20" })]).length === 0);
check("an on-hold job is still on the map",
  groups([job({ status: "on_hold", pickup_date: "2026-09-20" })]).length === 1);

console.log("\nOne row per location, one pin per job");
// The real shape of a multi-unit job: same job_number, several storage rows.
const split = [
  job({ id: 1, job_number: "J9", pickup_date: "2026-09-20" }),
  job({ id: 2, job_number: "J9", pickup_date: "2026-09-20" }),
  job({ id: 3, job_number: "J9", pickup_date: "2026-09-20" }),
];
check("three rows of one job collapse to one entry", groups(split).length === 1);
check("two different jobs stay two",
  groups([job({ id: 1, job_number: "A", pickup_date: "2026-09-20" }),
          job({ id: 2, job_number: "B", pickup_date: "2026-09-20" })]).length === 2);
// jobKey falls back to the row id when the number is blank, so these must not merge.
check("rows with no job_number do not all merge into one",
  groups([job({ id: 1, job_number: "", pickup_date: "2026-09-20" }),
          job({ id: 2, job_number: "", pickup_date: "2026-09-20" })]).length === 2);

console.log("\nFields coalesce across a job's rows");
// The bug this guards: row zero has the pickup, a later row has the delivery.
const scattered = [
  job({ id: 1, job_number: "J7", pickup_date: "2026-09-20",
        delivery_address: "", delivery_city: "", delivery_state: "", delivery_zip: "" }),
  job({ id: 2, job_number: "J7", pickup_date: "2026-09-20",
        pickup_address: "", pickup_city: "", pickup_state: "", pickup_zip: "",
        delivery_address: "2 Oak Ave", delivery_city: "Newark", delivery_state: "NJ", delivery_zip: "07102" }),
];
const merged = groups(scattered)[0];
check("the pickup comes off whichever row has it", merged.pickup_city === "Miami", merged.pickup_city);
check("the delivery comes off whichever row has it", merged.delivery_city === "Newark", merged.delivery_city);
// Same trap for the date that decides whether the job is on the map at all.
check("a date on a later row still puts the job in the window",
  groups([job({ id: 1, job_number: "J8" }), job({ id: 2, job_number: "J8", delivery_date: "2026-09-20" })]).length === 1);

console.log("\nStops");
// Stand-in for App.jsx's geoCandidates: enough to tell "has an address" apart
// from "has nothing", which is all mapJobStops actually asks of it.
const geoCandidates = ({ address, city, state, zip }) =>
  [[address, city, state, zip].filter(Boolean).join(", ")].filter(Boolean);
const stopsFor = (jobs) => mapJobStops(jobs, { from: FROM, days: JOB_PIN_DAYS, geoCandidates });

const both = stopsFor([job({ pickup_date: "2026-09-20" })]);
check("a job with both addresses gets two stops", both[0].stops.length === 2);
check("the stops are a pickup and a delivery",
  keys(both[0].stops).join("|") === "job:n:j1:delivery|job:n:j1:pickup",
  keys(both[0].stops).join("|"));
check("a job with no delivery address gets only the pickup",
  stopsFor([job({ pickup_date: "2026-09-20", delivery_address: "", delivery_city: "", delivery_state: "", delivery_zip: "" })])[0].stops.length === 1);
check("a job with no address at all is dropped entirely",
  stopsFor([job({ pickup_date: "2026-09-20",
    pickup_address: "", pickup_city: "", pickup_state: "", pickup_zip: "",
    delivery_address: "", delivery_city: "", delivery_state: "", delivery_zip: "" })]).length === 0);
check("stop keys are unique across jobs",
  new Set(stopsFor([job({ id: 1, job_number: "A", pickup_date: "2026-09-20" }),
                    job({ id: 2, job_number: "B", pickup_date: "2026-09-20" })])
    .flatMap(s => s.stops.map(x => x.key))).size === 4);
check("an empty job list is handled", stopsFor([]).length === 0 && groups([]).length === 0);

console.log(failures ? `\n${failures} test(s) failed.` : "\nAll geo-pin tests passed.");
process.exit(failures ? 1 : 0);
