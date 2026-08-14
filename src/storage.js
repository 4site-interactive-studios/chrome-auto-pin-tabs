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

export async function getPins() {
  const { pins } = await chrome.storage.sync.get("pins");
  return Array.isArray(pins) ? pins : [];
}

export async function setPins(pins) {
  await chrome.storage.sync.set({ pins });
}

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  await chrome.storage.sync.set({ settings: { ...current, ...patch } });
}
