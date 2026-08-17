import { findPinForUrl, preparePinForTab, removePinByIdentity, renamePinByIdentity, reorderPinsByIdentity } from "../src/reconcile.js";
let pass = 0, fail = 0; const fails = [];
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

const X = "https://mail.google.com/mail/u/0/#inbox";
const T = "https://app.productive.io/2650-4site-interactive-studios-inc/tasks";
const pGmail = { url: X, match: "smart", label: "Mail" };
const pExact = { url: T + "?filter=ABC", match: "exact" };
const pPath = { url: T, match: "path" };
const pDomain = { url: "https://news.ycombinator.com/", match: "domain" };

// findPinForUrl judges by each pin's own mode — same test creation uses.
eq("smart pin covers thread url", findPinForUrl([pGmail], X + "/18f2a3b4c5d6e7f8")?.label, "Mail");
eq("exact pin ignores query variant", findPinForUrl([pExact], T + "?filter=OTHER"), null);
eq("path pin ignores query and hash", findPinForUrl([pPath], T + "?x=1#frag")?.match, "path");
eq("domain pin covers any path", findPinForUrl([pDomain], "https://news.ycombinator.com/item?id=1")?.match, "domain");
eq("no match returns null", findPinForUrl([pGmail], "https://example.com/"), null);
eq("blank url returns null", findPinForUrl([pGmail], ""), null);
eq("opaque url returns null", findPinForUrl([pGmail], "chrome://newtab/"), null);

// preparePinForTab: the popup's add decision.
eq("rejects chrome page", preparePinForTab([], "chrome://extensions/", "t").reason, "not-http");
eq("rejects about:blank", preparePinForTab([], "about:blank", "t").reason, "not-http");
eq("rejects ftp", preparePinForTab([], "ftp://host/file", "t").reason, "not-http");
eq("rejects empty url", preparePinForTab([], "", "t").reason, "not-http");
eq("rejects covered url", preparePinForTab([pGmail], X + "/18f2a3b4c5d6e7f8", "t").reason, "already-pin");
{
  const r = preparePinForTab([pGmail], "https://example.com/dash", "A".repeat(60));
  eq("accepts new url as smart pin", [r.ok, r.pin.match, r.pin.url], [true, "smart", "https://example.com/dash"]);
  eq("truncates label to 40", r.pin.label.length, 40);
}
eq("missing title becomes empty label", preparePinForTab([], "https://example.com/", undefined).pin.label, "");

// removePinByIdentity: url + normalized match, never index.
const rows = [
  { url: T, match: "smart", label: "a" },
  { url: T, match: "exact", label: "b" },
  { url: X, label: "c" }, // missing match = smart
];
eq("removes only the url+match row", removePinByIdentity(rows, T, "smart").map((p) => p.label), ["b", "c"]);
eq("leaves same-url different-match row", removePinByIdentity(rows, T, "exact").map((p) => p.label), ["a", "c"]);
eq("missing match normalizes to smart", removePinByIdentity(rows, X, undefined).map((p) => p.label), ["a", "b"]);
eq("removes duplicate identical rows together", removePinByIdentity(
  [{ url: X, match: "smart", label: "a" }, { url: X, match: "smart", label: "b" }], X, "smart"
).length, 0);

// renamePinByIdentity: display-only label edits.
const named = [
  { id: "p1", url: X, match: "smart", label: "Old" },
  { id: "p2", url: T, match: "smart", label: "" },
];
eq("rename sets trimmed label", renamePinByIdentity(named, { id: "p1" }, "  New Name  ")[0].label, "New Name");
eq("rename with empty clears label", renamePinByIdentity(named, { id: "p1" }, "")[0].label, "");
eq("rename matches by identity when no id", renamePinByIdentity(named, { url: T, match: "smart" }, "Tasks")[1].label, "Tasks");
eq("rename of unknown row changes nothing", renamePinByIdentity(named, { id: "nope" }, "x").map((p) => p.label), ["Old", ""]);
eq("rename does not mutate the input", (renamePinByIdentity(named, { id: "p1" }, "x"), named[0].label), "Old");
eq("rename prefers id over identity", renamePinByIdentity(
  [{ id: "a", url: X, match: "smart", label: "" }, { id: "b", url: X, match: "smart", label: "" }],
  { id: "b", url: X, match: "smart" }, "second"
).map((p) => p.label), ["", "second"]);

// reorderPinsByIdentity: full and partial orders.
const abc = [
  { id: "a", url: "https://a.com/", match: "smart" },
  { id: "b", url: "https://b.com/", match: "smart" },
  { id: "c", url: "https://c.com/", match: "smart" },
];
eq("reorder applies a full permutation", reorderPinsByIdentity(abc, [
  { id: "c" }, { id: "a" }, { id: "b" },
]).map((p) => p.id), ["c", "a", "b"]);
eq("unmentioned rows keep order at the end", reorderPinsByIdentity(abc, [
  { id: "c" },
]).map((p) => p.id), ["c", "a", "b"]);
eq("unknown refs are ignored", reorderPinsByIdentity(abc, [
  { id: "zzz" }, { id: "b" },
]).map((p) => p.id), ["b", "a", "c"]);
eq("reorder falls back to url+match identity", reorderPinsByIdentity(abc, [
  { url: "https://b.com/", match: "smart" }, { url: "https://a.com/" },
]).map((p) => p.id), ["b", "a", "c"]);
eq("duplicate identity rows claimed greedily once each", reorderPinsByIdentity(
  [{ url: X, match: "smart", label: "1" }, { url: X, match: "smart", label: "2" }],
  [{ url: X, match: "smart" }, { url: X, match: "smart" }]
).map((p) => p.label), ["1", "2"]);

console.log(`Popup-logic tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
