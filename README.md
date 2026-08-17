# Auto Pin Tabs

A Chrome extension (Manifest V3) that pins a chosen set of tabs automatically in every new window, with per-pin duplicate matching tuned for single-page apps, so session restore and same-site-different-path tabs behave the way you'd expect.

## What it does

- Pins your configured tabs at browser startup and on every new window.
- Never leaves you with two pinned tabs for the same thing. Matching is per pin and idempotent, so a restore that already brought your pinned tabs back won't get a second copy.
- Understands five apps out of the box (Gmail, Google Calendar, Google Drive, Productive, Slack), so an open email thread, a changing calendar date, or a deep-linked Slack message doesn't read as a different tab.
- Lets you pin the same site at different paths as separate tabs, and the same path with different query arguments (for example two Productive task views with different saved filters) when you choose exact matching.
- Cleans up Chrome's own restore duplicates and puts every pinned tab back into the order you set.
- Ships a management page for adding, removing, reordering, and tuning pins.
- Keeps its configuration in `chrome.storage.sync`, so with a stable extension ID it follows you across machines.

## Installing it

This is loaded as an unpacked extension.

1. Put the extension files in a folder. The folder needs `manifest.json`, `background.js`, `options.html`, and `options.js` at its top level.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder. The card should show the name "Auto Pin Tabs" and the current version.

The extension reconciles your open windows when it loads, so you can test right away by opening a new window.

The `manifest.json` includes a `key` field. That fixes the extension ID (`cdplkgcjpmplghpflbgolpgafngfjlfo`) regardless of where the folder lives, which is what lets settings sync across machines. See "Syncing across machines" below.

## The interface

Open it by clicking the toolbar button (find Auto Pin Tabs under the Extensions puzzle-piece icon, and pin it for one click), or from `chrome://extensions` under **Details, Extension options**.

The page has three parts.

**Pinned tabs.** Your pins as a list. Each row shows the label and URL, a match-type dropdown with a plain-language note that updates as you change it, up and down arrows to reorder, and a remove button. Order here is the order pins appear in new windows.

**Add a pin.** Paste a URL, pick a match type, and optionally give it a label. A live note tells you how it will match before you save. "Import open pinned tabs" seeds the list from whatever you already have pinned. "Apply to this window" pushes your current pins into the window you're in, so you can see changes without opening a new one.

**Settings.** When to pin, and whether to clean up Chrome's restore duplicates.

## How matching works

Every pin has a match type that decides when an open tab counts as "the same pin." That single decision drives duplicate avoidance, restore cleanup, and ordering.

| Match type | What counts as the same |
| --- | --- |
| Smart (auto-detect) | Recognizes the five apps below and applies their rule. Falls back to Path for anything else. This is the default. |
| Exact URL | The full URL, including query string and `#fragment`. |
| Path | Scheme, host, and path. Query string and `#fragment` ignored. |
| Path + `#hash` | Path and `#fragment`. Query string ignored. |
| Whole site | The site only. Any page on it counts. |

The five built-in app profiles (used by Smart) each ignore the volatile part of that app's URL:

| App | Host | What counts as the same pin |
| --- | --- | --- |
| Gmail | `mail.google.com` | Account index plus view (Inbox, Sent, a label). An open thread's message ID is ignored. |
| Google Calendar | `calendar.google.com` | Account index. Any view or date is one pin. |
| Google Drive | `drive.google.com` | Account index. Any folder or view is one pin. |
| Productive | `app.productive.io` | The full path, so `/tasks` and `/time/me` stay separate. Query string ignored. |
| Slack | `app.slack.com` | Workspace and channel. An open thread or message timestamp is ignored. |

Two notes. Different Google accounts (`/u/0` versus `/u/1`) are separate pins on purpose. And Drive and Calendar match at the account level, meaning one pinned Drive tab and one pinned Calendar tab. If you want a specific Drive folder as its own pin alongside My Drive, set that pin to Path or Exact.

