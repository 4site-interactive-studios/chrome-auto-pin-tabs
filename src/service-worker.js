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

import { reconcileWindow } from "./reconcile.js";
import { getSettings } from "./storage.js";

const POLL_MS = 700; // gap between stability checks
const MAX_SETTLE_MS = 20000; // stop waiting after this and reconcile anyway
const RECHECK_MS = 3500; // after reconciling, one late pass to catch a duplicate that arrives after
const settling = new Set(); // windowIds currently being settled, so we don't stack loops

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

// Toolbar button opens the management page.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Messages from the options page. "applyNow" reconciles the most recently focused normal
// window so edits show up without opening a new window.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "applyNow") {
    chrome.windows
      .getLastFocused({ windowTypes: ["normal"] })
      .then((w) => reconcileWindow(w.id))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // keep the channel open for the async response
  }
  return false;
});
