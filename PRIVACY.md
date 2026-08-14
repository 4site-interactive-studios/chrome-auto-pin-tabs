# Privacy Policy for Auto Pin Tabs

Last updated: August 14, 2026

Auto Pin Tabs is a Chrome extension that automatically pins a user-configured set of tabs in new browser windows without creating duplicates. This policy describes what the extension can access and what happens to that information.

## What the extension accesses

To detect whether one of your configured pins is already open, the extension reads the web addresses (URLs) and titles of tabs in your browser windows. This is what the `tabs` permission is used for. Reading happens entirely inside your browser, at the moment a window opens or when you use the "Apply to this window" or "Import open pinned tabs" buttons.

## What the extension stores

The extension stores the list of pins you configure (each pin's URL, label, and match setting) and your two settings (when to pin, and whether to clean up duplicate tabs after a session restore). This data is saved using Chrome's built-in `chrome.storage.sync` area, which means Google Chrome may sync it between your own signed-in browsers, under your Google account, exactly as Chrome syncs your bookmarks and settings. That syncing is performed by Chrome itself and is governed by Google Chrome's privacy policy.

## What the extension does not do

The extension does not collect, transmit, sell, or share any data with the developer or with any third party. It contains no analytics, no tracking, no advertising, and makes no network requests of its own. No browsing activity ever leaves your browser because of this extension. The developer has no access to your pin list, your tab URLs, or anything else.

## Data removal

All data lives in your Chrome profile's extension storage. Removing the extension deletes its stored data, per Chrome's normal extension lifecycle. You can also remove individual pins at any time from the extension's options page.

## Contact

Questions about this policy can be raised as an issue on the project repository: https://github.com/4site-interactive-studios/chrome-auto-pin-tabs