**Pinning a view with a filter or query argument.** Smart matching for Productive (and the plain Path type) ignores the query string, so a filtered tasks URL like `/tasks?filter=...` would collapse onto the plain `/tasks` board. To keep a filtered view as its own pin, set it to **Exact URL**. Exact keys on the whole URL, so the filter is part of the pin's identity: it opens with the filter applied, dedupes against the identical restored tab, and stays distinct from the plain board and from any other filtered view.

## Duplicates and session restore

Three things keep the pinned set correct, in order.

**Settling before acting.** Chrome restores a window's tabs asynchronously, so reconciling the instant a window appears can run before the restored pinned tabs come back, which is what produces duplicates. Instead of a fixed delay, the extension waits until a window has gone quiet for about 0.8 seconds with no new tabs, then reconciles once. A restore keeps firing tab events, which keep pushing that wait out, so it only acts after the restore finishes. The visible cost is that pins appear about a second after a window opens rather than instantly.

**Cleanup.** On a restored window it removes any unpinned tab that is an identical copy of a pinned tab (Chrome's own restore-twin bug), then collapses duplicate pinned tabs. Duplicate detection uses the same claim logic as creation: each configured pin keeps exactly one pinned tab (exact URL first, then the pin's match rule, then a same-origin drifted tab), and a second pinned tab is removed only when it is an identical copy of a kept pinned tab, or matches a pin — or that pin's kept tab — under the pin's own match rule. So a duplicate that navigated (an open email thread, a Slack thread) still collapses, but merely sharing a site with a pin is never enough: a second pinned Slack channel, another Google account, or any other same-site page you pinned yourself stays. Unpinned tabs are only ever removed on an identical full URL, so a regular tab you're browsing in never matches, and blank still-loading tabs are always left alone.

**Reorder.** Finally it arranges the pinned tabs to match your list: configured pins first in list order, then any manually pinned tabs after, keeping their relative order. It's skipped when the order is already correct, so a window that's fine is never disturbed.

## Settings

**When to pin.** "On startup and every new window" (the default) pins at cold start and on each new normal window. "On startup only" pins at cold start and leaves windows you open later alone.

**Remove Chrome's duplicate copies after a restore.** On by default. Controls the cleanup step above. Leave it on unless you have a reason not to.

Settings and pins are stored under the `pins` and `settings` keys in `chrome.storage.sync`.

## Syncing across machines

Configuration lives in `chrome.storage.sync`, which Chrome syncs across devices where you're signed into the same Google account with sync on. The catch for an unpacked extension is identity: sync only works when the extension has the same ID on each machine, and without help an unpacked extension's ID is derived from its folder path. The `key` in `manifest.json` fixes the ID regardless of path, which is why it's there.

To use sync: load the extension on each machine, confirm the card shows ID `cdplkgcjpmplghpflbgolpgafngfjlfo`, and make sure you're signed into the same account with extension and settings sync enabled. Add or change a pin on one machine, wait a moment, and it should appear on the other.

Two caveats. A Google Workspace admin can disable extension or settings sync by policy, which overrides all of this. And if this is ever uploaded to the Chrome Web Store, the `key` field has to be removed, because the store assigns its own ID.

## Permissions

- `tabs`, to read tab URLs for matching. Without it, tab URLs come back empty.
- `storage`, to hold the configuration.

No host permissions are needed, since creating a tab at a URL doesn't require them.

## Project layout and development

The loadable extension is four files:

```
manifest.json     MV3 manifest, the stable-ID key, the toolbar action, and the options page
background.js      the service worker: matcher, storage, reconcile, and event wiring
options.html       the management page markup and styles
options.js         the management page logic
```

`background.js` is generated from a set of small source modules so the logic can be unit-tested in plain Node without Chrome:

