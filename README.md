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

**Cleanup.** On a restored window it removes any unpinned tab that is a copy of a pinned tab (Chrome's own restore-twin bug), and collapses any pinned tabs that share an identical URL, keeping the leftmost. All comparisons here are on the full URL, so only true identical copies are removed, never a different view that shares a path.

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
test/cleanup.test.mjs   twin removal and duplicate collapse
test/order.test.mjs     final pinned-tab ordering
package.json            type:module, so Node loads the source for tests
```

Run the tests with Node 18 or newer:

```
node test/matcher.test.mjs
node test/cleanup.test.mjs
node test/order.test.mjs
```

`background.js` is the four source modules concatenated with their `import` and `export` lines stripped, which keeps the shipped file a single classic service worker (no module loading to break) while the matcher inside it stays identical to the tested source.

## Known behavior and limits

- A plain pin under a path-matching profile treats a query-variant tab as the same pin. So a Smart `/tasks` pin will consider a `/tasks?filter=...` tab a match. If you want the board and a filtered view as separate pins, set both to Exact.
- Reorder enforces the list order whenever it runs, including on reload and "Apply to this window." If you manually drag your pinned tabs into a different order and then reload, they snap back to the list order. Set order with the up and down arrows instead.
- The settle wait handles normal restores. A very large session that takes many seconds to restore is covered as long as Chrome keeps firing tab events while it loads.
- Exact matching keys on the whole URL, so if an app rewrites the query string as you use a view, a restored tab whose URL has drifted from the saved pin won't match and you could get a second tab. Saved-view filter URLs are generally stable.

## Version history

- **0.4.0** Reorder pass that puts pinned tabs back into the list order after creation and cleanup.
- **0.3.0** Quiescence-based scheduling to stop the cold-start restore race, plus collapse of identical-URL pinned duplicates.
- **0.2.0** Management interface, per-pin match types, and the stable-ID key.
- **0.1.0** Background engine: pin on new windows with smart matching and restore-aware dedup.