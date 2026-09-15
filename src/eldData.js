// The two ELDs the CRM reads, as plain data so both src/App.jsx and
// src/reports.jsx can share it without one importing the other.
//
// A truck (or a driver) is on ONE provider — whichever link field it carries.
// The forms clear the other field on save, so these lookups never have to
// resolve a row that claims both.

export const ELD = {
  verizon: {
    letter: "V",
    name: "Verizon Connect",
    truckField: "verizon_vehicle_id",
    driverField: "verizon_driver_id",
    bg: "#E6F0FA",
    text: "#185FA5",
  },
  motive: {
    letter: "M",
    name: "Motive",
    truckField: "motive_vehicle_id",
    driverField: "motive_driver_id",
    bg: "#EDE7FB",
    text: "#5B3FBF",
  },
};

export const ELD_KEYS = ["verizon", "motive"];

// Motive is checked first only to make the result deterministic for a row that
// somehow carries both links — it is not a preference.
export const eldOfTruck = (t) => (t?.motive_vehicle_id ? "motive" : t?.verizon_vehicle_id ? "verizon" : null);
export const eldOfDriver = (d) => (d?.motive_driver_id ? "motive" : d?.verizon_driver_id ? "verizon" : null);
