import { keyFor } from "../src/matcher.js";
let pass = 0, fail = 0; const fails = [];
function eqArr(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`));
}
function simulateCleanup(tabs) {
  const removed = [];
  const pinned = tabs.filter((t) => t.pinned);
  const pinnedUrls = new Set(pinned.map((t) => keyFor(t.url, "exact")));
  for (const t of tabs) if (!t.pinned && pinnedUrls.has(keyFor(t.url, "exact"))) removed.push(t.id);
  const seen = new Set();
  for (const t of pinned.slice().sort((a, b) => a.index - b.index)) {
    const k = keyFor(t.url, "exact");
    if (seen.has(k)) removed.push(t.id); else seen.add(k);
  }
  return removed.sort();
}
const X = "https://mail.google.com/mail/u/0/#inbox";
const T = "https://app.productive.io/2650-4site-interactive-studios-inc/tasks";
const TF = T + "?filter=ABC";
eqArr("removes unpinned twin", simulateCleanup([{ id: "a", index: 0, url: X, pinned: true }, { id: "b", index: 5, url: X, pinned: false }]), ["b"]);
eqArr("collapses duplicate pinned", simulateCleanup([{ id: "a", index: 0, url: X, pinned: true }, { id: "b", index: 1, url: X, pinned: true }, { id: "c", index: 2, url: X, pinned: true }]), ["b", "c"]);
eqArr("keeps distinct views", simulateCleanup([{ id: "a", index: 0, url: T, pinned: true }, { id: "b", index: 1, url: TF, pinned: true }]), []);
eqArr("combined", simulateCleanup([{ id: "a", index: 0, url: X, pinned: true }, { id: "b", index: 1, url: TF, pinned: true }, { id: "c", index: 2, url: X, pinned: true }, { id: "d", index: 3, url: X, pinned: false }]), ["c", "d"]);
console.log(`Cleanup tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
