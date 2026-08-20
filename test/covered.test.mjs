// Tests for the skipWhenCovered setting: don't create pins in a window when some OTHER
// normal window already has them — every pin under coverageMode "all" (the default), or
// even one pin under coverageMode "any". Covers the pure predicate and the wiring inside
// reconcileWindow (including that cleanup/reorder still run, and that opts.force
// overrides the skip).
import { windowCoversPins, reconcileWindow } from "../src/reconcile.js";

let pass = 0, fail = 0; const fails = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

const X = "https://mail.google.com/mail/u/0/#inbox";
const GH = "https://github.com/anthropics/claude-code";
const PINS = [{ url: X, match: "smart" }, { url: GH, match: "smart" }];

// --- windowCoversPins ------------------------------------------------------------

check("all pins pinned -> covered",
  windowCoversPins(PINS, [
    { id: 1, index: 0, url: X, pinned: true },
    { id: 2, index: 1, url: GH, pinned: true },
  ]), true);

check("one pin missing -> not covered",
  windowCoversPins(PINS, [{ id: 1, index: 0, url: X, pinned: true }]), false);

check("pin's URL open but UNPINNED -> not covered",
  windowCoversPins(PINS, [
    { id: 1, index: 0, url: X, pinned: true },
    { id: 2, index: 1, url: GH, pinned: false },
  ]), false);

// A pinned tab that has wandered within its origin still represents its pin (the drift
// pass in assignPinsToTabs), so the window still counts as covered.
check("drifted pinned tab still covers its pin",
  windowCoversPins(PINS, [
    { id: 1, index: 0, url: "https://mail.google.com/mail/u/0/#inbox/FMfcgz123", pinned: true },
    { id: 2, index: 1, url: "https://github.com/anthropics/claude-code/issues/9", pinned: true },
  ]), true);

check("empty pin list is never covering", windowCoversPins([], [{ id: 1, index: 0, url: X, pinned: true }]), false);

check("extra unrelated pinned tabs don't break coverage",
  windowCoversPins(PINS, [
    { id: 9, index: 0, url: "https://example.com/", pinned: true },
    { id: 1, index: 1, url: X, pinned: true },
    { id: 2, index: 2, url: GH, pinned: true },
  ]), true);

// coverageMode "any": one pin is enough, but zero is not.
check("any-mode: one of two pins covers",
  windowCoversPins(PINS, [{ id: 1, index: 0, url: X, pinned: true }], "any"), true);

check("any-mode: no pins at all does not cover",
  windowCoversPins(PINS, [{ id: 9, index: 0, url: "https://example.com/", pinned: true }], "any"), false);

check("any-mode: an unpinned tab is still not coverage",
  windowCoversPins(PINS, [{ id: 1, index: 0, url: X, pinned: false }], "any"), false);

check("any-mode: no tabs at all does not cover", windowCoversPins(PINS, [], "any"), false);

check("any-mode: full coverage still counts",
  windowCoversPins(PINS, [
    { id: 1, index: 0, url: X, pinned: true },
    { id: 2, index: 1, url: GH, pinned: true },
  ], "any"), true);

// --- reconcileWindow wiring ---------------------------------------------------------

// Same shape as test/reconcile.test.mjs's mock, plus windows.getAll (which the coverage
// lookup needs) and a settings object the test can control.
function makeChrome({ pins, windows, settings }) {
  const state = {
    windows: new Map(windows.map((w) => [w.id, w])),
    nextId: 1000,
    log: [],
  };
  const shape = (w) => ({ id: w.id, type: "normal", incognito: false, tabs: w.tabs });
  globalThis.chrome = {
    runtime: { lastError: undefined },
    storage: { sync: { get: async (key) => (key === "pins" ? { pins } : { settings: settings || {} }) } },
    windows: {
      get: async (id) => {
        const w = state.windows.get(id);
        if (!w) throw new Error("no such window");
        return shape(w);
      },
      getAll: async () => [...state.windows.values()].map(shape),
    },
    tabs: {
      create: (opts, cb) => {
        const w = state.windows.get(opts.windowId);
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

const covering = () => ({ id: 1, tabs: [
  { id: 1, index: 0, url: X, pinned: true },
  { id: 2, index: 1, url: GH, pinned: true },
] });

// The whole point: a bare new window stays bare while window 1 has the full set.
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: true },
    windows: [covering(), { id: 2, tabs: [{ id: 3, index: 0, url: "chrome://newtab/", pinned: false }] }],
  });
  await reconcileWindow(2);
  check("covered window gets no pins", state.log, []);
  check("covered window still has just its one tab", state.windows.get(2).tabs.length, 1);
}

