// The carrier-dispatch math and texts live in lib/ so the serverless inbox can
// import them with an unambiguous .mjs extension; the app imports them from here.
export * from "../lib/carriers.mjs";
