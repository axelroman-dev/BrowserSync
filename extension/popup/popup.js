import { wireConnectForm } from "../lib/connectForm.js";
import * as auth from "../lib/auth.js";
import * as api from "../lib/api.js";
import { getAllLocal } from "../lib/storage.js";
import { armConfirm } from "../lib/uiConfirm.js";
import { needsFirstSyncChoice } from "../lib/firstSyncPrompt.js";
import { wireSetupForm, renderSetupForm, isSetupComplete } from "../lib/setupForm.js";
import { initI18n, t } from "../lib/i18n.js";

// Resolves the language and translates every data-i18n* element already in
// the popup's DOM before anything below runs - top-level await pauses the
// rest of this module until it's done, so nothing here can read a stale
// English string from t() or flash untranslated text.
await initI18n();

// True right after a sync reports it's blocked on the merge/replace choice.
// render() normally asks that question itself before any sync runs; this
// covers the rare race where the check only comes up during the sync (e.g.
// bookmarks appeared on the server in between). syncNowInteractive() then
// switches to the question directly, and renderStatusView() keeps a hint as
// a fallback.
let firstSyncChoicePending = false;

// Runs a sync cycle via the background service worker instead of importing
// syncOrchestrator directly - unlike this popup document, the service
// worker isn't torn down when the popup closes (which happens easily: any
// click outside it), so a sync kicked off from a button click keeps running
// to completion instead of silently getting cut off partway through.
async function syncNowInteractive() {
  const result = await chrome.runtime.sendMessage({ type: "run-sync" });
  firstSyncChoicePending = result?.status === "skipped" && result?.reason === "needs_first_sync_choice";
  if (firstSyncChoicePending) showFirstSyncChoice();
  return result;
}

const views = {
  connect: document.getElementById("connect-view"),
  unlock: document.getElementById("unlock-view"),
  repair: document.getElementById("repair-view"),
  setup: document.getElementById("setup-view"),
  status: document.getElementById("status-view"),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  document.getElementById("settings-toggle").hidden = name !== "status";
}

function formatRelativeTime(ms) {
  if (!ms) return t("common.neverSynced");
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return t("popup.lastSyncJustNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("popup.lastSyncMinutes", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("popup.lastSyncHours", { hours });
  const days = Math.round(hours / 24);
  return t("popup.lastSyncDays", { days });
}

async function renderStatusView() {
  const session = await auth.getSession();
  document.getElementById("status-server").textContent = new URL(session.serverUrl).host;
  document.getElementById("status-account").textContent = session.accountEmail;

  const indicator = document.getElementById("sync-indicator");
  const text = document.getElementById("sync-text");
  const errorEl = document.getElementById("sync-error");

  indicator.className = "dot " + (session.lastSyncStatus === "error" ? "dot-error" : "dot-ok");
  text.textContent = formatRelativeTime(session.lastSyncAt);
  if (session.lastSyncStatus === "error" && session.lastSyncError) {
    errorEl.textContent = session.lastSyncError;
    errorEl.hidden = false;
  } else if (firstSyncChoicePending) {
    errorEl.textContent = t("popup.firstSyncChoicePending");
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }
}

// Only syncs once render() actually lands on the status view: while the
// bookmarks merge/replace question or the setup step is still showing, the
// sync would either be skipped or run before the user picked their
// settings (e.g. upload history they're about to turn off).
async function renderThenSync() {
  await render();
  if (!views.status.hidden) syncNowInteractive().then(renderStatusView);
}

/** Shows the bookmarks merge/replace question that lives in the connect view (wired by connectForm.js). */
function showFirstSyncChoice() {
  showView("connect");
  for (const id of ["connect-form", "save-passphrase-view", "device-setup-view", "forgot-password-view", "first-sync-error"]) {
    document.getElementById(id).hidden = true;
  }
  document.getElementById("first-sync-choice-view").hidden = false;
}

async function render() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) {
    showView("connect");
    // The connect view may still show a sub-step from an earlier visit
    // (e.g. the merge/replace question before a logout) - start at the form.
    document.getElementById("connect-form").hidden = false;
    for (const id of ["save-passphrase-view", "device-setup-view", "forgot-password-view", "first-sync-choice-view"]) {
      document.getElementById(id).hidden = true;
    }
    return;
  }
  if (!session.isUnlocked) {
    document.getElementById("unlock-email").textContent = session.accountEmail;
    showView(session.hasLocalEnvelope ? "unlock" : "repair");
    return;
  }
  // Setup left unfinished (typically: the onboarding tab was closed early)
  // is picked up here instead of leaving the user on a status view that
  // can only say "something's pending".
  if (await needsFirstSyncChoice().catch(() => false)) {
    showFirstSyncChoice();
    return;
  }
  if (!(await isSetupComplete())) {
    showView("setup");
    await renderSetupForm();
    return;
  }
  showView("status");
  await renderStatusView();
}

wireSetupForm(renderThenSync);

