// Thin wrapper around chrome.storage so the rest of the extension never
// touches the raw APIs directly. Two storage areas are used deliberately:
//
// - chrome.storage.local: persisted to disk, survives browser restarts.
//   Holds everything EXCEPT the actual data encryption key (DEK): server
//   URL, account email, access/refresh tokens, sync bookkeeping (syncIds,
//   tombstones, last sync result), settings, and this DEVICE's own
//   password-wrapped copy of the DEK (dekEnvelopePassword*). This is per
//   Chromium PROFILE, not shared between browser profiles (even across
//   different Chromium-based browsers) - exactly what lets "personal" and
//   "work" profiles point at different servers/accounts independently, and
//   what keeps each device's password-wrapped envelope from ever being
//   confused with another device's.
//
// - chrome.storage.session: memory-only, cleared on browser restart, NEVER
//   written to disk. Holds the actual DEK (as raw bytes) so automatic
//   background sync keeps working across the many times a Manifest V3
//   service worker gets spun down and restarted while the browser stays
//   open, WITHOUT ever persisting the real key to disk. The trade-off:
//   after a full browser restart, the popup will ask the user to re-enter
//   their PASSWORD once to "unlock" sync again (unwrapping the locally
//   stored dekEnvelopePassword) - see auth.js.
import { OFFICIAL_SERVER_URL, DEFAULT_HISTORY_DAYS, DEFAULT_SYNC_INTERVAL_MINUTES } from "../config.js";

const LOCAL_DEFAULTS = {
  serverUrl: OFFICIAL_SERVER_URL,
  accountEmail: null,
  accessToken: null,
  refreshToken: null,
  historyDays: DEFAULT_HISTORY_DAYS,
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
  historyEnabled: false,
  // This device's own copy of the DEK, wrapped under a password-derived key.
  // Never sent to the server - see the module comment above.
  dekEnvelopePasswordCiphertext: null,
  dekEnvelopePasswordIv: null,
  lastSyncAt: null,
  lastSyncStatus: null, // "ok" | "error" | null
  lastSyncError: null,
  // Local-only bookkeeping for the bookmark merge engine (never uploaded as-is).
  bookmarkSyncIds: {}, // chromeNodeId -> syncId
  bookmarkTimestamps: {}, // syncId -> ms epoch of last local modification
  bookmarkTombstones: {}, // syncId -> ms epoch of local deletion
  bookmarkBlobVersion: 0, // last server "version" this device successfully wrote/read
  historyBlobVersion: 0,
  extensionsBlobVersion: 0,
};

export async function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

export async function setLocal(values) {
  return chrome.storage.local.set(values);
}

export async function getAllLocal() {
  const stored = await chrome.storage.local.get(Object.keys(LOCAL_DEFAULTS));
  return { ...LOCAL_DEFAULTS, ...stored };
}

export async function clearAccountLocal() {
  // Used on logout / server switch: clears account + tokens + sync
  // bookkeeping, but deliberately leaves serverUrl alone (caller sets it
  // explicitly) and leaves user preferences like syncIntervalMinutes intact.
  await chrome.storage.local.remove([
    "accountEmail",
    "accessToken",
    "refreshToken",
    "dekEnvelopePasswordCiphertext",
    "dekEnvelopePasswordIv",
    "lastSyncAt",
    "lastSyncStatus",
    "lastSyncError",
    "bookmarkSyncIds",
    "bookmarkTimestamps",
    "bookmarkTombstones",
    "bookmarkBlobVersion",
    "historyBlobVersion",
    "extensionsBlobVersion",
  ]);
  await clearEncryptionKey();
}

export async function getEncryptionKeyRaw() {
  const { encryptionKeyRaw } = await chrome.storage.session.get("encryptionKeyRaw");
  return encryptionKeyRaw ?? null;
}

export async function setEncryptionKeyRaw(base64Key) {
  await chrome.storage.session.set({ encryptionKeyRaw: base64Key });
}

export async function clearEncryptionKey() {
  await chrome.storage.session.remove("encryptionKeyRaw");
}
