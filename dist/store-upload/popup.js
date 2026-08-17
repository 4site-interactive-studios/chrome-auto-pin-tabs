// popup.js
// The toolbar popup: a thin view over the service worker. Every decision (can this
// tab become a pin, is it already one, rename, removal, ordering) happens in the
// worker via messages, so matcher and storage logic live in exactly one place.

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false });
      }
    });
  });
}

const HINTS = {
  "not-http": "Only http and https pages can be pinned.",
  "no-tab": "No pinnable tab in this window.",
};

// True while a drag or rename is in progress: background refreshes (storage sync
// from another device, our own writes echoing back) must not rebuild the list
// under the user's cursor.
let busy = false;

function setHint(text) {
  document.getElementById("hint").textContent = text || "";
}

function startRename(li, nameEl, editBtn, pin) {
  busy = true;
  li.draggable = false;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename";
  input.value = pin.label || "";
  input.placeholder = pin.name;
  nameEl.replaceWith(input);
  editBtn.disabled = true;
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    busy = false;
    if (commit && input.value.trim() !== (pin.label || "")) {
      await send({ type: "renamePin", id: pin.id, url: pin.url, match: pin.match, label: input.value });
    }
    refresh();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

async function commitOrder(pins) {
  const list = document.getElementById("pinList");
  const order = [...list.children].map((li) => pins[Number(li.dataset.index)]);
  const moved = order.some((p, i) => p !== pins[i]);
  if (!moved) return;
  const resp = await send({
    type: "reorderPins",
    order: order.map((p) => ({ id: p.id, url: p.url, match: p.match })),
  });
  setHint(resp.ok ? "Order applied to this window." : "Reorder failed.");
  refresh();
}

function renderPins(pins) {
  const list = document.getElementById("pinList");
  list.textContent = "";
  document.getElementById("empty").hidden = pins.length > 0;
  pins.forEach((pin, i) => {
    const li = document.createElement("li");
    li.className = "pin";
    li.dataset.index = i;

    // Dragging arms on the handle only, so text selection and the rename input
    // never fight the drag machinery.
    const handle = document.createElement("span");
    handle.className = "handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";
    handle.addEventListener("mousedown", () => {
      if (!busy) li.draggable = true;
    });

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = pin.name;
    name.title = pin.url;

    const edit = document.createElement("button");
    edit.className = "iconbtn";
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = "Rename " + pin.name;
    edit.addEventListener("click", () => startRename(li, name, edit, pin));

    const remove = document.createElement("button");
    remove.className = "danger";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove " + pin.name;
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await send({ type: "removePin", url: pin.url, match: pin.match });
      refresh();
    });

    li.addEventListener("dragstart", (e) => {
      busy = true;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      li.draggable = false;
      busy = false;
      commitOrder(pins);
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      const dragging = list.querySelector(".dragging");
      if (!dragging || dragging === li) return;
      const r = li.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      list.insertBefore(dragging, before ? li : li.nextSibling);
    });

    li.append(handle, name, edit, remove);
    list.appendChild(li);
  });
}

function renderTab(tab) {
  const button = document.getElementById("pinTab");
  document.getElementById("tabTitle").textContent = tab.title || "—";
  document.getElementById("tabUrl").textContent = tab.url || "";
  button.textContent = "Pin this tab";
  button.disabled = tab.status !== "pinnable";
  if (tab.status === "already-pin") {
    button.textContent = "Already a pin";
    setHint(tab.matchedName ? `Covered by "${tab.matchedName}".` : "");
  } else {
    setHint(HINTS[tab.status] || "");
  }
}

async function refresh() {
  if (busy) return;
  const state = await send({ type: "getPopupState" });
  if (!state.ok) {
    setHint("Couldn't reach the extension.");
    document.getElementById("pinTab").disabled = true;
    return;
  }
  renderTab(state.tab);
  renderPins(state.pins);
}

document.getElementById("pinTab").addEventListener("click", async () => {
  const button = document.getElementById("pinTab");
  button.disabled = true; // double-click guard; refresh() sets the real state
  const resp = await send({ type: "pinCurrentTab" });
  if (!resp.ok && resp.reason) setHint(HINTS[resp.reason] || "");
  refresh();
});

document.getElementById("applyNow").addEventListener("click", async () => {
  const resp = await send({ type: "applyNow" });
  setHint(resp.ok ? "Applied to this window." : "Apply failed.");
});

document.getElementById("manage").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Let a row be dropped past the last item.
document.getElementById("pinList").addEventListener("dragover", (e) => e.preventDefault());

// Re-render when pins change elsewhere (options page, another synced machine) —
// but never mid-drag or mid-rename.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.pins) refresh();
});

refresh();
