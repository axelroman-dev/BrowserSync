// Read-only viewer for what's actually stored (encrypted) on the server:
// decrypts the current remote bookmarks/history/extensions blobs and
// renders them. Never writes anything back - this page only calls the
// fetchRemote*/getRemoteExtensions helpers, never the sync functions.
//
// All dynamic content is built with createElement/textContent rather than
// innerHTML, even though it's the user's own decrypted data - defense in
// depth against a title/URL ever containing markup.
import * as auth from "../lib/auth.js";
import { fetchRemoteBookmarksTree } from "../lib/bookmarksSync.js";
import { fetchRemoteHistory } from "../lib/historySync.js";
import { fetchRemoteExtensions } from "../lib/extensionsList.js";

const views = {
  notConnected: document.getElementById("not-connected-view"),
  locked: document.getElementById("locked-view"),
  needsRepair: document.getElementById("needs-repair-view"),
  data: document.getElementById("data-view"),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function formatDate(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString();
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderBookmarkNode(node) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row";

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.textContent = node.kind === "folder" ? "📁" : "🔖";
  row.appendChild(icon);

  if (node.kind === "bookmark" && node.url) {
    const link = document.createElement("a");
    link.href = node.url;
    link.textContent = node.title || node.url;
    link.title = node.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.appendChild(link);
  } else {
    const label = document.createElement("span");
    label.className = "folder-label";
    label.textContent = node.title || "(untitled folder)";
    row.appendChild(label);
  }
  li.appendChild(row);

  if (node.children?.length) {
    const ul = document.createElement("ul");
    for (const child of node.children) ul.appendChild(renderBookmarkNode(child));
    li.appendChild(ul);
  }
  return li;
}

async function loadBookmarks(key) {
  const { tree, updatedAt } = await fetchRemoteBookmarksTree(key);
  document.getElementById("bookmarks-meta").textContent = `Last synced: ${formatDate(updatedAt)}`;
  const container = document.getElementById("bookmarks-tree");
  clear(container);
  if (!tree.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No bookmarks have been synced yet.";
    container.appendChild(empty);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "tree-root";
  for (const node of tree) ul.appendChild(renderBookmarkNode(node));
  container.appendChild(ul);
}

let allHistoryEntries = [];

function renderHistoryEntries(entries) {
  const container = document.getElementById("history-list");
  clear(container);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No matching history entries.";
    container.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "list-row";

    const link = document.createElement("a");
    link.href = entry.url;
    link.textContent = entry.title || entry.url;
    link.title = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.appendChild(link);

    const time = document.createElement("span");
    time.className = "list-time";
    time.textContent = new Date(entry.lastVisitTime).toLocaleString();
    row.appendChild(time);

    container.appendChild(row);
  }
}

async function loadHistory(key) {
  const { entries, updatedAt } = await fetchRemoteHistory(key);
  allHistoryEntries = entries;
  document.getElementById("history-meta").textContent =
    `Last synced: ${formatDate(updatedAt)} - ${entries.length} entries`;
  renderHistoryEntries(allHistoryEntries);
}

document.getElementById("history-filter").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = q
    ? allHistoryEntries.filter((entry) => entry.title.toLowerCase().includes(q) || entry.url.toLowerCase().includes(q))
    : allHistoryEntries;
  renderHistoryEntries(filtered);
});

async function loadExtensions(key) {
  const { extensions, updatedAt } = await fetchRemoteExtensions(key);
  document.getElementById("extensions-meta").textContent = `Last synced: ${formatDate(updatedAt)}`;
  const container = document.getElementById("extensions-list");
  clear(container);
  if (!extensions.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No extension list has been synced yet.";
    container.appendChild(empty);
    return;
  }
  for (const ext of extensions) {
    const row = document.createElement("div");
    row.className = "list-row";

    const name = document.createElement("span");
    name.textContent = ext.name;
    row.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "badge " + (ext.enabled ? "badge-on" : "badge-off");
    badge.textContent = ext.enabled ? "enabled" : "disabled";
    row.appendChild(badge);

    container.appendChild(row);
  }
}

// --- Tabs ---
for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab-btn")) b.classList.toggle("active", b === btn);
    for (const panel of document.querySelectorAll(".tab-panel")) {
      panel.classList.toggle("active", panel.id === `tab-${btn.dataset.tab}`);
    }
  });
}

async function loadAllData() {
  const dataError = document.getElementById("data-error");
  dataError.hidden = true;
  try {
    const key = await auth.getActiveKey();
    await Promise.all([loadBookmarks(key), loadHistory(key), loadExtensions(key)]);
  } catch (err) {
    // Most likely cause: the passphrase just entered doesn't match the one
    // this data was encrypted with (AES-GCM's auth tag fails to verify).
    dataError.textContent =
      "Could not decrypt your synced data - this usually means the passphrase is wrong. " +
      (err.message || "");
    dataError.hidden = false;
  }
}

async function init() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) {
    showView("notConnected");
    return;
  }
  document.getElementById("account-label").textContent = `${session.accountEmail} · ${new URL(session.serverUrl).host}`;

  if (!session.isUnlocked) {
    showView(session.hasLocalEnvelope ? "locked" : "needsRepair");
    return;
  }

  showView("data");
  await loadAllData();
}

document.getElementById("unlock-btn").addEventListener("click", async () => {
  const password = document.getElementById("unlock-password").value;
  const errorEl = document.getElementById("unlock-error");
  if (!password) {
    errorEl.textContent = "Enter your password.";
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;
  try {
    await auth.unlock(password);
  } catch (err) {
    if (err.code === "no_local_envelope") {
      showView("needsRepair");
      return;
    }
    errorEl.textContent = err.message || "Could not unlock.";
    errorEl.hidden = false;
    return;
  }
  showView("data");
  await loadAllData();
});

init();
