// Tiny shared "banked" helpers, extracted so the pure bank-reconciliation math
// (src/bankData.js) can import them and be unit-tested with plain node, instead
// of duplicating the rule that lives inline in App.jsx.
//
// Whether a payment counts as banked/deposited: digital methods are auto-banked
// (legacy rows may have banked = null), so they always count; physical
// cash/check/money_order count only when explicitly marked banked = true. A null
// banked on a physical payment is therefore "in circulation" (not banked).
import { isDigitalMethod } from "./analyticsData.js";

export const effectiveBanked = (p) => isDigitalMethod(p.method) ? true : p.banked === true;

// Deposit date, deriving one for digital rows auto-banked without a date.
export const bankedDateOf = (p) => p.banked_date || (isDigitalMethod(p.method) ? (p.received_date || p.payment_date || "") : "");
