// Owns account session state: connecting, logging in, logging out, and the
// "change server" flow. This is the only place that should call
// clearAccountLocal() / setEncryptionKeyRaw() so token and key lifecycle
// stay consistent no matter which UI (onboarding tab or popup) calls in.
//
// See crypto.js for the envelope-encryption design this file implements:
// a random DEK is wrapped once under a passphrase-derived key (stored on
// the server, for recovery/new devices) and once under a password-derived
// key (stored ONLY in this device's local storage, for day-to-day unlock).
import * as api from "./api.js";
import {
  deriveKekFromPassphrase,
  deriveKekFromPassword,
  derivePassphraseVerifier,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  exportKeyRaw,
  importKeyRaw,
  generatePassphrase,
} from "./crypto.js";
import {
  getAllLocal,
  setLocal,
  clearAccountLocal,
  getEncryptionKeyRaw,
  setEncryptionKeyRaw,
} from "./storage.js";

export { generatePassphrase };

export class WrongSecretError extends Error {}

async function deviceLabel() {
  // Best-effort human-readable label so a user reviewing "logged in devices"
  // later (or the raw DB, as the admin) can tell devices apart. Never
  // includes anything sensitive.
  const platformInfo = await chrome.runtime.getPlatformInfo();
  // The extension APIs don't expose which specific Chromium-based browser
  // it's running in, so the label is just OS-based.
  return `Browser on ${platformInfo.os}`;
}

/** Current connection state, used by both onboarding.js and popup.js to decide what to render. */
export async function getSession() {
  const {
    serverUrl,
    accountEmail,
    accessToken,
    refreshToken,
    dekEnvelopePasswordCiphertext,
    lastSyncAt,
    lastSyncStatus,
    lastSyncError,
  } = await getAllLocal();
  const encryptionKeyRaw = await getEncryptionKeyRaw();
  return {
    serverUrl,
    accountEmail,
    isLoggedIn: Boolean(accountEmail && accessToken && refreshToken),
    isUnlocked: Boolean(encryptionKeyRaw),
    // False for a brand-new device that hasn't completed one-time passphrase
    // setup yet, or if this device's local envelope got lost/corrupted.
    hasLocalEnvelope: Boolean(dekEnvelopePasswordCiphertext),
    lastSyncAt,
    lastSyncStatus,
    lastSyncError,
  };
}

async function storeDeviceEnvelope(dek, password, email) {
  const kekPassword = await deriveKekFromPassword(password, email);
  const envelope = await wrapDEK(kekPassword, dek);
  await setLocal({ dekEnvelopePasswordCiphertext: envelope.ciphertext, dekEnvelopePasswordIv: envelope.iv });
}

async function activateDEK(dek) {
  await setEncryptionKeyRaw(await exportKeyRaw(dek));
}

/**
 * Creates a brand-new account: generates the recovery passphrase and the
 * random DEK, wraps the DEK for both the server (passphrase envelope) and
 * this device (password envelope, stored locally only). Returns the
 * generated passphrase so the caller can show it to the user exactly once.
 */
export async function register({ serverUrl, email, password }) {
  const passphrase = generatePassphrase();
  const dek = await generateDEK();

  const kekPassphrase = await deriveKekFromPassphrase(passphrase, email);
  const dekEnvelope = await wrapDEK(kekPassphrase, dek);
  const passphraseVerifier = await derivePassphraseVerifier(passphrase, email);

  const tokens = await api.register(serverUrl, {
    email,
    password,
    passphraseVerifier,
    dekEnvelope,
    deviceLabel: await deviceLabel(),
  });

  await setLocal({
    serverUrl,
    accountEmail: email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    currentDeviceId: tokens.deviceId,
  });
  await storeDeviceEnvelope(dek, password, email);
  await activateDEK(dek);

  return { passphrase };
}

/**
 * Logs in with email+password. If this device already has a local
 * password-wrapped DEK envelope from a previous setup, unlocking is
 * immediate. Otherwise the caller must follow up with completeDeviceSetup()
 * using the passphrase - `needsPassphrase` and the server's `dekEnvelope`
 * (needed for that step) are returned so the UI knows to prompt for it.
 */
