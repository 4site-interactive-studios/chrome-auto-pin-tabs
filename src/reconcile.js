import { keyFor } from "./matcher.js";
import { getPins, getSettings } from "./storage.js";

// reconcile.js
// The heart of the extension. reconcileWindow brings a single window in line with the
// configured pin list: it adds any pin that isn't already present, then (optionally)
// removes Chrome's own restore duplicates. It is idempotent. Running it twice on the
// same window does nothing the second time, which is what makes the startup sweep and
// the per-window listener safe to overlap.


const CREATE_RETRY_MS = 120;
const DRAG_ERROR = /tabs cannot be edited right now/i;

// Per-window lock. Prevents the startup sweep and the onCreated handler from
// reconciling the same window at the same time and racing to create the same pin.
// Module state is ephemeral in an MV3 worker, which is fine: it only needs to hold
// for the brief moment two handlers might overlap.
const inFlight = new Set();

function tabUrl(tab) {
  return tab.url || tab.pendingUrl || "";
}

// Create a pinned tab, retrying through the brief window where Chrome refuses edits
// because the user is mid tab-drag. Other errors are logged and swallowed so one bad
// pin can't abort the whole pass.
function createPinned(url, index) {
  return new Promise((resolve) => {
    const attempt = () => {
      chrome.tabs.create({ url, pinned: true, index, active: false }, () => {
        const err = chrome.runtime.lastError;
        if (err && DRAG_ERROR.test(err.message || "")) {
          setTimeout(attempt, CREATE_RETRY_MS);
          return;
        }
        if (err) console.warn("[auto-pin] create failed:", err.message, url);
        resolve();
      });
    };
    attempt();
  });
}

function removeTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      void chrome.runtime.lastError; // ignore: tab may already be gone
      resolve();
    });
  });
}

