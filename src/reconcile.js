import { keyFor, detectApp } from "./matcher.js";
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
function createPinned(windowId, url, index) {
  return new Promise((resolve) => {
    const attempt = () => {
      chrome.tabs.create({ windowId, url, pinned: true, index, active: false }, () => {
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

// True when a URL gives us nothing solid to compare: empty (tab still loading),
// unparseable, or an opaque origin. WHATWG URL serializes opaque origins (about:blank,
// data:, chrome://) as the STRING "null", not the value null, so both must be checked.
function isOpaque(url) {
  const o = originOf(url);
  return !url || o === null || o === "null";
}

// A pin row's identity, with the mode label canonicalized: "smart" resolves to the
// concrete profile keyFor will actually use, so {match:"smart"} and {match:"path"}
// rows for the same non-app URL count as ONE pin instead of two. Rows with the same
// identity would create and claim the same tabs, so everywhere we reason about "which
// pins exist" must see them as one — otherwise the extra row both creates a duplicate
// and shields it from cleanup.
function pinIdentity(pin) {
  const mode = pin.match || "smart";
  let resolved = mode;
  if (mode === "smart") {
    try {
      resolved = detectApp(new URL(pin.url).host);
    } catch {
      resolved = "path";
    }
  }
  return resolved + "::" + keyFor(pin.url, mode);
}

export function dedupePins(pins) {
  const seen = new Set();
  const out = [];
  for (const pin of pins) {
    const id = pinIdentity(pin);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(pin);
  }
  return out;
}

// Which existing pin (if any) already covers this URL, judged by each pin's OWN
// match rule — the same test creation uses, so the popup's "Already a pin" state
// can never disagree with what reconcile would do.
export function findPinForUrl(pins, url) {
  if (isOpaque(url)) return null;
  for (const pin of pins) {
    const mode = pin.match || "smart";
    if (keyFor(url, mode) === keyFor(pin.url, mode)) return pin;
  }
  return null;
}

// Decide whether a tab can become a new pin. Pure; id assignment stays with the caller.
export function preparePinForTab(pins, url, title) {
  if (!/^https?:\/\//i.test(url || "")) return { ok: false, reason: "not-http" };
  const existing = findPinForUrl(pins, url);
  if (existing) return { ok: false, reason: "already-pin", existing };
  return { ok: true, pin: { url, match: "smart", label: (title || "").slice(0, 40) } };
}

export function removePinByIdentity(pins, url, match) {
  const m = match || "smart";
  return pins.filter((p) => !(p.url === url && (p.match || "smart") === m));
}

// Row matcher for popup-initiated edits: prefer the stable id when both sides have
// one, else fall back to url + normalized match.
function sameRow(pin, ref) {
  if (ref.id && pin.id) return pin.id === ref.id;
  return pin.url === ref.url && (pin.match || "smart") === (ref.match || "smart");
}

// Set (or clear, with an empty string) a pin's display label. Labels are cosmetic:
// matching keys on the URL alone, so a rename can never change what a pin claims.
export function renamePinByIdentity(pins, ref, label) {
  const next = pins.map((p) => ({ ...p }));
  const target = next.find((p) => sameRow(p, ref));
  if (target) target.label = (label || "").trim();
  return next;
}

// Rearrange pins to match `order` (an array of {id?, url, match} refs). Rows the
// order doesn't mention — a sync race adding a pin mid-drag — keep their relative
// order and go to the end, so nothing is ever silently dropped.
export function reorderPinsByIdentity(pins, order) {
  const remaining = pins.slice();
  const out = [];
  for (const ref of order || []) {
    const i = remaining.findIndex((p) => sameRow(p, ref));
    if (i >= 0) out.push(remaining.splice(i, 1)[0]);
  }
  return out.concat(remaining);
}

// Display name for a pin: label, else last path segment, else host. Mirrors the
// options page's deriveName so the popup and the options page agree on names.
export function pinDisplayName(pin) {
  if (pin.label) return pin.label;
  try {
    const u = new URL(pin.url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.host;
  } catch {
    return pin.url;
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
    if (isOpaque(pin.url)) continue; // opaque origins all serialize to "null"; never drift-match
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

// Decide which tabs are duplicates of the configured pins. Built on the same assignment
// as creation, with two deliberate differences:
//   - duplicate pin rows collapse to one identity first (dedupePins), so a repeated or
//     equivalently-moded row can't shield a second tab
//   - claiming runs over PINNED tabs only. An unpinned tab may satisfy a pin for
//     creation purposes, but it must never out-claim the pinned tab that cleanup is
//     about to judge — otherwise the user's real pinned tab gets closed in favor of a
//     regular tab they happen to have open at the pin's URL.
// Pinned tabs are decided first, in index order:
//   - blank/still-loading/opaque-URL tabs (about:blank included) are never touched
//   - a pinned tab is removed if it shares an exact URL with a pinned tab already kept
//     (true identical copies, any origin, claimed or not — same rule the old cleanup
//     had), or, when unclaimed, if it matches a pin by the pin's own match rule or
//     matches the pin's claimed tab by that rule (a twin of a drifted pin). Merely
//     sharing an ORIGIN with a pin is NOT enough: a second Slack channel, another
//     Gmail account, or another page someone pinned on the same site is a deliberate
//     pin the matcher itself treats as distinct.
// Then UNPINNED tabs are compared against the KEPT pinned tabs only, and removed only
// as an exact-URL copy of one (Chrome's restore-twin bug). Comparing against kept tabs
// — not all pinned tabs — means removing a pinned duplicate can never drag an unpinned
// twin down with it and leave the URL open nowhere; and an unpinned tab you're merely
// browsing in never matches anything but its exact twin.
export function findDuplicateTabIds(pins, tabs) {
  const uniquePins = dedupePins(pins);

  const ordered = tabs.slice().sort((a, b) => a.index - b.index);
  const pinnedTabs = ordered.filter((t) => t.pinned);
  const byPin = assignPinsToTabs(uniquePins, pinnedTabs);
  const claimed = new Set();
  for (const t of byPin.values()) claimed.add(t.id);

  const remove = [];
  const keptExact = new Set(); // exact keys of pinned tabs we are keeping
  for (const t of pinnedTabs) {
    const url = tabUrl(t);
    if (isOpaque(url)) continue; // nothing solid to compare: leave alone
    const exactKey = keyFor(url, "exact");
    if (keptExact.has(exactKey)) {
      remove.push(t.id); // identical copy of a pinned tab we already kept
      continue;
    }
    if (claimed.has(t.id)) {
      keptExact.add(exactKey);
      continue;
    }
    const isDupe = uniquePins.some((pin) => {
      if (exactKey === keyFor(pin.url, "exact")) return true;
      const mode = pin.match || "smart";
      if (keyFor(url, mode) === keyFor(pin.url, mode)) return true;
      const c = byPin.get(pin);
      return !!c && keyFor(url, mode) === keyFor(tabUrl(c), mode);
    });
    if (isDupe) {
      remove.push(t.id);
      continue;
    }
    keptExact.add(exactKey);
  }

  for (const t of ordered) {
    if (t.pinned) continue;
    const url = tabUrl(t);
    if (isOpaque(url)) continue;
    if (keptExact.has(keyFor(url, "exact"))) remove.push(t.id);
  }
  return remove;
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
    const [rawPins, settings] = await Promise.all([getPins(), getSettings()]);
    // Collapse duplicate/equivalent pin rows ONCE, so creation, cleanup, and reorder
    // all agree on which pins exist. A leftover duplicate row here would create a
    // second tab, shield it from cleanup, and let its drift pass hijack the reorder.
    const pins = dedupePins(rawPins);
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
      // Exact URLs already open in this window. Two rows can legitimately share one
      // URL under different modes (an Exact row and a Path row); the first row claims
      // or creates the tab, and the second must not add a byte-identical copy.
      const urlTaken = new Set();
      for (const t of tabsAtStart) {
        const u = tabUrl(t);
        if (!isOpaque(u)) urlTaken.add(keyFor(u, "exact"));
      }
      const createdThisPass = new Set(); // canonical identities created this pass
      let index = 0;
      for (const pin of pins) {
        const composite = pinIdentity(pin);
        const urlKey = keyFor(pin.url, "exact");
        if (byPin.has(pin) || createdThisPass.has(composite) || urlTaken.has(urlKey)) {
          index++; // already here (restored, drifted, or duplicate row): hold its slot
          continue;
        }
        await createPinned(windowId, pin.url, index);
        createdThisPass.add(composite);
        urlTaken.add(urlKey);
        index++;
      }
    }

    // 2) Re-query so we see the restored tabs plus anything we just created. Then clean
    // up duplicates and, finally, put every pinned tab back into the order defined by
    // the pin list. Cleanup is claim-based — see findDuplicateTabIds for exactly what
    // may be removed. If the window disappeared mid-pass there is nothing to clean or
    // reorder; never fall back to the stale pre-create snapshot, whose tab ids may by
    // now live in a different window (tab ids are global, so removing by a stale id
    // could close a tab the user dragged elsewhere).
    let after;
    try {
      after = await chrome.windows.get(windowId, { populate: true });
    } catch {
      return; // window closed mid-reconcile
    }
    const tabs2 = after.tabs || [];
    const removed = new Set();

    if (settings.cleanupTwins && (arrivedWithPinned || opts.skipCreate)) {
      for (const id of findDuplicateTabIds(pins, tabs2)) {
        await removeTab(id);
        removed.add(id);
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