export async function login({ serverUrl, email, password }) {
  const result = await api.login(serverUrl, { email, password, deviceLabel: await deviceLabel() });
  await setLocal({
    serverUrl,
    accountEmail: email,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    currentDeviceId: result.deviceId,
  });

  const { dekEnvelopePasswordCiphertext, dekEnvelopePasswordIv } = await getAllLocal();
  if (dekEnvelopePasswordCiphertext) {
    try {
      const kekPassword = await deriveKekFromPassword(password, email);
      const dek = await unwrapDEK(kekPassword, { ciphertext: dekEnvelopePasswordCiphertext, iv: dekEnvelopePasswordIv });
      await activateDEK(dek);
      return { needsPassphrase: false };
    } catch {
      // Local envelope exists but doesn't unwrap with this password (e.g. the
      // password was changed via reset-password on another device since).
      // Fall through to the one-time passphrase bootstrap below.
    }
  }
  return { needsPassphrase: true, dekEnvelope: result.dekEnvelope };
}

/**
 * One-time-per-device bootstrap: unwraps the server's passphrase envelope to
 * recover the DEK, then creates and stores THIS device's own password
 * envelope so future logins/unlocks on this device never need the
 * passphrase again. Used both right after login() (dekEnvelope from its
 * response) and to repair a device whose local envelope was lost
 * (dekEnvelope re-fetched via api.getDekEnvelope()).
 */
export async function completeDeviceSetup({ email, password, passphrase, dekEnvelope }) {
  const kekPassphrase = await deriveKekFromPassphrase(passphrase, email);
  let dek;
  try {
    dek = await unwrapDEK(kekPassphrase, dekEnvelope);
  } catch {
    throw new WrongSecretError("That recovery passphrase doesn't match this account.");
  }
  await storeDeviceEnvelope(dek, password, email);
  await activateDEK(dek);
}

/**
 * Re-derives the DEK from the password after the session-only key storage
 * was cleared (typically: the whole browser restarted). Unwraps THIS
 * device's local password envelope - no network round trip needed.
 */
export async function unlock(password) {
  const { accountEmail, dekEnvelopePasswordCiphertext, dekEnvelopePasswordIv } = await getAllLocal();
  if (!accountEmail) throw new Error("No account connected.");
  if (!dekEnvelopePasswordCiphertext) {
    throw Object.assign(new Error("This device hasn't been set up yet."), { code: "no_local_envelope" });
  }
  const kekPassword = await deriveKekFromPassword(password, accountEmail);
  let dek;
  try {
    dek = await unwrapDEK(kekPassword, { ciphertext: dekEnvelopePasswordCiphertext, iv: dekEnvelopePasswordIv });
  } catch {
    throw new WrongSecretError("Wrong password.");
  }
  await activateDEK(dek);
}

export async function getActiveKey() {
  const rawKey = await getEncryptionKeyRaw();
  if (!rawKey) return null;
  return importKeyRaw(rawKey);
}

/**
 * Proves passphrase ownership to the server to set a new password, then
 * logs in with it and re-bootstraps this device - all in one step, since
 * the passphrase the user just typed is already in hand.
 */
export async function resetPassword({ serverUrl, email, passphrase, newPassword }) {
  const passphraseVerifier = await derivePassphraseVerifier(passphrase, email);
  await api.resetPassword(serverUrl, { email, passphraseVerifier, newPassword });

  const result = await api.login(serverUrl, { email, password: newPassword, deviceLabel: await deviceLabel() });
  await setLocal({
    serverUrl,
    accountEmail: email,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    currentDeviceId: result.deviceId,
  });
  await completeDeviceSetup({ email, password: newPassword, passphrase, dekEnvelope: result.dekEnvelope });
}

/** Logs out of the current server/account only. Other devices/logins are untouched. */
export async function logout() {
  const { serverUrl, refreshToken } = await getAllLocal();
  if (refreshToken) {
    // Best-effort: if the server is unreachable we still want to clear
    // local state so the user isn't stuck "logged in" to a dead server.
    await api.logout(serverUrl, refreshToken).catch(() => {});
  }
  await clearAccountLocal();
}

/**
 * Switching to a different server must never let a token meant for server A
 * reach server B. We clear all local session state FIRST (best-effort
 * logout against the old server, then wipe tokens/key/envelope), and only
 * then write the new URL - so there's no window where stale credentials and
 * a new URL coexist in storage.
 */
export async function switchServer(newServerUrl) {
  const { accountEmail } = await getAllLocal();
  if (accountEmail) {
    await logout();
  }
  await setLocal({ serverUrl: newServerUrl });
}

export async function deleteAccount(password) {
  const { serverUrl, accessToken } = await getAllLocal();
  await api.deleteAccount(serverUrl, { accessToken, password });
  await clearAccountLocal();
}