// --- Connect view wiring (shared with onboarding.js) ---
wireConnectForm(
  {
    form: document.getElementById("connect-form"),
    formTitle: document.getElementById("connect-title"),
    emailInput: document.getElementById("email"),
    passwordInput: document.getElementById("password"),
    submitBtn: document.getElementById("submit-btn"),
    modeSwitchLink: document.getElementById("mode-switch-link"),
    forgotPasswordLink: document.getElementById("forgot-password-link"),
    errorMessage: document.getElementById("error-message"),

    serverToggleLink: document.getElementById("server-toggle-link"),
    serverRequiredHint: document.getElementById("server-required-hint"),
    serverSection: document.getElementById("server-section"),
    serverUrlInput: document.getElementById("server-url"),
    testConnectionBtn: document.getElementById("test-connection"),
    testStatus: document.getElementById("test-status"),

    savePassphraseView: document.getElementById("save-passphrase-view"),
    generatedPassphraseDisplay: document.getElementById("generated-passphrase"),
    copyPassphraseBtn: document.getElementById("copy-passphrase"),
    savedConfirmCheckbox: document.getElementById("saved-confirm-checkbox"),
    continueAfterSaveBtn: document.getElementById("continue-after-save-btn"),

    deviceSetupView: document.getElementById("device-setup-view"),
    deviceSetupPassphraseInput: document.getElementById("device-setup-passphrase"),
    deviceSetupError: document.getElementById("device-setup-error"),
    deviceSetupSubmitBtn: document.getElementById("device-setup-submit-btn"),

    firstSyncChoiceView: document.getElementById("first-sync-choice-view"),
    firstSyncMergeBtn: document.getElementById("first-sync-merge-btn"),
    firstSyncReplaceBtn: document.getElementById("first-sync-replace-btn"),
    firstSyncKeepLocalBtn: document.getElementById("first-sync-keep-local-btn"),
    firstSyncError: document.getElementById("first-sync-error"),

    forgotPasswordView: document.getElementById("forgot-password-view"),
    forgotEmailInput: document.getElementById("forgot-email"),
    forgotPassphraseInput: document.getElementById("forgot-passphrase"),
    forgotNewPasswordInput: document.getElementById("forgot-new-password"),
    forgotError: document.getElementById("forgot-error"),
    forgotSubmitBtn: document.getElementById("forgot-submit-btn"),
    forgotCancelLink: document.getElementById("forgot-cancel-link"),
  },
  async () => {
    await chrome.runtime.sendMessage({ type: "refresh-alarm" });
    await renderThenSync();
  },
);

// --- Unlock view wiring (password unlocks this device's local key envelope) ---
document.getElementById("unlock-btn").addEventListener("click", async () => {
  const password = document.getElementById("unlock-password").value;
  const errorEl = document.getElementById("unlock-error");
  if (!password) {
    errorEl.textContent = t("common.enterPassword");
    errorEl.hidden = false;
    return;
  }
  try {
    await auth.unlock(password);
    errorEl.hidden = true;
    await renderThenSync();
  } catch (err) {
    if (err.code === "no_local_envelope") {
      showView("repair");
      return;
    }
    errorEl.textContent = err.message || t("common.couldNotUnlock");
    errorEl.hidden = false;
  }
});

document.getElementById("unlock-repair-link").addEventListener("click", (e) => {
  e.preventDefault();
  showView("repair");
});

const unlockLogoutLink = document.getElementById("unlock-switch-account-link");
const confirmUnlockLogout = armConfirm(unlockLogoutLink, t("popup.confirmLogout"));
unlockLogoutLink.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirmUnlockLogout()) return;
  await auth.logout();
  await render();
});

// --- Repair view wiring (device lost its local envelope: re-derive it from password + passphrase) ---
document.getElementById("repair-btn").addEventListener("click", async () => {
  const password = document.getElementById("repair-password").value;
  const passphrase = document.getElementById("repair-passphrase").value;
  const errorEl = document.getElementById("repair-error");
  if (!password || !passphrase) {
    errorEl.textContent = t("popup.enterBothCredentials");
    errorEl.hidden = false;
    return;
  }
  try {
    const { accountEmail } = await getAllLocal();
    const { dekEnvelope } = await api.getDekEnvelope();
    await auth.completeDeviceSetup({ email: accountEmail, password, passphrase, dekEnvelope });
    errorEl.hidden = true;
    await renderThenSync();
  } catch (err) {
    errorEl.textContent = err.message || t("popup.couldNotReconnect");
    errorEl.hidden = false;
  }
});

document.getElementById("repair-cancel-link").addEventListener("click", (e) => {
  e.preventDefault();
  showView("unlock");
});

// --- Status view wiring ---
document.getElementById("sync-now-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = t("popup.syncing");
  await syncNowInteractive();
  await renderStatusView();
  btn.disabled = false;
  btn.textContent = t("popup.syncNow");
});

document.getElementById("passwords-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("passwords/passwords.html") });
});

document.getElementById("view-data-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") });
});

document.getElementById("settings-toggle").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings/settings.html") });
  window.close();
});

render();
