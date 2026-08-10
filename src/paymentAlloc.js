// The payment-allocation math lives in lib/ so the serverless agent can import
// it with an unambiguous .mjs extension; the app keeps importing it from here.
export * from "../lib/paymentAlloc.mjs";
