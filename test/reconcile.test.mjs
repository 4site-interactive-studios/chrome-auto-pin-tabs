// Behavioral tests for reconcileWindow against a mocked chrome. These cover the
// wiring the pure-function suites can't see: which window created tabs land in,
// single-create for same-URL pin rows, and that a satisfied pass is idempotent
// (no create/remove churn).
import { reconcileWindow } from "../src/reconcile.js";

let pass = 0, fail = 0; const fails = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

// Minimal chrome mock. tabs.create honors windowId; if it is missing, the tab lands
// in the FOCUSED window, mimicking real Chrome — which is exactly the original bug.
function makeChrome({ pins, windows, focusedWindowId }) {
  const state = {
    windows: new Map(windows.map((w) => [w.id, w])),
    nextId: 1000,
    log: [],
  };
  const shape = (w) => ({ id: w.id, type: "normal", incognito: false, tabs: w.tabs });
  globalThis.chrome = {
    runtime: { lastError: undefined },
    storage: { sync: { get: async (key) => (key === "pins" ? { pins } : { settings: {} }) } },
    windows: {
      get: async (id) => {
        const w = state.windows.get(id);
        if (!w) throw new Error("no such window");
        return shape(w);
      },
      // Needed by the coverage check behind skipWhenCovered, which is on by default.
      getAll: async () => [...state.windows.values()].map(shape),
    },
    tabs: {
      create: (opts, cb) => {
        const w = state.windows.get(opts.windowId ?? focusedWindowId);
        const tab = { id: state.nextId++, index: opts.index, url: opts.url, pinned: !!opts.pinned };
        w.tabs.splice(opts.index, 0, tab);
        w.tabs.forEach((t, i) => (t.index = i));
        state.log.push(`create:${w.id}:${opts.url}`);
        cb();
      },
      remove: (tabId, cb) => {
        for (const w of state.windows.values()) {
          const i = w.tabs.findIndex((t) => t.id === tabId);
          if (i >= 0) { w.tabs.splice(i, 1); w.tabs.forEach((t, j) => (t.index = j)); }
        }
        state.log.push(`remove:${tabId}`);
        cb();
      },
      move: (ids, opts, cb) => { state.log.push(`move:${ids.join(",")}`); cb(); },
    },
  };
  return state;
}

const X = "https://mail.google.com/mail/u/0/#inbox";
const GH = "https://github.com/anthropics/claude-code";

// The original duplicate-pins bug: creation must target the window being reconciled,
// never the focused one — otherwise a multi-window restore piles every window's pin
// set into whichever window has focus.
{
  const state = makeChrome({
    pins: [{ url: X, match: "smart" }],
    windows: [
      { id: 1, tabs: [{ id: 1, index: 0, url: "https://example.com/", pinned: false }] },
      { id: 2, tabs: [{ id: 2, index: 0, url: "https://example.com/", pinned: false }] },
    ],
    focusedWindowId: 1,
  });
  await reconcileWindow(2);
  check("creates in reconciled window", state.log, ["create:2:" + X]);
  check("focused window untouched", state.windows.get(1).tabs.length, 1);
  check("reconciled window gained the pin",
    state.windows.get(2).tabs.filter((t) => t.pinned && t.url === X).length, 1);
}

// Two rows sharing one URL under different modes must produce ONE tab, not two.
{
  const state = makeChrome({
    pins: [{ url: GH, match: "exact" }, { url: GH, match: "path" }],
    windows: [{ id: 1, tabs: [{ id: 1, index: 0, url: "chrome://newtab/", pinned: false }] }],
    focusedWindowId: 1,
  });
  await reconcileWindow(1);
  check("same-URL rows create once", state.log, ["create:1:" + GH]);
}

// A window that already satisfies its pins is left completely alone, pass after pass
// — including with same-URL rows, which used to churn create+remove every pass.
{
  const state = makeChrome({
    pins: [{ url: GH, match: "exact" }, { url: GH, match: "path" }],
    windows: [{ id: 1, tabs: [{ id: 1, index: 0, url: GH, pinned: true }] }],
    focusedWindowId: 1,
  });
  await reconcileWindow(1);
  await reconcileWindow(1);
  check("satisfied window is never churned", state.log, []);
}

// The recheck pass (skipCreate) on a clean window changes nothing either.
{
  const state = makeChrome({
    pins: [{ url: X, match: "smart" }],
    windows: [{ id: 1, tabs: [{ id: 1, index: 0, url: X, pinned: true }] }],
    focusedWindowId: 1,
  });
  await reconcileWindow(1, { skipCreate: true });
  check("skipCreate recheck is quiet on a clean window", state.log, []);
}

console.log(`Reconcile tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
