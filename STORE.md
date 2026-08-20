# Chrome Web Store submission notes

Paste-ready answers for the developer dashboard, plus the upload steps. Everything here
must stay true of the actual code; reviewers cross-check the manifest, these
disclosures, and the privacy policy against each other.

## Upload steps

1. Developer account at https://chrome.google.com/webstore/devconsole (one-time $5 fee).
2. Build the first-upload package: `node build-store.mjs --first-upload` (needs key.pem
   next to the repo or inside it; never committed). This includes key.pem so the store
   keeps the extension ID `cdplkgcjpmplghpflbgolpgafngfjlfo`, which preserves synced
   pins for existing installs.
3. Add new item, upload `dist/store-upload-first.zip`.
4. Before publishing, open the item's Package tab and confirm the ID reads
   `cdplkgcjpmplghpflbgolpgafngfjlfo`. If it doesn't, stop and re-check; publishing
   under a different ID means synced data will not carry over.
5. Fill the listing and privacy tabs with the text below, add at least one screenshot
   (1280x800; the options page next to a window with pinned tabs), pick visibility
   (Unlisted fits an internal/team tool: install by link only), and submit for review.
6. Future updates: `node build-store.mjs` and upload `dist/store-upload.zip` (no
   key.pem, and the "key" field stays stripped automatically).

## Listing

Name: Auto Pin Tabs

Summary (short description):
Automatically pins your chosen tabs in every new window, without duplicates, even
across session restores.

Category: Workflow & Planning (or Productivity)

Detailed description:
Auto Pin Tabs keeps a configured set of pinned tabs in place. Open a new window and
your pins are there; restart Chrome and nothing gets duplicated.

Per-app smart matching understands Gmail, Google Calendar, Google Drive, Productive,
and Slack, so an open email thread, a changing calendar date, or a Slack deep link
doesn't spawn a second copy of a tab you already have. The same site can be pinned at
different paths as separate tabs, and exact matching supports pinning a specific
filtered view. After a session restore, the extension removes Chrome's own duplicate
copies of pinned tabs and puts everything back in your configured order.

Configuration lives in the options page: add pins by URL or import your currently
pinned tabs, reorder them, choose how each one matches, and pick whether pinning
happens on every new window or only at startup. If you only want the set in your main
window, "keep the pinned tabs to one window" (on by default) leaves new windows bare
for as long as another window still has the pins — strictly (it needs all of them) or
loosely (one is enough), your choice. Turn it off to put the set in every window. Settings sync across your signed-in
Chrome browsers. The extension makes no network requests and collects nothing.

## Privacy tab

Single purpose description:
Automatically pins a user-configured set of tabs in new browser windows without
creating duplicate tabs.

Permission justifications:

tabs: Required to read the URLs and titles of open tabs so the extension can detect
whether a configured pin is already open in a window (preventing duplicate pinned
tabs), remove duplicate copies after a session restore, and let the user import their
currently pinned tabs on the options page. URLs are read in-browser only and are never
transmitted anywhere.

storage: Stores the user's own configuration (their pin list and two settings) in
chrome.storage.sync so it persists and follows the user across their signed-in Chrome
browsers. No other data is stored.

Remote code: No, the extension does not use remote code. All code is packaged in the
extension.

Data usage disclosures: check NONE of the data categories. The extension does not
collect or transmit user data. Tab URLs are read transiently in-browser for duplicate
detection and are not collected; the pin list is user-entered configuration stored via
Chrome's own sync.

Certify the three Limited Use statements (no disallowed use, no disallowed transfer,
no use for creditworthiness/lending).

Privacy policy URL:
https://github.com/4site-interactive-studios/chrome-auto-pin-tabs/blob/main/PRIVACY.md

## After publication

The store version and the unpacked developer version share one extension ID, so they
cannot be installed side by side. Remove the unpacked extension, install from the
store link, and the synced pin list appears as-is.
