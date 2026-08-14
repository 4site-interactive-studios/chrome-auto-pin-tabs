import { desiredPinnedOrder } from "../src/reconcile.js";
let pass = 0, fail = 0; const fails = [];
function order(name, pins, tabs, expectIds) {
  const got = desiredPinnedOrder(pins, tabs).map((t) => t.id);
  const ok = JSON.stringify(got) === JSON.stringify(expectIds);
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(expectIds)}`));
}
const T = "https://app.productive.io/2650-4site-interactive-studios-inc/tasks";
const TF = T + "?filter=ABC";
const TIME = "https://app.productive.io/2650-4site-interactive-studios-inc/time/me";
const G = "https://mail.google.com/mail/u/0/#inbox";
order("restored out of order -> list order",
  [{ url: T, match: "smart" }, { url: TIME, match: "smart" }, { url: G, match: "smart" }],
  [{ id: "g", url: G, index: 0 }, { id: "t", url: T, index: 1 }, { id: "tm", url: TIME, index: 2 }],
  ["t", "tm", "g"]);
order("plain and filtered keep own slots",
  [{ url: T, match: "smart" }, { url: TF, match: "exact" }],
  [{ id: "f", url: TF, index: 0 }, { id: "p", url: T, index: 1 }], ["p", "f"]);
order("manual pin trails configured",
  [{ url: T, match: "smart" }],
  [{ id: "x", url: G, index: 0 }, { id: "p", url: T, index: 1 }], ["p", "x"]);
order("missing pin skipped",
  [{ url: T, match: "smart" }, { url: G, match: "smart" }],
  [{ id: "p", url: T, index: 0 }], ["p"]);
console.log(`Order tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