// Move a list of tabs to consecutive positions starting at `index`, in the given order.
// Retries through the brief "user is dragging a tab" window.
function moveTabs(tabIds, index) {
  return new Promise((resolve) => {
    const attempt = () => {
      chrome.tabs.move(tabIds, { index }, () => {
        const err = chrome.runtime.lastError;
        if (err && DRAG_ERROR.test(err.message || "")) {
          setTimeout(attempt, CREATE_RETRY_MS);
          return;
        }
        if (err) console.warn("[auto-pin] move failed:", err.message);
        resolve();
      });
    };
    attempt();
  });
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Assign each pin the one open tab that represents it, across all pins at once. Three
// passes, strictest first, each tab claimable once:
//   1) exact full URL
//   2) the pin's own match mode
//   3) drift tolerance: a PINNED tab on the pin's origin that nothing claimed. A pinned
//      tab is a live app; its URL wanders as you use it (open a task, click a thread).
//      Without this pass a drifted pinned tab stops matching its pin after a restore and
//      a duplicate gets created right next to it.
// Pass order is what keeps pass 3 safe: any tab that properly matches some pin is
// claimed in passes 1-2 before origin matching ever runs.
export function assignPinsToTabs(pins, tabs) {
  const byPin = new Map(); // pin -> tab
  const claimed = new Set(); // tab ids
  for (const pin of pins) {
    const pe = keyFor(pin.url, "exact");
    const t = tabs.find((t) => !claimed.has(t.id) && keyFor(tabUrl(t), "exact") === pe);
    if (t) {
      byPin.set(pin, t);
      claimed.add(t.id);
    }
  }
  for (const pin of pins) {
    if (byPin.has(pin)) continue;
    const mode = pin.match || "smart";
    const pk = keyFor(pin.url, mode);
    const t = tabs.find((t) => !claimed.has(t.id) && keyFor(tabUrl(t), mode) === pk);
    if (t) {
      byPin.set(pin, t);
      claimed.add(t.id);
    }
  }
  for (const pin of pins) {
    if (byPin.has(pin)) continue;
    const po = originOf(pin.url);
    if (!po) continue;
    const t = tabs.find((t) => !claimed.has(t.id) && t.pinned && originOf(tabUrl(t)) === po);
    if (t) {
      byPin.set(pin, t);
      claimed.add(t.id);
    }
  }
  return byPin;
}

// Work out the order pinned tabs SHOULD be in: configured pins first, in list order,
// then any other pinned tabs (manual ones) after, keeping their relative order. Uses the
// same assignment as creation, so a drifted tab orders under the pin that claimed it.
export function desiredPinnedOrder(pins, pinnedTabs) {
  const byPin = assignPinsToTabs(pins, pinnedTabs);
  const ordered = [];
  const used = new Set();
  for (const pin of pins) {
    const t = byPin.get(pin);
    if (t && !used.has(t.id)) {
      ordered.push(t);
      used.add(t.id);
    }
  }
  for (const t of pinnedTabs) if (!used.has(t.id)) ordered.push(t);
  return ordered;
}

export async function reconcileWindow(windowId, opts = {}) {
  if (inFlight.has(windowId)) return;
  inFlight.add(windowId);
  try {
    const [pins, settings] = await Promise.all([getPins(), getSettings()]);
    if (!pins.length) return;

    let win;
    try {
      win = await chrome.windows.get(windowId, { populate: true });
    } catch {
      return; // window already closed
    }
    if (win.type !== "normal" || win.incognito) return;

    const tabsAtStart = win.tabs || [];
    // Restore signature, measured BEFORE we touch anything: a window that arrived
    // already carrying pinned tabs is a session restore (or an explicitly populated
    // window), not a fresh Ctrl+N. Cleanup keys off this so it never runs on a fresh
    // window or as a side effect of our own pinning.
    const arrivedWithPinned = tabsAtStart.some((t) => t.pinned);

    // 1) Add any missing pins, in configured order, packed to the left. A pin is
    //    "present" when the assignment gives it a tab: exact match first, then its own
    //    match mode, then the drift-tolerant origin pass (see assignPinsToTabs). This is
    //    what stops a pinned tab you've navigated around in from being duplicated.
    // opts.skipCreate is used by the late-restore recheck: it re-runs cleanup and
    // reorder to catch a duplicate that materialized after the first pass, without
    // recreating a pin the user may have deliberately closed in the meantime.
    if (!opts.skipCreate) {
      const byPin = assignPinsToTabs(pins, tabsAtStart);
      const createdThisPass = new Set(); // "mode::key" created, dedupes identical rows
      let index = 0;
      for (const pin of pins) {
        const mode = pin.match || "smart";
        const composite = mode + "::" + keyFor(pin.url, mode);
        if (byPin.has(pin) || createdThisPass.has(composite)) {
          index++; // already here (restored, drifted, or duplicate row): hold its slot
          continue;
        }
        await createPinned(pin.url, index);
        createdThisPass.add(composite);
        index++;
      }
    }

    // 2) Re-query so we see the restored tabs plus anything we just created. Then clean
    // up duplicates (restore-scoped) and, finally, put every pinned tab back into the
    // order defined by the pin list. All URL comparisons here are exact, so only true
    // identical copies are ever removed.
    let after;
    try {
      after = await chrome.windows.get(windowId, { populate: true });
    } catch {
      after = null;
    }
    const tabs2 = (after && after.tabs) || tabsAtStart;
    const removed = new Set();

    if (settings.cleanupTwins && (arrivedWithPinned || opts.skipCreate)) {
      const pinnedNow = tabs2.filter((t) => t.pinned);
      const pinnedUrls = new Set(pinnedNow.map((t) => keyFor(tabUrl(t), "exact")));

      // (a) Unpinned copy of a pinned tab (Chrome's restore-twin bug).
      for (const t of tabs2) {
        if (!t.pinned && pinnedUrls.has(keyFor(tabUrl(t), "exact"))) {
          await removeTab(t.id);
          removed.add(t.id);
        }
      }
      // (b) Duplicate pinned tabs with the same URL: keep the leftmost.
      const seen = new Set();
      for (const t of pinnedNow.slice().sort((a, b) => a.index - b.index)) {
        const k = keyFor(tabUrl(t), "exact");
        if (seen.has(k)) {
          await removeTab(t.id);
          removed.add(t.id);
        } else {
          seen.add(k);
        }
      }
    }

    // 3) Reorder. Arrange the surviving pinned tabs to match the pin list. Skipped when
    // they are already in the right order, so a window that's already correct (a fresh
    // Ctrl+N, or an untouched restore) is never disturbed.
    const surviving = tabs2
      .filter((t) => t.pinned && !removed.has(t.id))
      .sort((a, b) => a.index - b.index);
    if (surviving.length > 1) {
      const currentIds = surviving.map((t) => t.id);
      const desiredIds = desiredPinnedOrder(pins, surviving).map((t) => t.id);
      if (desiredIds.join(",") !== currentIds.join(",")) {
        await moveTabs(desiredIds, 0);
      }
    }
  } finally {
    inFlight.delete(windowId);
  }
}

export async function reconcileAllWindows() {
  let windows;
  try {
    windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  } catch {
    return;
  }
  for (const w of windows) {
    await reconcileWindow(w.id);
  }
}