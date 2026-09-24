// Vanilla JS, no build step - deliberately matches the extension's own
// no-framework style. Talks to the same-origin /api/auth and /api/sync
// endpoints this server already exposes to the extension; this page is just
// another client of that API, not a special back-channel.
import { initI18n, t } from "./i18n.js";

await initI18n();

const STORAGE_KEY = "browsersync_dashboard_session";
const DEVICE_LABEL = "Account dashboard";

// --- Crypto: a direct port of extension/lib/crypto.js's passphrase-side
// derivation (deriveKekFromPassphrase/unwrapDEK/decryptJSON), using the same
// browser-native Web Crypto API the extension uses - nothing here is
// server-specific. Only the passphrase-wrapped path is needed (not the
// password-wrapped one): unlike a browser extension, this page has no local
// storage of its own worth trusting with a device envelope, so every unlock
// goes through the recovery passphrase, exactly like setting up a brand new
// device would. The derived DEK lives only in the `unlockedKey` module
// variable below - never localStorage, never sent anywhere - and is dropped
// on Lock, logout, or page reload.
const PBKDF2_ITERATIONS = 600_000;

async function deriveSalt(purpose, email) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`browsersync-${purpose}:${email.toLowerCase()}`));
  return new Uint8Array(digest);
}

async function deriveKekFromPassphrase(passphrase, email) {
  const encoder = new TextEncoder();
  const salt = await deriveSalt("kek-passphrase", email);
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function decryptJSON(key, ciphertextBase64, ivBase64) {
  const iv = base64ToBuffer(ivBase64);
  const ciphertext = base64ToBuffer(ciphertextBase64);
  const plaintextBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintextBuffer));
}

