// service-worker.js
// Event entry points and scheduling. Every listener is registered synchronously at the
// top level so the worker reliably wakes for these events.
//
// Scheduling watches the actual tab set rather than tab events. The earlier event-based
// approach could miss a session restore's early tab events (the worker isn't awake yet
// when they fire on cold start), end its wait too soon, and reconcile against a
// half-restored window, which recreated the tabs that were about to come back. Instead
// we poll the window's tabs until they stop changing (two identical snapshots in a row),
// then reconcile. Polling has a second benefit: the repeated API calls keep the worker
// alive through a long restore.

import { reconcileWindow, preparePinForTab, removePinByIdentity, renamePinByIdentity, reorderPinsByIdentity, pinDisplayName, findCoveringWindow, dedupePins } from "./reconcile.js";
import { getPins, setPins, getSettings } from "./storage.js";

const POLL_MS = 700; // gap between stability checks
const MAX_SETTLE_MS = 20000; // stop waiting after this and reconcile anyway
const RECHECK_MS = 3500; // after reconciling, one late pass to catch a duplicate that arrives after
const settling = new Set(); // windowIds currently being settled, so we don't stack loops
const HANDOFF_MS = 1200; // let a quit or a multi-window close finish before reacting to it

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A stable fingerprint of a window's tabs: id + resolved URL, sorted. Returns null if the
// window is gone or isn't a normal window.
async function snapshot(windowId) {
  try {
    const win = await chrome.windows.get(windowId, { populate: true });
    if (win.type !== "normal" || win.incognito) return null;
    return (win.tabs || [])
      .map((t) => `${t.id}|${t.url || t.pendingUrl || ""}`)
      .sort()
      .join("\n");
  } catch {
    return null;
  }
}

async function settleAndReconcile(windowId) {
  if (settling.has(windowId)) return;
  settling.add(windowId);
  try {
    let prev = await snapshot(windowId);
    if (prev === null) return;
    const start = Date.now();
    // Wait until two consecutive snapshots match (tabs and their URLs have settled).
    while (Date.now() - start < MAX_SETTLE_MS) {
      await delay(POLL_MS);
      const cur = await snapshot(windowId);
      if (cur === null) return; // window closed mid-settle
      if (cur === prev) break; // settled
      prev = cur;
    }
    await reconcileWindow(windowId);
    // Late-restore safety net: a single delayed pass that only cleans up and reorders,
    // catching any duplicate that appeared after we reconciled without recreating pins.
    await delay(RECHECK_MS);
    await reconcileWindow(windowId, { skipCreate: true });
  } catch (e) {
    console.warn("[auto-pin] settle error:", e);
  } finally {
    settling.delete(windowId);
  }
}

// New window. Settle then reconcile, unless we're in startup-only mode.
chrome.windows.onCreated.addListener((win) => {
  if (!win || typeof win.id !== "number") return;
  getSettings()
    .then(({ applyMode }) => {
      if (applyMode === "startup_only") return;
      settleAndReconcile(win.id);
    })
    .catch((e) => console.warn("[auto-pin] onCreated settings error:", e));
});

// Cold start. Settle every existing normal window; polling waits out the restore.
chrome.runtime.onStartup.addListener(() => {
  chrome.windows
    .getAll({ windowTypes: ["normal"] })
    .then((wins) => wins.forEach((w) => settleAndReconcile(w.id)))
    .catch((e) => console.warn("[auto-pin] startup error:", e));
});

// Extension load or update. Windows are already populated, but settle for consistency.
chrome.runtime.onInstalled.addListener(() => {
  chrome.windows
    .getAll({ windowTypes: ["normal"] })
    .then((wins) => wins.forEach((w) => settleAndReconcile(w.id)))
    .catch((e) => console.warn("[auto-pin] install error:", e));
});

