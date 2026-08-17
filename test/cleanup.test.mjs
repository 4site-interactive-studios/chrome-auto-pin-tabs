import { findDuplicateTabIds, dedupePins } from "../src/reconcile.js";
let pass = 0, fail = 0; const fails = [];
function eqArr(name, a, b) {
  const ok = JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
  ok ? pass++ : (fail++, fails.push(`${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`));
}

const ORG = "https://app.productive.io/2650-4site-interactive-studios-inc";
const X = "https://mail.google.com/mail/u/0/#inbox";
const XT = "https://mail.google.com/mail/u/0/#inbox/18f2a3b4c5d6e7f8";
const T = `${ORG}/tasks`;
const TF = T + "?filter=ABC";

const pGmail = { url: X, match: "smart" };
const pSlack = { url: "https://app.slack.com/client/T024/C555", match: "smart" };
const pCal = { url: "https://calendar.google.com/calendar/u/0/r", match: "smart" };
const pTasks = { url: T, match: "smart" };
const pTime = { url: `${ORG}/time/me`, match: "smart" };
const pFilter = { url: TF, match: "exact" };
const pHN = { url: "https://news.ycombinator.com/", match: "domain" };

function tab(id, index, url, pinned, extra = {}) {
  return { id, index, url, pinned, ...extra };
}

// Multi-copy collapse: identical pinned copies keep only the claimed (first) one.
eqArr("collapses duplicate pinned", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 1, X, true), tab("c", 2, X, true),
]), ["b", "c"]);

// The reported bug: a duplicate that navigated (thread open) is still collapsed.
eqArr("collapses smart-mode twin (gmail thread)", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 1, XT, true),
]), ["b"]);

// Slack channel pin vs an open thread in the duplicate.
eqArr("collapses slack thread twin", findDuplicateTabIds([pSlack], [
  tab("a", 0, "https://app.slack.com/client/T024/C555", true),
  tab("b", 1, "https://app.slack.com/client/T024/C555/thread/1699999999.123", true),
]), ["b"]);

// Calendar keys by account only, so two different views are one pin.
eqArr("collapses calendar view twin", findDuplicateTabIds([pCal], [
  tab("a", 0, "https://calendar.google.com/calendar/u/0/r/week", true),
  tab("b", 1, "https://calendar.google.com/calendar/u/0/r/month", true),
]), ["b"]);

// Blank/still-loading tabs share the "" key but must never be removed.
eqArr("blank tabs untouched", findDuplicateTabIds([pGmail], [
  tab("a", 0, "", true), tab("b", 1, "", true),
  tab("c", 2, X, true), tab("d", 3, X, true),
]), ["d"]);

// A manual pin on an origin no pin uses is not ours to manage...
eqArr("manual pin on other origin untouched", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 1, "https://github.com/foo", true),
]), []);

// ...but a truly identical pinned copy is collapsed on ANY origin (restore-twin bug).
eqArr("collapses identical manual-pin twins", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true),
  tab("b", 1, "https://github.com/foo", true), tab("c", 2, "https://github.com/foo", true),
]), ["c"]);

// Two pins on the same origin each claim their own tab.
eqArr("same-origin sibling pins both survive", findDuplicateTabIds([pTasks, pTime], [
  tab("a", 0, T, true), tab("b", 1, `${ORG}/time/me`, true),
]), []);

// Survivor is the CLAIMED tab (exact match wins), not blindly the leftmost.
eqArr("keeps claimed tab over leftmost", findDuplicateTabIds([pGmail], [
  tab("a", 0, XT, true), tab("b", 1, X, true),
]), ["a"]);

// A pinned same-origin tab at a DIFFERENT identity is a deliberate pin, not a dupe:
// the matcher itself says a second channel/account/path is distinct.
eqArr("same-origin manual pin survives (productive)", findDuplicateTabIds([pTasks], [
  tab("a", 0, T, true), tab("b", 1, `${ORG}/projects/9`, true),
]), []);
eqArr("second slack channel survives", findDuplicateTabIds([pSlack], [
  tab("a", 0, "https://app.slack.com/client/T024/C555", true),
  tab("b", 1, "https://app.slack.com/client/T024/C777", true),
]), []);
eqArr("second gmail account survives", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 1, "https://mail.google.com/mail/u/1/#inbox", true),
]), []);

// But twins of a DRIFTED pin still collapse: same identity as the claimed tab.
eqArr("collapses identical twins of a drifted pin", findDuplicateTabIds([pTasks], [
  tab("a", 0, `${ORG}/projects/9`, true), tab("b", 1, `${ORG}/projects/9`, true),
]), ["b"]);
eqArr("collapses mode-key twin of a drifted pin", findDuplicateTabIds([pTasks], [
  tab("a", 0, `${ORG}/projects/9?tab=a`, true), tab("b", 1, `${ORG}/projects/9?tab=b`, true),
]), ["b"]);