async function importKeyRaw(base64Key) {
  const raw = base64ToBuffer(base64Key);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

async function unwrapDEK(kek, envelope) {
  const { dek } = await decryptJSON(kek, envelope.ciphertext, envelope.iv);
  return importKeyRaw(dek);
}

/**
 * Same shape-building as extension/lib/bookmarksSync.js's buildDisplayTree():
 * turns the flat `nodes` array of a decrypted bookmarks payload into a
 * nested tree for rendering. Pure function, no side effects.
 */
function buildDisplayTree(nodes) {
  const bySyncId = new Map(nodes.map((n) => [n.syncId, { ...n, children: [] }]));
  const roots = [];
  for (const node of bySyncId.values()) {
    if (node.parentSyncId && bySyncId.has(node.parentSyncId)) {
      bySyncId.get(node.parentSyncId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortByIndex = (a, b) => a.index - b.index;
  for (const node of bySyncId.values()) node.children.sort(sortByIndex);
  roots.sort(sortByIndex);
  return roots;
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

let session = loadSession();
// The unwrapped DEK for the current unlock, kept only in memory - see the
// crypto section's comment above for why it never touches localStorage.
let unlockedKey = null;

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed with status ${status}`);
    this.status = status;
    this.code = body?.error;
  }
}

async function rawRequest(path, { method = "GET", body, accessToken } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

// Mirrors extension/lib/api.js's withAuthRetry: one automatic retry after
// refreshing the access token on a 401, so callers never have to think
// about token expiry (the dashboard's access token is short-lived, same TTL
// as a device's).
async function authFetch(path, options = {}) {
  if (!session) throw new ApiError(401, { message: t("dashboard.notLoggedIn") });
  try {
    return await rawRequest(path, { ...options, accessToken: session.accessToken });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const { accessToken } = await rawRequest("/api/auth/refresh", {
        method: "POST",
        body: { refreshToken: session.refreshToken },
      });
      session = { ...session, accessToken };
      saveSession(session);
      return rawRequest(path, { ...options, accessToken: session.accessToken });
    }
    throw err;
  }
}

function showView(loggedIn) {
  document.getElementById("login-view").hidden = loggedIn;
  document.getElementById("dashboard-view").hidden = !loggedIn;
  document.getElementById("account-bar").hidden = !loggedIn;
}

function formatBytes(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : t("common.never");
}

function dataTypeLabels() {
  return {
    bookmarks: t("dashboard.dataTypeBookmarks"),
    history: t("dashboard.dataTypeHistory"),
    extensions: t("dashboard.dataTypeExtensions"),
    passwords: t("dashboard.dataTypePasswords"),
  };
}

async function loadAccount() {
  const account = await authFetch("/api/auth/me");
  document.getElementById("account-email").textContent = account.email;
  document.getElementById("account-email-detail").textContent = account.email;
  document.getElementById("account-created").textContent = formatDate(account.createdAt);
}

// Data types that currently have something stored - drives both the status
// list and which tabs the data viewer offers.
let syncedTypes = [];

async function loadStatus() {
  const errorEl = document.getElementById("status-error");
  const container = document.getElementById("status-list");
  const viewBtn = document.getElementById("open-data-btn");
  errorEl.hidden = true;
  container.textContent = "";
  try {
    const { blobs } = await authFetch("/api/sync/status");
    // Only what's actually been synced: a type that's off (history is
    // opt-in) or never ran has nothing worth a row.
    const synced = blobs.filter((blob) => blob.version);
    syncedTypes = synced.map((blob) => blob.dataType);
    viewBtn.hidden = !synced.length;
    if (!synced.length) {
      emptyHint(container, "dashboard.nothingSyncedYet");
      return;
    }
    for (const blob of synced) {
      const row = document.createElement("div");
      row.className = "status-row";

      const main = document.createElement("div");
      main.className = "status-row-main";

      const title = document.createElement("span");
      title.className = "status-row-title";
      const dot = document.createElement("span");
      dot.className = "dot dot-ok";
      title.appendChild(dot);
      title.appendChild(document.createTextNode(dataTypeLabels()[blob.dataType] ?? blob.dataType));
      main.appendChild(title);

      const detail = document.createElement("span");
      detail.className = "status-row-detail";
      detail.textContent = t("dashboard.versionDetail", {
        version: blob.version,
        size: formatBytes(blob.sizeBytes),
        date: formatDate(blob.updatedAt),
      });
      main.appendChild(detail);

      row.appendChild(main);
      container.appendChild(row);
    }
  } catch (err) {
    viewBtn.hidden = true;
    errorEl.textContent = err.message || t("dashboard.couldNotLoadSyncStatus");
    errorEl.hidden = false;
  }
}

function armConfirm(btn, warningLabel, armedMs = 4000) {
  const originalLabel = btn.textContent;
  let armed = false;
  let timer = null;
  return function checkArmed() {
    if (armed) {
      armed = false;
      clearTimeout(timer);
      btn.textContent = originalLabel;
      return true;
    }
    armed = true;
    btn.textContent = warningLabel;
    timer = setTimeout(() => {
      armed = false;
      btn.textContent = originalLabel;
    }, armedMs);
    return false;
  };
}

async function doLogout() {
  if (session) {
    await rawRequest("/api/auth/logout", { method: "POST", body: { refreshToken: session.refreshToken } }).catch(() => {
      // Best-effort - the token gets cleared locally either way.
    });
  }
  session = null;
  clearSession();
  for (const dialog of Object.values(dialogs)) dialog.close();
  lockData();
  document.getElementById("login-form").reset();
  showView(false);
}

async function loadDevices() {
  const errorEl = document.getElementById("devices-error");
  const container = document.getElementById("devices-list");
  const bulkRevokeBtn = document.getElementById("revoke-others-btn");
  errorEl.hidden = true;
  container.textContent = "";
  try {
    const { devices } = await authFetch("/api/auth/devices");
    renderDevicesSummary(devices);
    bulkRevokeBtn.hidden = devices.length <= 1;
    if (!devices.length) {
      const empty = document.createElement("p");
      empty.className = "empty-hint";
      empty.textContent = t("dashboard.noDevicesLinked");
      container.appendChild(empty);
      return;
    }
    for (const device of devices) {
      const row = document.createElement("div");
      row.className = "device-row";

      const main = document.createElement("div");
      main.className = "device-row-main";

      const title = document.createElement("span");
      title.className = "device-row-title";
      title.textContent = device.deviceLabel || t("dashboard.unnamedDevice");
      if (device.id === session.deviceId) {
        const badge = document.createElement("span");
        badge.className = "this-device-badge";
        badge.textContent = t("dashboard.thisSession");
        title.appendChild(badge);
      } else if (!device.lastUsedAt) {
        // Never refreshed a token since it was created - most likely a
        // reinstall/incomplete setup ghost (see the "Clean up" button's
        // note) rather than a device someone's actually using.
        const badge = document.createElement("span");
        badge.className = "never-used-badge";
        badge.textContent = t("dashboard.neverUsedBadge");
        title.appendChild(badge);
      }
      main.appendChild(title);

      const detail = document.createElement("span");
      detail.className = "device-row-detail";
      detail.textContent = t("dashboard.linkedMeta", { created: formatDate(device.createdAt), lastUsed: formatDate(device.lastUsedAt) });
      main.appendChild(detail);

      row.appendChild(main);

      // Nothing to click for your own current session here - the header's
      // "Log out" already covers it, and duplicating it in this row (as an
      // earlier version of this page did) was just a second button doing
      // the same thing. "Revoke" is still hard-blocked for it (revoking the
      // token you're browsing with mid-request has no way back).
      if (device.id !== session.deviceId) {
        const revokeBtn = document.createElement("button");
        revokeBtn.type = "button";
        revokeBtn.className = "danger-button";
        revokeBtn.textContent = t("dashboard.revoke");
        const confirmRevoke = armConfirm(revokeBtn, t("common.confirmClickAgain"));
        revokeBtn.addEventListener("click", async () => {
          if (!confirmRevoke()) return;
          revokeBtn.disabled = true;
          try {
            await authFetch(`/api/auth/devices/${device.id}`, { method: "DELETE" });
            await loadDevices();
          } catch (err) {
            errorEl.textContent = err.message || t("dashboard.couldNotRevokeDevice");
            errorEl.hidden = false;
            revokeBtn.disabled = false;
          }
        });
        row.appendChild(revokeBtn);
      }

      container.appendChild(row);
    }
  } catch (err) {
    document.getElementById("devices-summary").textContent = t("dashboard.couldNotLoadDevices");
    errorEl.textContent = err.message || t("dashboard.couldNotLoadDevices");
    errorEl.hidden = false;
  }
}

function renderDevicesSummary(devices) {
  // This dashboard session counts as a linked device too, but it's not what
  // anyone means by "my devices" - leave it out of the headline number.
  const others = devices.filter((device) => device.id !== session.deviceId);
  const neverUsed = others.filter((device) => !device.lastUsedAt).length;
  let text = t("dashboard.devicesSummary", { count: others.length });
  if (neverUsed) text += ` · ${t("dashboard.devicesSummaryNeverUsed", { count: neverUsed })}`;
  document.getElementById("devices-summary").textContent = text;
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
    label.textContent = node.title || t("dashboard.untitledFolder");
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

// --- Synced data viewer (one dialog, one tab per data type) ---
// One passphrase unlock serves every tab. The unwrapped key and every
// decrypted payload live only in these variables, and closing the dialog
// (or Lock, logout, reload) drops them.
const DATA_TYPES = ["bookmarks", "history", "extensions", "passwords"];
// History can hold tens of thousands of entries; render only the first
// matches and let the filter narrow it down.
const MAX_ROWS = 500;

let activeDataType = "bookmarks";
const decryptedCache = new Map(); // dataType -> { payload, updatedAt } | null (nothing synced)
const revealedPasswords = new Set();

function lockData() {
  unlockedKey = null;
  decryptedCache.clear();
  revealedPasswords.clear();
  document.getElementById("data-passphrase").value = "";
  document.getElementById("data-filter").value = "";
  document.getElementById("data-error").hidden = true;
  document.getElementById("data-content").textContent = "";
  document.getElementById("data-locked").hidden = false;
  document.getElementById("data-unlocked").hidden = true;
}

function selectDataTab(dataType) {
  activeDataType = dataType;
  for (const tab of document.querySelectorAll("#data-tabs .tab")) {
    tab.classList.toggle("active", tab.dataset.type === dataType);
  }
  document.getElementById("passwords-warning").hidden = dataType !== "passwords";
  document.getElementById("data-filter").hidden = dataType === "bookmarks";
  document.getElementById("data-filter").value = "";
  if (unlockedKey) showDataTab().catch(showDataError);
}

function showDataError(err) {
  const errorEl = document.getElementById("data-error");
  errorEl.textContent = err?.message || t("dashboard.couldNotDecryptData");
  errorEl.hidden = false;
}

async function fetchDecrypted(dataType, { force = false } = {}) {
  if (!force && decryptedCache.has(dataType)) return decryptedCache.get(dataType);
  const blob = await authFetch(`/api/sync/${dataType}`).catch((err) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });
  const result = blob ? { payload: await decryptJSON(unlockedKey, blob.ciphertext, blob.iv), updatedAt: blob.updatedAt } : null;
  decryptedCache.set(dataType, result);
  return result;
}

/** Fetches (once per unlock) and renders the active tab. */
async function showDataTab({ force = false } = {}) {
  document.getElementById("data-error").hidden = true;
  const dataType = activeDataType;
  const result = await fetchDecrypted(dataType, { force });
  if (dataType !== activeDataType) return; // the user switched tabs meanwhile
  document.getElementById("data-meta").textContent = result
    ? t("dashboard.lastSynced", { date: formatDate(result.updatedAt) })
    : t("dashboard.nothingSyncedForType");
  renderDataContent();
}

function renderDataContent() {
  const container = document.getElementById("data-content");
  container.textContent = "";
  const result = decryptedCache.get(activeDataType);
  if (!result) return;
  const query = document.getElementById("data-filter").value.trim().toLowerCase();
  const renderers = { bookmarks: renderBookmarks, history: renderHistory, extensions: renderExtensions, passwords: renderPasswords };
  renderers[activeDataType](container, result.payload, query);
}

function emptyHint(container, key) {
  const empty = document.createElement("p");
  empty.className = "empty-hint";
  empty.textContent = t(key);
  container.appendChild(empty);
}

function dataRow({ title, href, detail, badge }) {
  const row = document.createElement("div");
  row.className = "data-row";
  const main = document.createElement("div");
  main.className = "data-row-main";
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = title;
    link.title = href;
    main.appendChild(link);
  } else {
    const label = document.createElement("span");
    label.className = "data-row-title";
    label.textContent = title;
    main.appendChild(label);
  }
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.className = "data-row-detail";
    detailEl.textContent = detail;
    main.appendChild(detailEl);
  }
  row.appendChild(main);
  if (badge) {
    const badgeEl = document.createElement("span");
    badgeEl.className = badge.on ? "badge-on" : "badge-off";
    badgeEl.textContent = badge.label;
    row.appendChild(badgeEl);
  }
  return row;
}

/** Appends at most MAX_ROWS rows, with a note when the rest were cut off. */
function appendCapped(container, items, toRow, total) {
  for (const item of items.slice(0, MAX_ROWS)) container.appendChild(toRow(item));
  if (items.length > MAX_ROWS) {
    const note = document.createElement("p");
    note.className = "empty-hint";
    note.textContent = t("dashboard.showingFirst", { shown: MAX_ROWS, total });
    container.appendChild(note);
  }
}

function renderBookmarks(container, payload) {
  const tree = buildDisplayTree(payload.nodes ?? []);
  if (!tree.length) return emptyHint(container, "dashboard.noBookmarksSynced");
  const ul = document.createElement("ul");
  ul.className = "tree-root";
  for (const node of tree) ul.appendChild(renderBookmarkNode(node));
  container.appendChild(ul);
}

function renderHistory(container, payload, query) {
  const entries = [...(payload.entries ?? [])]
    .filter((entry) => !query || `${entry.title} ${entry.url}`.toLowerCase().includes(query))
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  if (!entries.length) return emptyHint(container, query ? "dashboard.noMatches" : "dashboard.nothingSyncedForType");
  appendCapped(
    container,
    entries,
    (entry) =>
      dataRow({
        title: entry.title || entry.url,
        href: entry.url,
        detail: t("dashboard.historyDetail", { date: formatDate(entry.lastVisitTime), count: entry.visitCount }),
      }),
    entries.length,
  );
}

function renderExtensions(container, payload, query) {
  const extensions = [...(payload.extensions ?? [])]
    .filter((ext) => !query || ext.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!extensions.length) return emptyHint(container, query ? "dashboard.noMatches" : "dashboard.nothingSyncedForType");
  for (const ext of extensions) {
    container.appendChild(
      dataRow({
        title: ext.name,
        detail: ext.id,
        badge: { on: ext.enabled, label: ext.enabled ? t("dashboard.enabled") : t("dashboard.disabled") },
      }),
    );
  }
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The icon the extension stored with the entry (a data: URL, encrypted with
 * the rest of it), else the site's first letter. This page never requests
 * icons from the sites or an icon service, which would reveal the vault's
 * sites to them.
 */
function siteIcon(entry) {
  if (typeof entry.favicon === "string" && entry.favicon.startsWith("data:image/")) {
    const img = document.createElement("img");
    img.className = "site-icon";
    img.alt = "";
    img.src = entry.favicon;
    return img;
  }
  const letter = document.createElement("span");
  letter.className = "site-icon site-icon-letter";
  letter.textContent = (hostOf(entry.url).replace(/^www\./, "")[0] ?? "?").toUpperCase();
  return letter;
}

function renderPasswords(container, payload, query) {
  // Deleted entries stay in the blob as tombstones (see the extension's
  // passwordVault.js) - never shown.
  const entries = (payload.entries ?? [])
    .filter((entry) => !entry.deleted)
    .filter((entry) => !query || `${entry.url} ${entry.username} ${entry.notes}`.toLowerCase().includes(query))
    .sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)));
  if (!entries.length) return emptyHint(container, query ? "dashboard.noMatches" : "dashboard.nothingSyncedForType");
  for (const entry of entries) {
    const row = dataRow({ title: hostOf(entry.url), href: /^https?:/.test(entry.url) ? entry.url : null, detail: entry.username || "—" });
    row.prepend(siteIcon(entry));
    const main = row.querySelector(".data-row-main");
    const secret = document.createElement("span");
    secret.className = "data-row-secret";
    secret.textContent = revealedPasswords.has(entry.id) ? entry.password : "••••••••••";
    main.appendChild(secret);

    const actions = document.createElement("div");
    actions.className = "data-row-actions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary-button";
    toggle.textContent = revealedPasswords.has(entry.id) ? t("dashboard.hide") : t("dashboard.show");
    toggle.addEventListener("click", () => {
      if (revealedPasswords.has(entry.id)) revealedPasswords.delete(entry.id);
      else revealedPasswords.add(entry.id);
      renderDataContent();
    });
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary-button";
    copy.textContent = t("common.copy");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(entry.password);
        copy.textContent = t("common.copied");
      } catch {
        copy.textContent = t("dashboard.copyFailed");
      }
      setTimeout(() => (copy.textContent = t("common.copy")), 1500);
    });
    actions.append(toggle, copy);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

document.getElementById("data-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) selectDataTab(tab.dataset.type);
});

document.getElementById("data-filter").addEventListener("input", renderDataContent);

document.getElementById("data-locked").addEventListener("submit", async (e) => {
  e.preventDefault();
  const passphrase = document.getElementById("data-passphrase").value;
  const errorEl = document.getElementById("data-error");
  const btn = document.getElementById("data-unlock-btn");
  errorEl.hidden = true;
  if (!passphrase) {
    errorEl.textContent = t("dashboard.enterRecoveryPassphrase");
    errorEl.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = t("common.unlocking");
  try {
    const { dekEnvelope } = await authFetch("/api/auth/dek-envelope");
    const email = document.getElementById("account-email").textContent;
    const kek = await deriveKekFromPassphrase(passphrase, email);
    try {
      unlockedKey = await unwrapDEK(kek, dekEnvelope);
    } catch {
      throw new Error(t("dashboard.wrongPassphrase"));
    }
    document.getElementById("data-passphrase").value = "";
    document.getElementById("data-locked").hidden = true;
    document.getElementById("data-unlocked").hidden = false;
    await showDataTab();
  } catch (err) {
    showDataError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = t("common.unlock");
  }
});

document.getElementById("data-lock-btn").addEventListener("click", lockData);

// Re-fetches the active tab with the key already in hand - handy after
// syncing from the extension/another device, without re-typing the
// recovery passphrase.
document.getElementById("data-refresh-btn").addEventListener("click", async () => {
  if (!unlockedKey) return;
  const btn = document.getElementById("data-refresh-btn");
  btn.disabled = true;
  try {
    await showDataTab({ force: true });
  } catch (err) {
    showDataError(err);
  } finally {
    btn.disabled = false;
  }
});

// Cleans up "ghost" devices from reinstalling the extension (or logging
// into this dashboard again): nothing in an extension's own storage
// survives a full uninstall, so there's no reliable way to detect "this is
// the same device as before" and update its row instead of creating a new
// one each time - this is the practical alternative, one click instead of
// revoking a pile of them by hand.
const confirmRevokeOthers = armConfirm(document.getElementById("revoke-others-btn"), t("common.confirmClickAgain"));
document.getElementById("revoke-others-btn").addEventListener("click", async () => {
  if (!confirmRevokeOthers()) return;
  const btn = document.getElementById("revoke-others-btn");
  const errorEl = document.getElementById("devices-error");
  btn.disabled = true;
  try {
    await authFetch("/api/auth/devices/revoke-others", { method: "POST", body: { exceptDeviceId: session.deviceId } });
    await loadDevices();
  } catch (err) {
    errorEl.textContent = err.message || t("dashboard.couldNotRevokeOtherDevices");
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// --- Dialogs: the main page only shows summaries; lists open here. ---
const dialogs = {
  data: document.getElementById("data-dialog"),
  devices: document.getElementById("devices-dialog"),
};

for (const dialog of Object.values(dialogs)) {
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  // A click on the backdrop lands on the <dialog> element itself.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/** Opens the viewer with one tab per synced type, starting on the first. */
function openDataDialog() {
  for (const tab of document.querySelectorAll("#data-tabs .tab")) {
    tab.hidden = !syncedTypes.includes(tab.dataset.type);
  }
  selectDataTab(DATA_TYPES.find((type) => syncedTypes.includes(type)) ?? "bookmarks");
  dialogs.data.showModal();
  if (!unlockedKey) document.getElementById("data-passphrase").focus();
}

// Closing the viewer drops the unwrapped key and everything decrypted with
// it: nothing stays in memory once it's off screen.
dialogs.data.addEventListener("close", lockData);

document.getElementById("open-data-btn").addEventListener("click", openDataDialog);

document.getElementById("open-devices-btn").addEventListener("click", () => {
  dialogs.devices.showModal();
  loadDevices();
});

async function loadDashboard() {
  showView(true);
  lockData();
  await Promise.all([loadAccount(), loadStatus(), loadDevices()]);
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  const submitBtn = document.getElementById("login-submit");
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = t("dashboard.loggingIn");
  try {
    const result = await rawRequest("/api/auth/login", {
      method: "POST",
      body: { email, password, deviceLabel: DEVICE_LABEL },
    });
    session = { accessToken: result.accessToken, refreshToken: result.refreshToken, deviceId: result.deviceId };
    saveSession(session);
    await loadDashboard();
  } catch (err) {
    errorEl.textContent = err.message || t("dashboard.couldNotLogIn");
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = t("dashboard.logIn");
  }
});

document.getElementById("logout-btn").addEventListener("click", doLogout);

async function init() {
  if (!session) {
    showView(false);
    return;
  }
  try {
    await loadDashboard();
  } catch {
    // authFetch already tried a refresh; a session that still fails here is
    // dead (revoked/expired) - drop it and fall back to the login form.
    session = null;
    clearSession();
    showView(false);
  }
}

init();
