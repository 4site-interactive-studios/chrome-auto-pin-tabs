// options.js
// Management interface for Auto Pin Tabs. Reads and writes the same chrome.storage.sync
// keys the service worker uses ("pins" and "settings"). Changes take effect on the next
// new window automatically; "Apply to this window" reconciles the current window now.

// --- Static reference data ---------------------------------------------------------

// Friendly names for the per-pin match modes shown in the dropdowns.
const MATCH_LABELS = {
  smart: "Smart (auto-detect)",
  exact: "Exact URL",
  path: "Path",
  hashview: "Path + #hash",
  domain: "Whole site",
};
const MATCH_ORDER = ["smart", "exact", "path", "hashview", "domain"];

// Mirror of the service worker's app detection, used only to show a live note while
// adding a pin. Keep these hosts in sync with matcher.js.
const APP_HOSTS = {
  "mail.google.com": "gmail",
  "calendar.google.com": "gcal",
  "drive.google.com": "gdrive",
  "app.productive.io": "productive",
  "app.slack.com": "slack",
};
const APP_NAMES = {
  gmail: "Gmail",
  gcal: "Google Calendar",
  gdrive: "Google Drive",
  productive: "Productive",
  slack: "Slack",
};
const MATCH_DESCRIPTIONS = {
  gmail: "Matches by account and view (Inbox, Sent, a label), ignoring which message is open.",
  gcal: "Matches by account. Any calendar view or date counts as this one pin.",
  gdrive: "Matches by account. Any Drive location counts as this one pin.",
  productive: "Matches the exact path, so /tasks and /time/me stay separate.",
  slack: "Matches the workspace and channel, ignoring any open thread.",
  path: "Matches the site and path, ignoring the query string and #fragment.",
  exact: "Matches the full URL, including the query string and #fragment.",
  hashview: "Matches the path and #fragment, ignoring the query string.",
  domain: "Matches any page on this site.",
};

const DEFAULTS = { applyMode: "startup_and_new", cleanupTwins: true, skipWhenCovered: true, coverageMode: "all", repinOnClose: true };

function detectApp(host) {
  return APP_HOSTS[(host || "").toLowerCase()] || "path";
}

// --- State -------------------------------------------------------------------------

let pins = [];
let settings = { ...DEFAULTS };

async function loadState() {
  const got = await chrome.storage.sync.get(["pins", "settings"]);
  pins = Array.isArray(got.pins) ? got.pins : [];
  settings = { ...DEFAULTS, ...(got.settings || {}) };
}
async function savePins() {
  await chrome.storage.sync.set({ pins });
}
async function saveSettings() {
  await chrome.storage.sync.set({ settings });
}

// --- Helpers -----------------------------------------------------------------------

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || "pin-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

function deriveName(pin) {
  if (pin.label) return pin.label;
  try {
    const u = new URL(pin.url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.host;
  } catch {
    return pin.url;
  }
}

// One-line, human-readable description of how a URL will be matched.
function describeMatch(url, match) {
  let m = match;
  if (m === "smart") {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      return "Enter a full URL to see how it will match.";
    }
    m = detectApp(host);
    if (APP_NAMES[m]) return `Detected ${APP_NAMES[m]}. ${MATCH_DESCRIPTIONS[m]}`;
    return `No known app for this site, using path matching. ${MATCH_DESCRIPTIONS.path}`;
  }
  return MATCH_DESCRIPTIONS[m] || "";
}

function makeMatchSelect(value, onChange) {
  const sel = document.createElement("select");
  sel.className = "row-match";
  for (const key of MATCH_ORDER) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = MATCH_LABELS[key];
    if (key === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

let toastTimer = null;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

// --- Rendering ---------------------------------------------------------------------

function render() {
  const list = document.getElementById("pinList");
  list.textContent = "";
  document.getElementById("empty").hidden = pins.length > 0;

  pins.forEach((pin, i) => {
    const li = document.createElement("li");
    li.className = "pin";

    // Move up / down
    const moves = document.createElement("div");
    moves.className = "moves";
    const up = document.createElement("button");
    up.className = "icon";
    up.type = "button";
    up.textContent = "\u2191";
    up.title = "Move up";
    up.disabled = i === 0;
    up.addEventListener("click", () => move(i, -1));
    const down = document.createElement("button");
    down.className = "icon";
    down.type = "button";
    down.textContent = "\u2193";
    down.title = "Move down";
    down.disabled = i === pins.length - 1;
    down.addEventListener("click", () => move(i, 1));
    moves.append(up, down);

    // Body: name (+ rename), url, match select + note
    const body = document.createElement("div");
    body.className = "body";
    const nameRow = document.createElement("div");
    nameRow.className = "name-row";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = deriveName(pin);
    const rename = document.createElement("button");
    rename.className = "icon";
    rename.type = "button";
    rename.textContent = "✎";
    rename.title = "Rename";
    rename.addEventListener("click", () => {
      // The label is display-only; matching keys on the URL, never the name.
      const input = document.createElement("input");
      input.type = "text";
      input.className = "rename";
      input.value = pin.label || "";
      input.placeholder = deriveName({ ...pin, label: "" });
      name.replaceWith(input);
      rename.disabled = true;
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit && input.value.trim() !== (pin.label || "")) {
          pin.label = input.value.trim(); // empty goes back to the automatic name
          savePins().then(render);
        } else {
          render();
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
    });
    nameRow.append(name, rename);
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = pin.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    const sel = makeMatchSelect(pin.match || "smart", (val) => {
      pin.match = val;
      savePins().then(render);
    });
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = describeMatch(pin.url, pin.match || "smart");
    meta.append(sel, note);

    body.append(nameRow, url, meta);

    // Remove
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      pins = pins.filter((p) => p.id !== pin.id);
      savePins().then(render);
    });

    li.append(moves, body, remove);
    list.appendChild(li);
  });
}

