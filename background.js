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

function dedupePins(pins) {
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
function findPinForUrl(pins, url) {
  if (isOpaque(url)) return null;
  for (const pin of pins) {
    const mode = pin.match || "smart";
    if (keyFor(url, mode) === keyFor(pin.url, mode)) return pin;
  }
  return null;
}

// Decide whether a tab can become a new pin. Pure; id assignment stays with the caller.
function preparePinForTab(pins, url, title) {
  if (!/^https?:\/\//i.test(url || "")) return { ok: false, reason: "not-http" };
  const existing = findPinForUrl(pins, url);
  if (existing) return { ok: false, reason: "already-pin", existing };
  return { ok: true, pin: { url, match: "smart", label: (title || "").slice(0, 40) } };
}

function removePinByIdentity(pins, url, match) {
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
function renamePinByIdentity(pins, ref, label) {
  const next = pins.map((p) => ({ ...p }));
  const target = next.find((p) => sameRow(p, ref));
  if (target) target.label = (label || "").trim();
  return next;
}

// Rearrange pins to match `order` (an array of {id?, url, match} refs). Rows the
// order doesn't mention — a sync race adding a pin mid-drag — keep their relative
// order and go to the end, so nothing is ever silently dropped.
function reorderPinsByIdentity(pins, order) {
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
function pinDisplayName(pin) {
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
function findDuplicateTabIds(pins, tabs) {
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
      .then((w) => reconcileWindow(w.id))
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