// Turned off explicitly -> the old put-them-in-every-window behavior.
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: false },
    windows: [covering(), { id: 2, tabs: [{ id: 3, index: 0, url: "chrome://newtab/", pinned: false }] }],
  });
  await reconcileWindow(2);
  check("setting off pins every window", state.log, ["create:2:" + X, "create:2:" + GH]);
}

// ...and it is on out of the box, with no stored settings at all.
{
  const state = makeChrome({
    pins: PINS,
    settings: {},
    windows: [covering(), { id: 2, tabs: [{ id: 3, index: 0, url: "chrome://newtab/", pinned: false }] }],
  });
  await reconcileWindow(2);
  check("skipping is the default", state.log, []);
}

// The coverageMode setting, on identical state: window 1 holds one of the two pins.
const partial = () => [
  { id: 1, tabs: [{ id: 1, index: 0, url: X, pinned: true }] },
  { id: 2, tabs: [{ id: 3, index: 0, url: "chrome://newtab/", pinned: false }] },
];

// "all" (default): missing even one pin means window 1 isn't covering, so window 2 gets
// the full set.
{
  const state = makeChrome({ pins: PINS, settings: { skipWhenCovered: true }, windows: partial() });
  await reconcileWindow(2);
  check("all-mode: partial coverage does not skip", state.log, ["create:2:" + X, "create:2:" + GH]);
}
{
  const state = makeChrome({ pins: PINS, settings: { skipWhenCovered: true, coverageMode: "all" }, windows: partial() });
  await reconcileWindow(2);
  check("all-mode is the explicit default too", state.log, ["create:2:" + X, "create:2:" + GH]);
}

// "any": one pin in window 1 is enough, so window 2 stays bare.
{
  const state = makeChrome({ pins: PINS, settings: { skipWhenCovered: true, coverageMode: "any" }, windows: partial() });
  await reconcileWindow(2);
  check("any-mode: partial coverage skips", state.log, []);
}

// "any" still pins a window when NO other window has a single pin.
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: true, coverageMode: "any" },
    windows: [
      { id: 1, tabs: [{ id: 1, index: 0, url: "https://example.com/", pinned: true }] },
      { id: 2, tabs: [{ id: 3, index: 0, url: "chrome://newtab/", pinned: false }] },
    ],
  });
  await reconcileWindow(2);
  check("any-mode: zero coverage still pins", state.log, ["create:2:" + X, "create:2:" + GH]);
}

// A window never covers itself: the only window open still gets its pins.
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: true },
    windows: [covering()],
  });
  await reconcileWindow(1, { skipCreate: false });
  check("sole covering window is not skipped into emptiness", state.log, []);
}
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: true },
    windows: [{ id: 1, tabs: [{ id: 1, index: 0, url: "chrome://newtab/", pinned: false }] }],
  });
  await reconcileWindow(1);
  check("only window still gets pinned", state.log, ["create:1:" + X, "create:1:" + GH]);
}

// "Apply to this window" and the close-handoff pass force:true and must always pin.
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: true },
    windows: [covering(), { id: 2, tabs: [{ id: 3, index: 0, url: "chrome://newtab/", pinned: false }] }],
  });
  await reconcileWindow(2, { force: true });
  check("force overrides the skip", state.log, ["create:2:" + X, "create:2:" + GH]);
}

// Skipping creation must not skip the rest: a covered window whose own pinned tabs are
// out of order still gets reordered.
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: true },
    windows: [covering(), { id: 2, tabs: [
      { id: 3, index: 0, url: GH, pinned: true },
      { id: 4, index: 1, url: X, pinned: true },
    ] }],
  });
  await reconcileWindow(2);
  check("covered window is still reordered", state.log, ["move:4,3"]);
}

// An incognito window is never a covering window.
{
  const state = makeChrome({
    pins: PINS,
    settings: { skipWhenCovered: true },
    windows: [covering(), { id: 2, tabs: [{ id: 3, index: 0, url: "chrome://newtab/", pinned: false }] }],
  });
  state.windows.get(1).tabs.forEach(() => {});
  const realGetAll = globalThis.chrome.windows.getAll;
  globalThis.chrome.windows.getAll = async () =>
    (await realGetAll()).map((w) => (w.id === 1 ? { ...w, incognito: true } : w));
  await reconcileWindow(2);
  check("incognito window never covers", state.log, ["create:2:" + X, "create:2:" + GH]);
}

console.log(`Covered-window tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
