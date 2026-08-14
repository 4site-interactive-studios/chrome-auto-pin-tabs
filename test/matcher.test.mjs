// matcher.test.mjs — core URL-key regressions across the five profiles and match modes.
import { keyFor, detectApp, gmailView, slackTarget } from "../src/matcher.js";

let pass = 0, fail = 0; const fails = [];
const eq = (n, a, b) => { const ok = a === b; ok ? pass++ : (fail++, fails.push(`${n}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)); };
const same = (n, a, b) => eq(n, a === b, true);
const diff = (n, a, b) => eq(n, a !== b, true);

// Google Calendar: account-level; view, date, and query all collapse.
const cal = "https://calendar.google.com/calendar/u/0/r/week/2026/6/29?pli=1";
eq("gcal key", keyFor(cal, "smart"), "calendar.google.com|gcal|0");
same("gcal date collapses", keyFor(cal, "smart"), keyFor("https://calendar.google.com/calendar/u/0/r/day/2025/1/2", "smart"));
diff("gcal account distinct", keyFor(cal, "smart"), keyFor("https://calendar.google.com/calendar/u/1/r", "smart"));

// Gmail: account + view; thread/message ids stripped; long labels kept.
const inbox = keyFor("https://mail.google.com/mail/u/0/#inbox", "smart");
eq("gmail inbox key", inbox, "mail.google.com|gmail|0|inbox");
same("gmail thread collapses", inbox, keyFor("https://mail.google.com/mail/u/0/#inbox/13216515baefe747", "smart"));
same("gmail bare url is inbox", inbox, keyFor("https://mail.google.com/mail/u/0/", "smart"));
diff("gmail sent != inbox", inbox, keyFor("https://mail.google.com/mail/u/0/#sent", "smart"));
same("gmail label msg collapses", keyFor("https://mail.google.com/mail/u/0/#label/Work", "smart"),
  keyFor("https://mail.google.com/mail/u/0/#label/Work/FMfcgzQbVprMpRWFlxphgKQcVXNScpqf", "smart"));
eq("gmail long label kept", keyFor("https://mail.google.com/mail/u/0/#label/ProjectPhoenixRolloutPlanning", "smart"),
  "mail.google.com|gmail|0|label/ProjectPhoenixRolloutPlanning");
diff("gmail account distinct", inbox, keyFor("https://mail.google.com/mail/u/1/#inbox", "smart"));

// Slack: workspace + channel; thread suffix stripped.
const chan = keyFor("https://app.slack.com/client/T024BE7LD/C024BE7LV", "smart");
eq("slack key", chan, "app.slack.com|slack|T024BE7LD/C024BE7LV");
same("slack thread collapses", chan, keyFor("https://app.slack.com/client/T024BE7LD/C024BE7LV/thread/C024BE7LV-1718900000.000200", "smart"));
diff("slack channel distinct", chan, keyFor("https://app.slack.com/client/T024BE7LD/C999XYZ000", "smart"));

// Productive: full path; query + trailing slash ignored under smart.
const T = "https://app.productive.io/2650-4site-interactive-studios-inc/tasks";
diff("productive paths distinct", keyFor(T, "smart"), keyFor("https://app.productive.io/2650-4site-interactive-studios-inc/time/me", "smart"));
same("productive query ignored (smart)", keyFor(T, "smart"), keyFor(T + "?foo=bar", "smart"));
same("productive trailing slash", keyFor(T, "smart"), keyFor(T + "/", "smart"));

// Explicit modes.
diff("exact query distinguishes", keyFor(T + "?filter=A", "exact"), keyFor(T + "?filter=B", "exact"));
diff("exact filtered vs plain", keyFor(T + "?filter=A", "exact"), keyFor(T, "exact"));
same("path ignores hash+query", keyFor("https://x.com/a?q=1#h", "path"), keyFor("https://x.com/a", "path"));
diff("hashview hash distinguishes", keyFor("https://x.com/a#1", "hashview"), keyFor("https://x.com/a#2", "hashview"));
same("domain collapses paths", keyFor("https://x.com/a/b", "domain"), keyFor("https://x.com/c", "domain"));
eq("unknown host -> path", detectApp("example.com"), "path");
same("smart unknown ignores hash", keyFor("https://x.com/a#one", "smart"), keyFor("https://x.com/a#two", "smart"));

// Defensive inputs.
eq("empty falls back", keyFor("", "smart"), "");
eq("garbage falls back", keyFor("not a url", "smart"), "not a url");
eq("gmailView default", gmailView(""), "inbox");
eq("slackTarget team only", slackTarget("/client/T024BE7LD"), "T024BE7LD");

console.log(`Matcher tests: ${pass} passed, ${fail} failed`);
if (fails.length) { fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
