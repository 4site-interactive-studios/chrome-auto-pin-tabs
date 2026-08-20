// Behavioral tests for the service worker's message handlers against a mocked
// chrome: pinCurrentTab (pin first, then store, then reconcile the tab's own
// window), its rejections, and identity-based removePin.
let pass = 0, fail = 0; const fails = [];
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

const state = {
  pins: [],
  windows: new Map(),
  activeTab: null,
  nextId: 1000,
  log: [],
  messageHandler: null,
  removedHandler: null,
  // The handler tests below predate single-window mode; keep it off so they exercise
  // plain reconcile behavior. The handoff tests at the bottom set their own settings.
  settings: { skipWhenCovered: false },
};

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => (state.messageHandler = fn) },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
  },
  windows: {
    onCreated: { addListener: () => {} },
    onRemoved: { addListener: (fn) => (state.removedHandler = fn) },
    getAll: async () => [...state.windows.values()].map((w) => ({ id: w.id, type: "normal", incognito: false, tabs: w.tabs })),
    getLastFocused: async () => ({ id: 1, type: "normal", incognito: false }),
    get: async (id) => {
      const w = state.windows.get(id);
      if (!w) throw new Error("no such window");
      return { id: w.id, type: "normal", incognito: false, tabs: w.tabs };
    },
  },
  storage: {
    sync: {
      get: async (key) => (key === "pins" ? { pins: state.pins } : { settings: state.settings }),
      set: async (obj) => { if (obj.pins) state.pins = obj.pins; },
    },
  },
  tabs: {
    query: async () => (state.activeTab ? [state.activeTab] : []),
    update: async (tabId, props) => {
      state.log.push(`update:${tabId}:${JSON.stringify(props)}`);
      for (const w of state.windows.values()) {
        const t = w.tabs.find((t) => t.id === tabId);
        if (t && "pinned" in props) t.pinned = props.pinned;
      }
    },
    create: (opts, cb) => {
      const w = state.windows.get(opts.windowId);
      const tab = { id: state.nextId++, index: opts.index, url: opts.url, pinned: !!opts.pinned };
      w.tabs.splice(opts.index, 0, tab);
      w.tabs.forEach((t, i) => (t.index = i));
      state.log.push(`create:${opts.windowId}:${opts.url}`);
      cb();
    },
    remove: (tabId, cb) => { state.log.push(`remove:${tabId}`); cb(); },
    move: (ids, opts, cb) => { state.log.push(`move:${ids.join(",")}`); cb(); },
  },
};

await import("../src/service-worker.js");

function dispatch(msg) {
  return new Promise((resolve) => {
    const returned = state.messageHandler(msg, {}, resolve);
    if (returned !== true) resolve({ ok: false, error: "handler returned sync" });
  });
}

const DASH = "https://example.com/dash";

// Happy path: tab is pinned FIRST, then the pin row lands in storage, then the
// tab's own window is reconciled (no create — the new pin claims the tab).
{
  state.pins = [];
  state.log = [];
  const tab = { id: 7, index: 0, url: DASH, title: "D".repeat(60), pinned: false, windowId: 1, incognito: false };
  state.windows.set(1, { id: 1, tabs: [tab] });
  state.activeTab = tab;
  const resp = await dispatch({ type: "pinCurrentTab" });
  eq("pinCurrentTab succeeds", resp.ok, true);
  eq("tab was pinned via tabs.update", state.log[0], 'update:7:{"pinned":true}');
  eq("pin row stored as smart with truncated label",
    [state.pins.length, state.pins[0].match, state.pins[0].label.length, !!state.pins[0].id],
    [1, "smart", 40, true]);
  eq("no duplicate tab created by reconcile", state.log.filter((l) => l.startsWith("create")).length, 0);
}

// Second click on the same tab: rejected as already-pin, nothing written.
{
  state.log = [];
  const before = state.pins.length;
  const resp = await dispatch({ type: "pinCurrentTab" });
  eq("repeat pin rejected", [resp.ok, resp.reason], [false, "already-pin"]);
  eq("no writes on rejection", [state.pins.length, state.log.length], [before, 0]);
}

// chrome:// pages can't become pins.
{
  state.log = [];
  state.activeTab = { id: 8, index: 1, url: "chrome://extensions/", title: "x", pinned: false, windowId: 1, incognito: false };
  const resp = await dispatch({ type: "pinCurrentTab" });
  eq("chrome page rejected", [resp.ok, resp.reason], [false, "not-http"]);
  eq("no tab update attempted", state.log.length, 0);
}

// Incognito tabs are refused before touching storage.
{
  state.activeTab = { id: 9, index: 0, url: DASH + "2", title: "x", pinned: false, windowId: 2, incognito: true };
  const resp = await dispatch({ type: "pinCurrentTab" });
  eq("incognito rejected", [resp.ok, resp.reason], [false, "no-tab"]);
}

// getPopupState reports status and named pin rows.
{
  state.activeTab = { id: 7, index: 0, url: DASH, title: "Dash", pinned: true, windowId: 1, incognito: false };
  const resp = await dispatch({ type: "getPopupState" });
  eq("state reports already-pin for covered tab", resp.tab.status, "already-pin");
  eq("state includes named pin rows", resp.pins.length > 0 && typeof resp.pins[0].name, "string");
}

