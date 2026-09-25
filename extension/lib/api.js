// Thin fetch wrapper around the BrowserSync REST API. Knows nothing about
// encryption - it only ever sees the opaque ciphertext/iv strings that
// crypto.js produces, which is exactly what should cross the network.
import { getAllLocal, setLocal, clearAccountLocal } from "./storage.js";
import { API_VERSION, SERVICE_ID } from "../config.js";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed with status ${status}`);
    this.status = status;
    this.code = body?.error;
    this.body = body;
  }
}

/** Thrown when the server URL is unreachable, times out, or isn't BrowserSync at all. */
export class NetworkError extends Error {}

async function request(serverUrl, path, { method = "GET", body, accessToken, signal } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, serverUrl), {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    throw new NetworkError(`Could not reach ${serverUrl}: ${err.message}`);
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON response (e.g. a proxy error page) - treat as a network-level problem.
    // `status` lets callers tell an old server that simply lacks a route
    // (a plain-HTML 404) apart from one that's actually unreachable - see
    // passwordVault.js.
    if (!response.ok) {
      throw Object.assign(new NetworkError(`Server returned ${response.status} with an unexpected response.`), {
        status: response.status,
      });
    }
  }

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

/**
 * Checks that `serverUrl` is a reachable, healthy BrowserSync server this
 * extension can talk to. Resolves to { ok: true, version } or
 * { ok: false, reason, version? }, where reason is one of:
 *  - "unreachable": no response, timeout, or a non-JSON reply
 *  - "not_browsersync": answered, but isn't a BrowserSync server
 *  - "server_outdated": a BrowserSync server too old for this extension
 *    (including pre-1.4 servers, whose /api/health had no service/version)
 *  - "extension_outdated": the server no longer supports this extension
 *  - "unhealthy": a BrowserSync server that reports a problem (e.g. its
 *    database is down)
 */
export async function checkHealth(serverUrl, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let body;
  try {
    body = await request(serverUrl, "/api/health", { signal: controller.signal });
  } catch (err) {
    // A 503 from a BrowserSync server still carries its identity.
    if (!(err instanceof ApiError)) return { ok: false, reason: "unreachable" };
    body = err.body;
  } finally {
    clearTimeout(timeout);
  }

  if (body?.service !== SERVICE_ID) {
    // Servers before 1.4 answered just {"status":"ok"}.
    const legacy = body && typeof body === "object" && body.status === "ok" && Object.keys(body).length === 1;
    return { ok: false, reason: legacy ? "server_outdated" : "not_browsersync" };
  }
  const version = typeof body.version === "string" ? body.version : undefined;
  if (!Number.isInteger(body.apiVersion) || body.apiVersion < API_VERSION) {
    return { ok: false, reason: "server_outdated", version };
  }
  if (Number.isInteger(body.minApiVersion) && body.minApiVersion > API_VERSION) {
    return { ok: false, reason: "extension_outdated", version };
  }
  if (body.status !== "ok") return { ok: false, reason: "unhealthy", version };
  return { ok: true, version };
}

export function register(serverUrl, { email, password, passphraseVerifier, dekEnvelope, deviceLabel }) {
  return request(serverUrl, "/api/auth/register", {
    method: "POST",
    body: { email, password, passphraseVerifier, dekEnvelope, deviceLabel },
  });
}

export function login(serverUrl, { email, password, deviceLabel }) {
  return request(serverUrl, "/api/auth/login", { method: "POST", body: { email, password, deviceLabel } });
}

export function logout(serverUrl, refreshToken) {
  return request(serverUrl, "/api/auth/logout", { method: "POST", body: { refreshToken } });
}

export function deleteAccount(serverUrl, { accessToken, password }) {
  return request(serverUrl, "/api/auth/account", { method: "DELETE", accessToken, body: { password } });
}

export function resetPassword(serverUrl, { email, passphraseVerifier, newPassword }) {
  return request(serverUrl, "/api/auth/reset-password", {
    method: "POST",
    body: { email, passphraseVerifier, newPassword },
  });
}

/** Fetches the account's server-stored (passphrase-wrapped) DEK envelope on demand. */
export async function getDekEnvelope() {
  const { serverUrl } = await getAllLocal();
  return withAuthRetry((accessToken) => request(serverUrl, "/api/auth/dek-envelope", { accessToken }));
}

/** Lists every device (non-revoked, non-expired login) currently linked to this account. */
export async function listDevices() {
  const { serverUrl } = await getAllLocal();
  const { devices } = await withAuthRetry((accessToken) => request(serverUrl, "/api/auth/devices", { accessToken }));
  return devices;
}

/** Revokes one linked device by id, signing it out next time it tries to refresh its session. */
export async function revokeDevice(deviceId) {
  const { serverUrl } = await getAllLocal();
  await withAuthRetry((accessToken) =>
    request(serverUrl, `/api/auth/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", accessToken }),
  );
}

