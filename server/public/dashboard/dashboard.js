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
  };
}

async function loadAccount() {
  const account = await authFetch("/api/auth/me");
  document.getElementById("account-email").textContent = account.email;
  document.getElementById("account-email-detail").textContent = account.email;
  document.getElementById("account-created").textContent = formatDate(account.createdAt);
}

async function loadStatus() {
  const errorEl = document.getElementById("status-error");
  const container = document.getElementById("status-list");
  errorEl.hidden = true;
  container.textContent = "";
  try {
    const { blobs } = await authFetch("/api/sync/status");
    for (const blob of blobs) {
      const row = document.createElement("div");
      row.className = "status-row";

      const main = document.createElement("div");
      main.className = "status-row-main";

      const title = document.createElement("span");
      title.className = "status-row-title";
      const dot = document.createElement("span");
      dot.className = "dot " + (blob.version ? "dot-ok" : "dot-empty");
      title.appendChild(dot);
      title.appendChild(document.createTextNode(dataTypeLabels()[blob.dataType] ?? blob.dataType));
      main.appendChild(title);

      const detail = document.createElement("span");
      detail.className = "status-row-detail";
      detail.textContent = blob.version
        ? t("dashboard.versionDetail", { version: blob.version, size: formatBytes(blob.sizeBytes), date: formatDate(blob.updatedAt) })
        : t("dashboard.neverSyncedFromDevice");
      main.appendChild(detail);

      row.appendChild(main);
      container.appendChild(row);
    }
  } catch (err) {
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
  lockBookmarks();
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
    errorEl.textContent = err.message || t("dashboard.couldNotLoadDevices");
    errorEl.hidden = false;
  }
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

function lockBookmarks() {
  unlockedKey = null;
  document.getElementById("bookmarks-passphrase").value = "";
  document.getElementById("bookmarks-error").hidden = true;
  document.getElementById("bookmarks-locked").hidden = false;
  document.getElementById("bookmarks-unlocked").hidden = true;
}

/** Fetches the current bookmarks blob and renders it with an already-unwrapped key. */
async function renderBookmarksTree(key) {
  const blob = await authFetch("/api/sync/bookmarks");
  const container = document.getElementById("bookmarks-tree");
  container.textContent = "";
  if (!blob) {
    document.getElementById("bookmarks-meta").textContent = t("dashboard.noBookmarksSynced");
    return;
  }
  const payload = await decryptJSON(key, blob.ciphertext, blob.iv);
  const tree = buildDisplayTree(payload.nodes ?? []);
  document.getElementById("bookmarks-meta").textContent = t("dashboard.lastSynced", { date: formatDate(blob.updatedAt) });
  if (!tree.length) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = t("dashboard.noBookmarksSynced");
    container.appendChild(empty);
  } else {
    const ul = document.createElement("ul");
    ul.className = "tree-root";
    for (const node of tree) ul.appendChild(renderBookmarkNode(node));
    container.appendChild(ul);
  }
}

document.getElementById("bookmarks-unlock-btn").addEventListener("click", async () => {
  const passphrase = document.getElementById("bookmarks-passphrase").value;
  const errorEl = document.getElementById("bookmarks-error");
  const btn = document.getElementById("bookmarks-unlock-btn");
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
    let key;
    try {
      key = await unwrapDEK(kek, dekEnvelope);
    } catch {
      throw new Error(t("dashboard.wrongPassphrase"));
    }
    await renderBookmarksTree(key);
    unlockedKey = key;
    document.getElementById("bookmarks-locked").hidden = true;
    document.getElementById("bookmarks-unlocked").hidden = false;
  } catch (err) {
    errorEl.textContent = err.message || t("dashboard.couldNotDecryptBookmarks");
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t("common.unlock");
  }
});

document.getElementById("bookmarks-lock-btn").addEventListener("click", lockBookmarks);

// Re-fetches and re-renders with the already-unwrapped key from this
// unlock - handy after syncing from the extension/another device, without
// having to re-type the recovery passphrase just to see the new state.
document.getElementById("bookmarks-refresh-btn").addEventListener("click", async () => {
  if (!unlockedKey) return;
  const btn = document.getElementById("bookmarks-refresh-btn");
  btn.disabled = true;
  try {
    await renderBookmarksTree(unlockedKey);
  } catch (err) {
    document.getElementById("bookmarks-error").textContent = err.message || t("dashboard.couldNotRefreshBookmarks");
    document.getElementById("bookmarks-error").hidden = false;
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

async function loadDashboard() {
  showView(true);
  lockBookmarks();
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