// removePin removes by identity, leaving other rows alone.
{
  state.pins = [
    { id: "a", url: DASH, match: "smart", label: "keep-me-not" },
    { id: "b", url: DASH, match: "exact", label: "keep" },
  ];
  const resp = await dispatch({ type: "removePin", url: DASH, match: "smart" });
  eq("removePin ok", resp.ok, true);
  eq("only the identity row removed", state.pins.map((p) => p.id), ["b"]);
}

// renamePin updates only the label, trimmed; empty clears back to automatic.
{
  state.pins = [{ id: "r1", url: DASH, match: "smart", label: "Old" }];
  const resp = await dispatch({ type: "renamePin", id: "r1", url: DASH, match: "smart", label: "  Board  " });
  eq("renamePin ok", resp.ok, true);
  eq("label updated and trimmed", state.pins[0].label, "Board");
  await dispatch({ type: "renamePin", id: "r1", url: DASH, match: "smart", label: "" });
  eq("empty label clears the name", state.pins[0].label, "");
}

// reorderPins saves the order AND moves the actual pinned tabs to match.
{
  const UA = "https://a.example.com/";
  const UB = "https://b.example.com/";
  state.pins = [
    { id: "a", url: UA, match: "smart" },
    { id: "b", url: UB, match: "smart" },
  ];
  state.windows.set(1, { id: 1, tabs: [
    { id: 21, index: 0, url: UA, pinned: true },
    { id: 22, index: 1, url: UB, pinned: true },
  ] });
  state.activeTab = null;
  state.log = [];
  const resp = await dispatch({ type: "reorderPins", order: [
    { id: "b", url: UB, match: "smart" },
    { id: "a", url: UA, match: "smart" },
  ] });
  eq("reorderPins ok", resp.ok, true);
  eq("storage order updated", state.pins.map((p) => p.id), ["b", "a"]);
  eq("tabs moved to match the new order", state.log.filter((l) => l.startsWith("move")).length, 1);
  eq("move puts B's tab first", state.log.find((l) => l.startsWith("move")), "move:22,21");
}

// Unknown message types are ignored synchronously.
{
  const returned = state.messageHandler({ type: "nonsense" }, {}, () => {});
  eq("unknown type returns false", returned, false);
}

// --- Handoff after the covering window closes ---------------------------------------
// windows.onRemoved is a no-op unless skipWhenCovered AND repinOnClose are both on. The
// handler waits HANDOFF_MS (1.2s) before deciding, so each case sleeps past that.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function closeWindow(id) {
  state.windows.delete(id);
  state.removedHandler(id);
  await sleep(1500);
}

function resetHandoff({ settings }) {
  state.settings = settings;
  state.pins = [{ url: DASH, match: "smart" }];
  state.windows = new Map([[1, { id: 1, tabs: [{ id: 10, index: 0, url: "chrome://newtab/", pinned: false }] }]]);
  state.windows.set(2, { id: 2, tabs: [{ id: 20, index: 0, url: DASH, pinned: true }] });
  state.log = [];
}

// Parent setting off: closing the covering window changes nothing.
{
  resetHandoff({ settings: { skipWhenCovered: false } });
  await closeWindow(2);
  eq("handoff needs skipWhenCovered", state.log, []);
}

// Out of the box (no stored settings) both are on, so the handoff runs.
{
  resetHandoff({ settings: {} });
  await closeWindow(2);
  eq("handoff is on by default", state.log, [`create:1:${DASH}`]);
}

// Sub-option off: parent on, but the user declined the handoff.
{
  resetHandoff({ settings: { skipWhenCovered: true, repinOnClose: false } });
  await closeWindow(2);
  eq("handoff respects repinOnClose:false", state.log, []);
}

// Both on and nothing covers any more: the last-focused window gets the set.
{
  resetHandoff({ settings: { skipWhenCovered: true } });
  await closeWindow(2);
  eq("handoff pins the remaining window", state.log, [`create:1:${DASH}`]);
}

// Both on but another window still covers: leave everything alone.
{
  resetHandoff({ settings: { skipWhenCovered: true } });
  state.windows.set(3, { id: 3, tabs: [{ id: 30, index: 0, url: DASH, pinned: true }] });
  await closeWindow(2);
  eq("handoff is a no-op while another window covers", state.log, []);
}

// The handoff asks the same coverage question the skip does, so it must honor
// coverageMode: under "any" a window holding just one of two pins still counts.
{
  const OTHER = "https://example.com/other";
  resetHandoff({ settings: { skipWhenCovered: true, coverageMode: "any" } });
  state.pins = [{ url: DASH, match: "smart" }, { url: OTHER, match: "smart" }];
  state.windows.set(3, { id: 3, tabs: [{ id: 30, index: 0, url: DASH, pinned: true }] });
  await closeWindow(2);
  eq("handoff honors coverageMode any", state.log, []);
}

console.log(`Message tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
