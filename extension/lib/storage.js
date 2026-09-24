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
  // This device's own row id in the server's refresh_tokens table (returned
  // by register/login), so the "linked devices" list can mark which entry is
  // "this device" - see lib/devicesList.js.
  currentDeviceId: null,
  bookmarksInitializedAt: null,
  // "<serverUrl>::<accountEmail>" of whichever account this device's
  // bookmarkSyncIds/bookmarkTimestamps/bookmarkTombstones bookkeeping was
  // built for (server URL is part of the identity since the same email can
  // be a different, unrelated account on a different self-hosted server).
  // Deliberately NOT cleared on logout (see clearAccountLocal below) so
  // that logging back into the SAME account resumes syncing without
  // re-asking the merge/replace question or losing the syncId mapping -
  // losing it would make every already-synced local bookmark look "new"
  // again and get duplicated on the next merge. Compared against the
  // current serverUrl+accountEmail by firstSyncPrompt.js to detect a
  // genuinely different account signing in on this device, which still
  // needs the bookkeeping reset.
  lastSyncedAccountKey: null,
  historyDays: DEFAULT_HISTORY_DAYS,
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
  historyEnabled: true,
  // UI language: "auto" (follow chrome.i18n.getUILanguage()) or a specific
  // supported code ("en", "es") — see lib/i18n.js.
  language: "auto",
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
  // Saved-password vault (see passwordVault.js): {ciphertext, iv} encrypted
  // with the DEK, so it's unreadable on disk while the extension is locked.
  // Kept locally (unlike bookmarks/history there's no Chromium store behind
  // it) so the vault page works offline and edits survive a failed sync.
  passwordVault: null,
  passwordsBlobVersion: 0,
  // True while the vault holds local edits the server hasn't accepted yet -
  // popup.js warns before a logout that would throw them away.
  passwordsPendingSync: false,
  passwordsSyncError: null,
  // Set when the "Set up BrowserSync" step (lib/setupForm.js) is finished,
  // in onboarding or the popup. Until then the popup shows that step instead
  // of the status view. Device preference, so it survives logout.
  setupCompletedAt: null,
  // How saved passwords match page URLs when an entry doesn't pick its own
  // mode - see lib/urlMatch.js.
  passwordMatchDefault: "domain",
  // Hostnames where the save prompt is never shown - see neverSave.js.
  // Device preference, so it survives logout.
  passwordNeverSave: [],
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
  //
  // Deliberately does NOT clear bookmarkSyncIds/bookmarkTimestamps/
  // bookmarkTombstones/bookmarksInitializedAt/bookmarkBlobVersion - that
  // bookkeeping only correlates this device's own bookmark nodes with our
  // syncIds, holds nothing sensitive, and logging back into the SAME
  // account (the common case: logout then login again) needs it intact to
  // resume syncing normally. Wiping it here used to make every re-login
  // look like a brand-new device to firstSyncPrompt.js, re-asking the
  // merge/replace question and - if "merge" was picked - re-uploading every
  // already-synced local bookmark under a fresh syncId, duplicating the
  // whole set. firstSyncPrompt.js's needsFirstSyncChoice() instead detects
  // a genuinely different account signing in (via lastSyncedAccountKey)
  // and resets this bookkeeping only then.
  await chrome.storage.local.remove([
    "accountEmail",
    "accessToken",
    "refreshToken",
    "currentDeviceId",
    "dekEnvelopePasswordCiphertext",
    "dekEnvelopePasswordIv",
    "lastSyncAt",
    "lastSyncStatus",
    "lastSyncError",
    "historyBlobVersion",
    "extensionsBlobVersion",
    // Unlike bookmark bookkeeping, the vault is encrypted with THIS account's
    // DEK and would be undecryptable (and must never be uploaded) under a
    // different account - the server copy is what a later login restores.
    "passwordVault",
    "passwordsBlobVersion",
    "passwordsPendingSync",
    "passwordsSyncError",
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