/**
 * Revokes every OTHER linked device in one request - the practical answer
 * to "ghost" devices piling up from reinstalling the extension: nothing in
 * an extension's own storage survives a full uninstall, so there's no
 * reliable way to detect "this is the same device as before" and update
 * its row instead of creating a new one each time.
 */
export async function revokeOtherDevices(exceptDeviceId) {
  const { serverUrl } = await getAllLocal();
  const { revokedCount } = await withAuthRetry((accessToken) =>
    request(serverUrl, "/api/auth/devices/revoke-others", { method: "POST", accessToken, body: { exceptDeviceId } }),
  );
  return revokedCount;
}

/**
 * Wraps an authenticated call with a single automatic retry after a token
 * refresh, so callers (bookmarksSync, historySync) don't each need to
 * reimplement "refresh once, then retry" logic.
 */
async function withAuthRetry(fn) {
  const { serverUrl, accessToken, refreshToken } = await getAllLocal();
  try {
    return await fn(accessToken);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && refreshToken) {
      let newAccessToken;
      try {
        ({ accessToken: newAccessToken } = await request(serverUrl, "/api/auth/refresh", {
          method: "POST",
          body: { refreshToken },
        }));
      } catch (refreshErr) {
        if (refreshErr instanceof ApiError && refreshErr.status === 401) {
          // The refresh token itself is dead, not just this access token -
          // this device was signed out remotely (revoked from the account
          // dashboard or devices.html, or it simply expired). There's no
          // path back from this without a fresh login, so drop this
          // device's local session now: without this, isLoggedIn stayed
          // "true" locally forever (nothing ever clears accountEmail/
          // accessToken/refreshToken on its own), so every sync attempt -
          // scheduled or manual - kept failing the same way with only a red
          // "Session expired" line to show for it, and the popup never fell
          // back to the login screen on its own. Clearing it here means the
          // very next time the popup opens, render() sees isLoggedIn:false
          // and shows the login form instead.
          await clearAccountLocal();
        }
        throw refreshErr;
      }
      await setLocal({ accessToken: newAccessToken });
      return fn(newAccessToken);
    }
    throw err;
  }
}

export async function getSyncBlob(dataType) {
  const { serverUrl } = await getAllLocal();
  try {
    return await withAuthRetry((accessToken) =>
      request(serverUrl, `/api/sync/${dataType}`, { accessToken }),
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function putSyncBlob(dataType, { ciphertext, iv, clientUpdatedAt, expectedVersion }) {
  const { serverUrl } = await getAllLocal();
  return withAuthRetry((accessToken) =>
    request(serverUrl, `/api/sync/${dataType}`, {
      method: "POST",
      accessToken,
      body: { ciphertext, iv, clientUpdatedAt, expectedVersion },
    }),
  ).catch((err) => {
    // Surface a 409's "current" server state to the caller so it can merge
    // and retry - this is not an error the sync engine treats as fatal.
    if (err instanceof ApiError && err.status === 409) return { conflict: err.body.current };
    throw err;
  });
}