// --- Actions -----------------------------------------------------------------------

function move(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= pins.length) return;
  const [item] = pins.splice(index, 1);
  pins.splice(target, 0, item);
  savePins().then(render);
}

function addPin() {
  const urlInput = document.getElementById("url");
  const matchInput = document.getElementById("match");
  const labelInput = document.getElementById("label");
  const preview = document.getElementById("preview");

  const raw = urlInput.value.trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    preview.textContent = "Enter a full URL starting with http:// or https://";
    preview.classList.add("error");
    urlInput.focus();
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    preview.textContent = "Only http and https URLs can be pinned.";
    preview.classList.add("error");
    urlInput.focus();
    return;
  }

  pins.push({
    id: newId(),
    url: raw,
    match: matchInput.value || "smart",
    label: labelInput.value.trim() || "",
  });
  savePins().then(() => {
    urlInput.value = "";
    labelInput.value = "";
    matchInput.value = "smart";
    preview.classList.remove("error");
    updatePreview();
    render();
    toast("Pin added");
  });
}

async function importPinned() {
  const tabs = await chrome.tabs.query({ pinned: true });
  const existing = new Set(pins.map((p) => p.url));
  let added = 0;
  for (const t of tabs) {
    const u = t.url || t.pendingUrl || "";
    if (!/^https?:\/\//.test(u)) continue;
    if (existing.has(u)) continue;
    existing.add(u);
    pins.push({
      id: newId(),
      url: u,
      match: "smart",
      label: (t.title || "").slice(0, 40),
    });
    added++;
  }
  if (added > 0) {
    await savePins();
    render();
  }
  toast(added === 0 ? "No new pinned tabs to import" : `Imported ${added} pinned tab${added === 1 ? "" : "s"}`);
}

function applyNow() {
  chrome.runtime.sendMessage({ type: "applyNow" }, (resp) => {
    if (chrome.runtime.lastError) {
      toast("Couldn't reach the extension");
    } else if (resp && resp.ok) {
      toast("Applied to this window");
    } else {
      toast("Apply failed");
    }
  });
}

// --- Live preview for the add form -------------------------------------------------

function updatePreview() {
  const url = document.getElementById("url").value.trim();
  const match = document.getElementById("match").value;
  const preview = document.getElementById("preview");
  preview.classList.remove("error");
  preview.textContent = url ? describeMatch(url, match) : "Paste a URL and pick how it should match.";
}

// --- Init --------------------------------------------------------------------------

function buildMatchDropdown() {
  const sel = document.getElementById("match");
  for (const key of MATCH_ORDER) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = MATCH_LABELS[key];
    sel.appendChild(opt);
  }
  sel.value = "smart";
}

async function init() {
  buildMatchDropdown();
  await loadState();

  // Reflect pin changes made elsewhere (the toolbar popup, another synced machine)
  // instead of clobbering them: without this, the module-level `pins` array goes
  // stale and the next save here would write the removed pin right back.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.pins) {
      loadState().then(render);
    }
  });

  // Settings controls
  const applyMode = document.getElementById("applyMode");
  applyMode.value = settings.applyMode;
  applyMode.addEventListener("change", () => {
    settings.applyMode = applyMode.value;
    saveSettings().then(() => toast("Saved"));
  });

  const cleanup = document.getElementById("cleanupTwins");
  cleanup.checked = settings.cleanupTwins !== false;
  cleanup.addEventListener("change", () => {
    settings.cleanupTwins = cleanup.checked;
    saveSettings().then(() => toast("Saved"));
  });

  // Single-window mode, plus its two sub-options. The sub-options keep their stored
  // values but are inert (and shown greyed) while the parent is off, so they can't read
  // as active.
  const skip = document.getElementById("skipWhenCovered");
  const coverage = document.getElementById("coverageMode");
  const coverageRow = document.getElementById("coverageModeRow");
  const repin = document.getElementById("repinOnClose");
  const repinRow = document.getElementById("repinOnCloseRow");
  function syncSubEnabled() {
    const off = !skip.checked;
    coverage.disabled = off;
    repin.disabled = off;
    coverageRow.classList.toggle("disabled", off);
    repinRow.classList.toggle("disabled", off);
  }
  skip.checked = settings.skipWhenCovered === true;
  coverage.value = settings.coverageMode === "any" ? "any" : "all";
  repin.checked = settings.repinOnClose !== false;
  syncSubEnabled();
  skip.addEventListener("change", () => {
    settings.skipWhenCovered = skip.checked;
    syncSubEnabled();
    saveSettings().then(() => toast("Saved"));
  });
  coverage.addEventListener("change", () => {
    settings.coverageMode = coverage.value;
    saveSettings().then(() => toast("Saved"));
  });
  repin.addEventListener("change", () => {
    settings.repinOnClose = repin.checked;
    saveSettings().then(() => toast("Saved"));
  });

  // Add form
  document.getElementById("add").addEventListener("click", addPin);
  document.getElementById("importPinned").addEventListener("click", importPinned);
  document.getElementById("applyNow").addEventListener("click", applyNow);
  document.getElementById("url").addEventListener("input", updatePreview);
  document.getElementById("match").addEventListener("change", updatePreview);
  document.getElementById("url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addPin();
  });

  updatePreview();
  render();
}

init();
