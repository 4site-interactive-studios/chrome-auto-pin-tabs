// drift.test.mjs — the assignment logic that tolerates URL drift in pinned tabs.
// Encodes the reported bug: pinned tabs are present but their URLs have wandered, and
// the extension used to create duplicates next to them.
import { assignPinsToTabs } from "../src/reconcile.js";

let pass = 0, fail = 0; const fails = [];
// missing(pins, tabs) -> labels of pins the creation step would create
function missing(pins, tabs) {
  const byPin = assignPinsToTabs(pins, tabs);
  return pins.filter((p) => !byPin.has(p)).map((p) => p.label);
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

const ORG = "https://app.productive.io/2650-4site-interactive-studios-inc";
const pTasks = { label: "tasks", url: `${ORG}/tasks`, match: "smart" };
const pFilter = { label: "filtered", url: `${ORG}/tasks?filter=ABC`, match: "exact" };
const pTime = { label: "time", url: `${ORG}/time/me`, match: "smart" };
const pGmail = { label: "gmail", url: "https://mail.google.com/mail/u/0/#inbox", match: "smart" };

// THE reported bug: the pinned tasks tab drifted to an open task. Must NOT be recreated.
eq("drifted pinned tab satisfies its pin",
  missing([pTasks], [{ id: "a", pinned: true, url: `${ORG}/tasks/8412` }]),
  []);

// Exact filtered pin whose tab drifted after clicking around. Must NOT be recreated.
eq("drifted exact pin satisfied by origin pass",
  missing([pFilter], [{ id: "a", pinned: true, url: `${ORG}/tasks/999` }]),
  []);

// Two productive pins, one drifted: the undrifted one claims by mode, the drifted one
// by origin. Nothing recreated.
eq("one drifted + one intact, both satisfied",
  missing([pTasks, pTime], [
    { id: "a", pinned: true, url: `${ORG}/projects/9` },
    { id: "b", pinned: true, url: `${ORG}/time/me` },
  ]),
  []);

// Both drifted: both claimed by origin, none recreated.
eq("both drifted, both satisfied",
  missing([pTasks, pTime], [
    { id: "a", pinned: true, url: `${ORG}/projects/9` },
    { id: "b", pinned: true, url: `${ORG}/tasks/1` },
  ]),
  []);

// Origin tolerance never crosses sites: a drifted productive tab can't satisfy gmail.
eq("origin pass does not cross origins",
  missing([pGmail], [{ id: "a", pinned: true, url: `${ORG}/tasks/1` }]),
  ["gmail"]);

// Only PINNED tabs count for drift: an unpinned same-origin tab doesn't satisfy a pin.
eq("unpinned same-origin tab does not satisfy",
  missing([pTasks], [{ id: "a", pinned: false, url: `${ORG}/projects/9` }]),
  ["tasks"]);

// An unpinned tab that matches the pin's own mode still satisfies (pass 2, old behavior).
eq("unpinned exact-path tab still satisfies via mode",
  missing([pTasks], [{ id: "a", pinned: false, url: `${ORG}/tasks` }]),
  []);

// Fresh window: nothing there, everything created.
eq("fresh window creates all",
  missing([pTasks, pTime, pGmail], []),
  ["tasks", "time", "gmail"]);

// A properly-matching tab is claimed by ITS pin before the origin pass can give it away:
// time/me tab goes to the time pin (pass 2), so the tasks pin is created, not fed the
// time tab.
eq("origin pass cannot steal a mode-matched tab",
  missing([pTasks, pTime], [{ id: "b", pinned: true, url: `${ORG}/time/me` }]),
  ["tasks"]);

console.log(`Drift tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
