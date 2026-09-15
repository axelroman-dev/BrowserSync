// Vanilla JS, no build step - deliberately matches the extension's own
// no-framework style. Talks to the same-origin /api/auth and /api/sync
// endpoints this server already exposes to the extension; this page is just
// another client of that API, not a special back-channel.
const STORAGE_KEY = "browsersync_dashboard_session";
const DEVICE_LABEL = "Account dashboard";

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
  if (!session) throw new ApiError(401, { message: "Not logged in." });
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
  return iso ? new Date(iso).toLocaleString() : "never";
}

const DATA_TYPE_LABELS = { bookmarks: "Bookmarks", history: "History", extensions: "Extensions" };

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
      title.appendChild(document.createTextNode(DATA_TYPE_LABELS[blob.dataType] ?? blob.dataType));
      main.appendChild(title);

      const detail = document.createElement("span");
      detail.className = "status-row-detail";
      detail.textContent = blob.version
        ? `Version ${blob.version} · ${formatBytes(blob.sizeBytes)} · saved ${formatDate(blob.updatedAt)}`
        : "Never synced from any device";
      main.appendChild(detail);

      row.appendChild(main);
      container.appendChild(row);
    }
  } catch (err) {
    errorEl.textContent = err.message || "Could not load sync status.";
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

async function loadDevices() {
  const errorEl = document.getElementById("devices-error");
  const container = document.getElementById("devices-list");
  errorEl.hidden = true;
  container.textContent = "";
  try {
    const { devices } = await authFetch("/api/auth/devices");
    if (!devices.length) {
      const empty = document.createElement("p");
      empty.className = "empty-hint";
      empty.textContent = "No devices linked.";
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
      title.textContent = device.deviceLabel || "Unnamed device";
      if (device.id === session.deviceId) {
        const badge = document.createElement("span");
        badge.className = "this-device-badge";
        badge.textContent = "this session";
        title.appendChild(badge);
      }
      main.appendChild(title);

      const detail = document.createElement("span");
      detail.className = "device-row-detail";
      detail.textContent = `Linked ${formatDate(device.createdAt)} · last used ${formatDate(device.lastUsedAt)}`;
      main.appendChild(detail);

      row.appendChild(main);

      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.className = "danger-button";
      revokeBtn.textContent = "Revoke";
      const confirmRevoke = armConfirm(revokeBtn, "Click again to confirm");
      revokeBtn.addEventListener("click", async () => {
        if (!confirmRevoke()) return;
        revokeBtn.disabled = true;
        try {
          await authFetch(`/api/auth/devices/${device.id}`, { method: "DELETE" });
          await loadDevices();
        } catch (err) {
          errorEl.textContent = err.message || "Could not revoke device.";
          errorEl.hidden = false;
          revokeBtn.disabled = false;
        }
      });
      row.appendChild(revokeBtn);

      container.appendChild(row);
    }
  } catch (err) {
    errorEl.textContent = err.message || "Could not load devices.";
    errorEl.hidden = false;
  }
}

async function loadDashboard() {
  showView(true);
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
  submitBtn.textContent = "Logging in...";
  try {
    const result = await rawRequest("/api/auth/login", {
      method: "POST",
      body: { email, password, deviceLabel: DEVICE_LABEL },
    });
    session = { accessToken: result.accessToken, refreshToken: result.refreshToken, deviceId: result.deviceId };
    saveSession(session);
    await loadDashboard();
  } catch (err) {
    errorEl.textContent = err.message || "Could not log in.";
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Log in";
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  if (session) {
    await rawRequest("/api/auth/logout", { method: "POST", body: { refreshToken: session.refreshToken } }).catch(() => {
      // Best-effort - the token gets cleared locally either way.
    });
  }
  session = null;
  clearSession();
  document.getElementById("login-form").reset();
  showView(false);
});

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
