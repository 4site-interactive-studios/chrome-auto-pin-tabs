// matcher.js
// Pure URL-matching logic. Deliberately free of any chrome.* calls so it can be
// unit-tested in plain Node. Everything here answers one question: given a URL and
// a match mode, produce a comparison KEY. Two URLs with the same key are treated as
// "the same pin", which is what drives both duplicate avoidance and restore cleanup.

// Hosts we ship bespoke matching rules for. Smart mode maps these to a profile and
// falls back to plain "path" matching for everything else.
export const APP_HOSTS = {
  "mail.google.com": "gmail",
  "calendar.google.com": "gcal",
  "drive.google.com": "gdrive",
  "app.productive.io": "productive",
  "app.slack.com": "slack",
};

export function detectApp(host) {
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
export function gmailView(hash) {
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
export function slackTarget(pathname) {
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
export function keyFor(rawUrl, match) {
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

