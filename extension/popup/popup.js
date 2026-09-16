import { wireConnectForm } from "../lib/connectForm.js";
import * as auth from "../lib/auth.js";
import * as api from "../lib/api.js";
import { getAllLocal, setLocal } from "../lib/storage.js";
import { armConfirm } from "../lib/uiConfirm.js";

// True right after a sync reports it's blocked on the merge/replace choice
// (normally already resolved by connectForm.js's themed dialog right after
// login - this only fires for the rare case of an unresolved device hitting
// "Sync now"/unlock/repair instead). There's no good way to ask "merge or
// replace?" here without a real modal - window.confirm() renders clipped to
// the popup's small window frame (see uiConfirm.js) and can't fit a 3-way
// choice into an "arm this button" pattern - so this just points the user at
// the two UIs that CAN ask properly: logging out and back in, or Settings ->
// "Restore bookmarks from server". Read by renderStatusView().
let firstSyncChoicePending = false;

// Runs a sync cycle via the background service worker instead of importing
// syncOrchestrator directly - unlike this popup document, the service
// worker isn't torn down when the popup closes (which happens easily: any
// click outside it), so a sync kicked off from a button click keeps running
// to completion instead of silently getting cut off partway through.
async function syncNowInteractive() {
  const result = await chrome.runtime.sendMessage({ type: "run-sync" });
  firstSyncChoicePending = result?.status === "skipped" && result?.reason === "needs_first_sync_choice";
  return result;
}

const views = {
  connect: document.getElementById("connect-view"),
  unlock: document.getElementById("unlock-view"),
  repair: document.getElementById("repair-view"),
  status: document.getElementById("status-view"),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  document.getElementById("settings-toggle").hidden = name !== "status";
}

function formatRelativeTime(ms) {
  if (!ms) return "Never synced";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "Last sync: just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last sync: ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last sync: ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Last sync: ${days}d ago`;
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
    errorEl.textContent =
      'This device has bookmarks that were never synced with this account. Open Settings and use "Restore bookmarks from server", or log out and back in, to resolve this.';
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }

  const settings = await getAllLocal();
  document.getElementById("history-enabled").checked = settings.historyEnabled;
  document.getElementById("history-days").value = settings.historyDays;
  document.getElementById("sync-interval").value = settings.syncIntervalMinutes;
}

async function render() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) {
    showView("connect");
    return;
  }
  if (!session.isUnlocked) {
    document.getElementById("unlock-email").textContent = session.accountEmail;
    showView(session.hasLocalEnvelope ? "unlock" : "repair");
    return;
  }
  showView("status");
  await renderStatusView();
}

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
    await render();
    syncNowInteractive().then(renderStatusView);
  },
);

// --- Unlock view wiring (password unlocks this device's local key envelope) ---
document.getElementById("unlock-btn").addEventListener("click", async () => {
  const password = document.getElementById("unlock-password").value;
  const errorEl = document.getElementById("unlock-error");
  if (!password) {
    errorEl.textContent = "Enter your password.";
    errorEl.hidden = false;
    return;
  }
  try {
    await auth.unlock(password);
    errorEl.hidden = true;
    await render();
    syncNowInteractive().then(renderStatusView);
  } catch (err) {
    if (err.code === "no_local_envelope") {
      showView("repair");
      return;
    }
    errorEl.textContent = err.message || "Could not unlock.";
    errorEl.hidden = false;
  }
});

document.getElementById("unlock-repair-link").addEventListener("click", (e) => {
  e.preventDefault();
  showView("repair");
});

document.getElementById("unlock-switch-account-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await auth.logout();
  await render();
});

// --- Repair view wiring (device lost its local envelope: re-derive it from password + passphrase) ---
document.getElementById("repair-btn").addEventListener("click", async () => {
  const password = document.getElementById("repair-password").value;
  const passphrase = document.getElementById("repair-passphrase").value;
  const errorEl = document.getElementById("repair-error");
  if (!password || !passphrase) {
    errorEl.textContent = "Enter both your password and recovery passphrase.";
    errorEl.hidden = false;
    return;
  }
  try {
    const { accountEmail } = await getAllLocal();
    const { dekEnvelope } = await api.getDekEnvelope();
    await auth.completeDeviceSetup({ email: accountEmail, password, passphrase, dekEnvelope });
    errorEl.hidden = true;
    await render();
    syncNowInteractive().then(renderStatusView);
  } catch (err) {
    errorEl.textContent = err.message || "Could not reconnect this device.";
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
  btn.textContent = "Syncing...";
  await syncNowInteractive();
  await renderStatusView();
  btn.disabled = false;
  btn.textContent = "Sync now";
});

const confirmForceRestore = armConfirm(document.getElementById("force-restore-btn"), "Click again to confirm - local bookmarks will be lost");
document.getElementById("force-restore-btn").addEventListener("click", async (e) => {
  if (!confirmForceRestore()) return;
  const btn = e.currentTarget;
  const statusEl = document.getElementById("force-restore-status");
  const errorEl = document.getElementById("force-restore-error");
  statusEl.hidden = true;
  errorEl.hidden = true;
  btn.disabled = true;
  btn.textContent = "Restoring...";
  try {
    const result = await chrome.runtime.sendMessage({ type: "apply-first-sync-choice", choice: "replace" });
    await renderStatusView();
    if (result?.status === "error") {
      errorEl.textContent = result.message || "Could not restore bookmarks.";
      errorEl.hidden = false;
    } else {
      statusEl.textContent = "Bookmarks restored from server.";
      statusEl.hidden = false;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Restore now";
  }
});

document.getElementById("view-data-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") });
});

document.getElementById("manage-devices-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("devices/devices.html") });
});

document.getElementById("logout-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await auth.logout();
  await render();
});

document.getElementById("settings-toggle").addEventListener("click", () => {
  const panel = document.getElementById("settings-panel");
  panel.hidden = !panel.hidden;
});

document.getElementById("save-settings-btn").addEventListener("click", async () => {
  const historyEnabled = document.getElementById("history-enabled").checked;
  const historyDays = Math.max(1, Number(document.getElementById("history-days").value) || 90);
  const syncIntervalMinutes = Math.max(5, Number(document.getElementById("sync-interval").value) || 15);
  await setLocal({ historyEnabled, historyDays, syncIntervalMinutes });
  await chrome.runtime.sendMessage({ type: "refresh-alarm" });
});

const confirmDeleteAccount = armConfirm(document.getElementById("delete-account-btn"), "Click again to confirm - can't be undone");
document.getElementById("delete-account-btn").addEventListener("click", async () => {
  const password = document.getElementById("delete-password").value;
  const errorEl = document.getElementById("delete-error");
  if (!password) {
    errorEl.textContent = "Enter your password to confirm.";
    errorEl.hidden = false;
    return;
  }
  if (!confirmDeleteAccount()) return;
  try {
    await auth.deleteAccount(password);
    await render();
  } catch (err) {
    errorEl.textContent = err.message || "Could not delete account.";
    errorEl.hidden = false;
  }
});

render();