```
src/matcher.js          URL comparison keys and the five app profiles (pure, no chrome.*)
src/storage.js          pins and settings, with defaults and seed pins
src/reconcile.js        add missing pins, clean duplicates, reorder
src/service-worker.js   quiescence scheduler and event listeners
test/matcher.test.mjs   matching across the profiles and match types
test/cleanup.test.mjs   claim-based duplicate detection (findDuplicateTabIds)
test/order.test.mjs     final pinned-tab ordering
test/drift.test.mjs     drift-tolerant pin-to-tab assignment
test/reconcile.test.mjs reconcileWindow against a mocked chrome (window targeting, idempotence)
build.mjs               regenerates background.js from src/
package.json            npm test and npm run build
```

Run the tests with Node 18 or newer:

```
npm test
```

After changing anything under `src/`, regenerate the shipped worker:

```
npm run build
```

For Chrome Web Store packaging, `node build-store.mjs` produces `dist/store-upload.zip` (runtime files only, manifest `key` field stripped), and `node build-store.mjs --first-upload` additionally bundles `key.pem` so the initial upload keeps the extension ID. `STORE.md` has the full submission walkthrough and paste-ready dashboard answers; `PRIVACY.md` is the privacy policy the listing links to.

`build.mjs` concatenates the four source modules with their `import` and `export` lines stripped, which keeps the shipped file a single classic service worker (no module loading to break) while the matcher inside it stays identical to the tested source. Never commit `key.pem` (the private key pairing with the manifest `key` field); `.gitignore` covers it.

## Known behavior and limits

- Drift tolerance means a pin is satisfied by any still-unclaimed pinned tab on the same origin once stricter matches fail. Two pins on the same origin that have BOTH drifted get claimed in list order, which can occasionally pair a pin with the other pin's drifted tab; no duplicates are created either way, and the next exact match re-anchors them.
- A plain pin under a path-matching profile treats a query-variant tab as the same pin. So a Smart `/tasks` pin will consider a `/tasks?filter=...` tab a match. If you want the board and a filtered view as separate pins, set both to Exact.
- Reorder enforces the list order whenever it runs, including on reload and "Apply to this window." If you manually drag your pinned tabs into a different order and then reload, they snap back to the list order. Set order with the up and down arrows instead.
- The settle wait handles normal restores. A very large session that takes many seconds to restore is covered as long as Chrome keeps firing tab events while it loads.
- Exact matching keys on the whole URL, so if an app rewrites the query string as you use a view, a restored tab whose URL has drifted from the saved pin won't match and you could get a second tab. Saved-view filter URLs are generally stable.

## Version history

- **0.7.1** Duplicate-pin fixes: created tabs now target the window being reconciled (previously they landed in the focused window, so a multi-window restore piled every window's pin set into one window), and cleanup now collapses duplicates by each pin's own match rule instead of exact URL only, so a duplicate that navigated is still removed. Cleanup never removes a same-site pinned tab the matcher treats as distinct (a second Slack channel, another Google account), never touches blank still-loading tabs, and no longer acts on a stale snapshot if the window closes mid-pass.
- **0.7.0** Store readiness: icon set (16/32/48/128) wired into the manifest and toolbar, privacy policy, store packaging script, and submission notes.
- **0.6.0** Drift-tolerant matching: a pinned tab you've navigated around in still counts as its pin (same-origin claiming), so restores no longer duplicate drifted tabs. Removed the hardcoded seed pins; an empty list now stays empty until sync delivers it or you add pins.
- **0.5.0** Stability-polling scheduler: reconcile waits until a window's tab set stops changing, with a delayed cleanup-only recheck.
- **0.4.0** Reorder pass that puts pinned tabs back into the list order after creation and cleanup.
- **0.3.0** Quiescence-based scheduling to stop the cold-start restore race, plus collapse of identical-URL pinned duplicates.
- **0.2.0** Management interface, per-pin match types, and the stable-ID key.
- **0.1.0** Background engine: pin on new windows with smart matching and restore-aware dedup.
