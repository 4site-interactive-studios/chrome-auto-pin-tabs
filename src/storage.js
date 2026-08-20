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
  // Keep the pin set to ONE window: don't create pins in a window when some other
  // normal window already has them (see findCoveringWindow). On by default — the pins
  // are a workspace, not something every scratch window needs. Turn it off to put the
  // full set in every window.
  skipWhenCovered: true,
  // Sub-option of skipWhenCovered: how much another window needs before it counts as
  // already having the pins.
  //   "all" -> it must hold a pinned tab for EVERY pin (default). If it's missing even
  //            one, the next window gets the full set.
  //   "any" -> holding a pinned tab for even ONE pin is enough. Only a window where
  //            ALL of them are missing gets pinned.
  coverageMode: "all",
  // Sub-option of skipWhenCovered, only consulted when that is on: when the window
  // that was holding the pins closes and nothing else covers them, put them in the
  // window the user is now looking at.
  repinOnClose: true,
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