// An unpinned tab must never out-claim the real pinned tab: the drifted pinned Gmail
// survives even when a regular unpinned tab sits at the pin's exact URL.
eqArr("pinned drifted tab beats unpinned claimant", findDuplicateTabIds([pGmail], [
  tab("a", 0, XT, true), tab("b", 5, X, false),
]), []);

// Duplicate rows in the pin list still collapse to one tab.
eqArr("duplicate pin rows still collapse twins", findDuplicateTabIds([pGmail, pGmail], [
  tab("a", 0, X, true), tab("b", 1, X, true),
]), ["b"]);

// Equivalent rows under different mode LABELS are one pin: smart resolves to path on
// a non-app host, so a smart row and a path row for the same URL can't shield a twin.
const GH = "https://github.com/anthropics/claude-code";
eqArr("mode-alias pin rows dedupe to one", dedupePins([
  { url: GH, match: "smart" }, { url: GH, match: "path" },
]).map((p) => p.match), ["smart"]);
eqArr("mode-alias pin rows still collapse twins", findDuplicateTabIds([
  { url: GH, match: "smart" }, { url: GH, match: "path" },
], [tab("a", 0, GH, true), tab("b", 1, GH, true)]), ["b"]);

// Even two genuinely different rows (exact vs path) collapse identical claimed tabs.
eqArr("identical claimed twins collapse across rows", findDuplicateTabIds([
  { url: GH, match: "exact" }, { url: GH, match: "path" },
], [tab("a", 0, GH, true), tab("b", 1, GH, true)]), ["b"]);

// Unpinned handling: exact restore-twin goes, casual browsing stays.
eqArr("removes unpinned twin", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 5, X, false),
]), ["b"]);
eqArr("unpinned smart-only twin survives", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 5, XT, false),
]), []);

// An unpinned twin is judged against KEPT pinned tabs only: when its pinned twin is
// itself removed as a duplicate, the unpinned tab survives so the URL stays open.
eqArr("unpinned twin of a removed duplicate survives", findDuplicateTabIds(
  [{ url: "https://site.com/a", match: "path" }], [
  tab("a", 0, "https://site.com/a", true),
  tab("b", 1, "https://site.com/a?x=1", true),
  tab("c", 2, "https://site.com/a?x=1", false),
]), ["b"]);

// about:blank has an opaque origin; spacer pins and blank unpinned tabs are never ours.
eqArr("about:blank pinned spacers survive", findDuplicateTabIds([pGmail], [
  tab("a", 0, "about:blank", true), tab("b", 1, "about:blank", true),
]), []);
eqArr("unpinned about:blank survives", findDuplicateTabIds([pGmail], [
  tab("a", 0, "about:blank", true), tab("b", 5, "about:blank", false),
]), []);

// Restore-time tabs often carry only pendingUrl; they must count as their URL.
eqArr("pendingUrl-only pinned twin collapses", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 1, "", true, { pendingUrl: X }),
]), ["b"]);
eqArr("pendingUrl-only tab claims its pin", findDuplicateTabIds([pGmail], [
  tab("a", 0, "", true, { pendingUrl: X }),
]), []);
eqArr("unpinned pendingUrl twin removed", findDuplicateTabIds([pGmail], [
  tab("a", 0, X, true), tab("b", 5, "", false, { pendingUrl: X }),
]), ["b"]);

// Non-smart match modes flow through cleanup too: a Whole-site pin owns the host,
// while an unpinned tab on that host is still just browsing.
eqArr("domain pin collapses same-host pinned extra", findDuplicateTabIds([pHN], [
  tab("a", 0, "https://news.ycombinator.com/item?id=1", true),
  tab("b", 1, "https://news.ycombinator.com/item?id=2", true),
  tab("c", 2, "https://news.ycombinator.com/newest", false),
]), ["b"]);

// An Exact pin keeps its filtered view distinct from the plain pin.
eqArr("keeps distinct views", findDuplicateTabIds([pTasks, pFilter], [
  tab("a", 0, T, true), tab("b", 1, TF, true),
]), []);

// Combined restore mess: extra pinned copy and unpinned twin go, claimed tabs stay.
eqArr("combined", findDuplicateTabIds([pGmail, pFilter], [
  tab("a", 0, X, true), tab("b", 1, TF, true),
  tab("c", 2, X, true), tab("d", 3, X, false),
]), ["c", "d"]);

console.log(`Cleanup tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
