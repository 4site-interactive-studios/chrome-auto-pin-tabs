// background.js
// Auto Pin Tabs - single-file MV3 service worker (matcher + storage + reconcile + listeners).
// Generated from the tested source modules; matcher logic is identical to the unit-tested matcher.js.

// ===== from src/matcher.js =====
// matcher.js
// Pure URL-matching logic. Deliberately free of any chrome.* calls so it can be
// unit-tested in plain Node. Everything here answers one question: given a URL and
// a match mode, produce a comparison KEY. Two URLs with the same key are treated as
// "the same pin", which is what drives both duplicate avoidance and restore cleanup.

// Hosts we ship bespoke matching rules for. Smart mode maps these to a profile and
// falls back to plain "path" matching for everything else.
const APP_HOSTS = {
  "mail.google.com": "gmail",
  "calendar.google.com": "gcal",
  "drive.google.com": "gdrive",
  "app.productive.io": "productive",
  "app.slack.com": "slack",
};

function detectApp(host) {
  return APP_HOSTS[(host || "").toLowerCase()] || "path";
}

// Pull the Google multi-account index N out of /<segment>/u/N/...  Defaults to "0".
// segment is the first path segment: "mail", "calendar", or "drive".
function googleUser(pathname, segment) {
  const re = new RegExp(`^/${segment}/u/(\\d+)(?:/|$)`);
  const m = (pathname || "").match(re);
  return m ? m[1] : "0";
}

// Gmail's top-level views. For these the format is "#view" or "#view/<threadid>",
// so the view name alone is the identity and any trailing id is dropped.
const GMAIL_SYSTEM_VIEWS = new Set([
  "inbox", "starred", "snoozed", "sent", "drafts", "imp", "important",
  "scheduled", "all", "spam", "trash", "chats",
]);

// Heuristic: does this hash segment look like a Gmail thread/message id rather than a
// human-readable name? Gmail thread ids are long hex; newer message ids are long
// opaque tokens. Only applied to the THIRD+ segment of compound views (label/search/
// category), never to a label/query name, so long label names are safe.
function looksLikeMailId(seg) {
  return /^[0-9a-f]{12,}$/i.test(seg) || /^[A-Za-z0-9_-]{16,}$/.test(seg);
}

// Normalize a Gmail hash to its stable view identity.
//   "#inbox"                      -> "inbox"
//   "#inbox/13216515baefe747"     -> "inbox"          (thread opened)
//   ""                            -> "inbox"          (Gmail default)
//   "#label/Work"                 -> "label/Work"
//   "#label/Work/FMfcgz...id"     -> "label/Work"     (message opened inside label)
//   "#label/ProjectPhoenixRollout"-> "label/ProjectPhoenixRollout" (long label kept)
//   "#search/from:me"             -> "search/from:me"
function gmailView(hash) {
  const h = (hash || "").replace(/^#/, "");
  if (!h) return "inbox";
  const segs = h.split("/").filter(Boolean);
  const view = (segs[0] || "").toLowerCase();
  if (GMAIL_SYSTEM_VIEWS.has(view)) return view;
  // Compound view (label/search/category/settings/...). Keep view + name (first two
  // segments); drop a trailing id-looking third segment if present.
  if (segs.length >= 3 && looksLikeMailId(segs[segs.length - 1])) {
    return segs.slice(0, 2).join("/");
  }
  return segs.join("/");
}

// Slack web client target: workspace + channel from /client/<TEAM>/<CHANNEL>/...
// Trailing thread/message segments (e.g. /thread/<ts>) are dropped so an open thread
// matches its channel pin. Falls back to the raw pathname for unexpected shapes.
function slackTarget(pathname) {
  const segs = (pathname || "").split("/").filter(Boolean); // ["client","T..","C..",...]
  if (segs[0] !== "client") return pathname || "";
  const team = segs[1] || "";
  const channel = segs[2] || "";
  return channel ? `${team}/${channel}` : team;
}

// The comparison key. match is one of:
//   "smart"    -> auto-detect app by host, else behaves like "path"
//   "exact"    -> scheme + host + path + query + hash
//   "path"     -> scheme + host + path (ignore query + hash)
//   "hashview" -> scheme + host + path + hash (ignore query)
//   "domain"   -> scheme + host only
function keyFor(rawUrl, match) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl || ""; // not a parseable URL (e.g. "" while a tab is still loading)
  }

  const host = u.host.toLowerCase();
  const path = (u.pathname || "/").replace(/\/+$/, "") || "/"; // /tasks and /tasks/ are equal

  let m = match || "smart";
  if (m === "smart") m = detectApp(host);

  switch (m) {
    case "gmail":
      return `${host}|gmail|${googleUser(u.pathname, "mail")}|${gmailView(u.hash)}`;
    case "gcal":
      return `${host}|gcal|${googleUser(u.pathname, "calendar")}`;
    case "gdrive":
      return `${host}|gdrive|${googleUser(u.pathname, "drive")}`;
    case "productive":
      return `${host}|productive|${path}`;
    case "slack":
      return `${host}|slack|${slackTarget(u.pathname)}`;
    case "exact":
      return `${u.protocol}//${host}${path}${u.search}${u.hash}`;
    case "domain":
      return `${u.protocol}//${host}`;
    case "hashview":
      return `${u.protocol}//${host}${path}${u.hash}`;
    case "path":
    default:
      return `${u.protocol}//${host}${path}`;
  }
}



// ===== from src/storage.js =====
// storage.js
// Thin wrapper over chrome.storage.sync for the pin list and settings. Using sync so
// the config follows the user across machines; the data is tiny and well under quota.
//
// Note: getPins never writes. Earlier versions seeded a hardcoded pin list into empty
// storage, but on a machine where Chrome Sync hasn't delivered the real list yet that
// write races the sync and can clobber it. An empty list simply means "nothing to pin
// yet": reconcile no-ops, and the list arrives via sync or gets built in the options
// page ("Import open pinned tabs" recreates a setup in one click).

const DEFAULTS = {
  // "startup_and_new" -> pin at cold start AND on every new normal window (default)
  // "startup_only"    -> only run the cold-start sweep; leave session-opened windows alone
  applyMode: "startup_and_new",
  // Close Chrome's own restore duplicates: an unpinned tab that matches a pinned tab
  // in the same restored window. Scoped to restore-style windows (see reconcile.js).
  cleanupTwins: true,
};

async function getPins() {
  const { pins } = await chrome.storage.sync.get("pins");
  return Array.isArray(pins) ? pins : [];
}

async function setPins(pins) {
  await chrome.storage.sync.set({ pins });
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

async function setSettings(patch) {
  const current = await getSettings();
  await chrome.storage.sync.set({ settings: { ...current, ...patch } });
}


// ===== from src/reconcile.js =====

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
function assignPinsToTabs(pins, tabs) {
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
function desiredPinnedOrder(pins, pinnedTabs) {
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

async function reconcileWindow(windowId, opts = {}) {
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

async function reconcileAllWindows() {
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

// ===== from src/service-worker.js =====
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