// A window closed. Only interesting under skipWhenCovered: if the window that was
// holding the pins is gone and nothing else covers them, hand the set to the window the
// user is now looking at. No-op for everyone else, so default behavior is unchanged.
// The delay lets a browser quit (or a burst of closes) finish first; during shutdown
// getLastFocused rejects and the catch swallows it.
chrome.windows.onRemoved.addListener((closedId) => {
  getSettings()
    .then(async ({ skipWhenCovered, repinOnClose, coverageMode }) => {
      if (!skipWhenCovered || !repinOnClose) return;
      await delay(HANDOFF_MS);
      const pins = dedupePins(await getPins());
      if (!pins.length) return;
      if ((await findCoveringWindow(pins, closedId, coverageMode)) !== null) return; // still covered
      const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      if (!w || w.incognito || w.type !== "normal") return;
      // force: by definition nothing covers right now, and this is a deliberate handoff.
      await reconcileWindow(w.id, { force: true });
    })
    .catch((e) => console.warn("[auto-pin] handoff error:", e));
});

// --- Popup support -------------------------------------------------------------
// The toolbar button opens popup.html (manifest action.default_popup), a thin view
// that talks to this worker via messages so matcher/storage logic lives in one place.

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || "pin-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

// The tab behind the popup: the popup's own window is by definition last-focused.
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return (tabs && tabs[0]) || null;
}

async function getPopupState() {
  const [tab, pins] = await Promise.all([activeTab(), getPins()]);
  const rows = pins.map((p) => ({
    id: p.id || "",
    url: p.url,
    match: p.match || "smart",
    label: p.label || "",
    name: pinDisplayName(p),
  }));
  // Incognito is rejected outright: a pin row would go into storage.sync and leak
  // the URL across devices, and reconcile skips incognito windows anyway.
  if (!tab || tab.incognito) {
    return { ok: true, tab: { title: "", url: "", status: "no-tab" }, pins: rows };
  }
  const url = tab.url || tab.pendingUrl || "";
  const state = { title: tab.title || "", url, status: "pinnable" };
  const prep = preparePinForTab(pins, url, tab.title);
  if (!prep.ok) {
    state.status = prep.reason;
    if (prep.existing) state.matchedName = pinDisplayName(prep.existing);
  }
  return { ok: true, tab: state, pins: rows };
}

async function pinCurrentTab() {
  const tab = await activeTab();
  if (!tab || tab.incognito) return { ok: false, reason: "no-tab" };
  const url = tab.url || tab.pendingUrl || "";
  const pins = await getPins(); // fresh read; never trust a cached list
  const prep = preparePinForTab(pins, url, tab.title);
  if (!prep.ok) return { ok: false, reason: prep.reason };
  // Pin the tab FIRST: reconcile never pins an existing tab, it only avoids
  // creating a second one next to it.
  await chrome.tabs.update(tab.id, { pinned: true });
  await setPins([...pins, { id: newId(), ...prep.pin }]);
  await reconcileWindow(tab.windowId);
  return { ok: true, pin: prep.pin };
}

// Messages from the popup and the options page. Every async branch returns true to
// keep the response channel open.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg && msg.type;
  if (type === "applyNow") {
    // Reconcile the most recently focused normal window so edits show up now.
    chrome.windows
      .getLastFocused({ windowTypes: ["normal"] })
      .then((w) => reconcileWindow(w.id, { force: true }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "getPopupState") {
    getPopupState()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "pinCurrentTab") {
    pinCurrentTab()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "removePin") {
    getPins()
      .then((pins) => setPins(removePinByIdentity(pins, msg.url, msg.match)))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "renamePin") {
    // Display-only: no reconcile needed, matching never looks at labels.
    getPins()
      .then((pins) => setPins(renamePinByIdentity(pins, msg, msg.label)))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "reorderPins") {
    // Save the new list order, then reconcile the window behind the popup so the
    // actual pinned tabs move to match right away.
    getPins()
      .then((pins) => setPins(reorderPinsByIdentity(pins, msg.order)))
      .then(() => chrome.windows.getLastFocused({ windowTypes: ["normal"] }))
      .then((w) => reconcileWindow(w.id))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
