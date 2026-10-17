// Advanced settings page, opened from "More settings" in the popup's
// Settings tab - which keeps the everyday settings (sync, in-page
// passwords, lock/log out); this page has the rest, too cramped for the
// popup (the danger-zone actions especially). Every destructive
// action asks through confirmModal below rather than window.confirm().
import * as auth from "../lib/auth.js";
import { getAllLocal } from "../lib/storage.js";
import { initI18n, t } from "../lib/i18n.js";

await initI18n();

const views = {
  notConnected: document.getElementById("not-connected-view"),
  settings: document.getElementById("settings-view"),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function show(el, message) {
  el.textContent = message ?? "";
  el.hidden = !message;
}

// ---- Confirmation modal -----------------------------------------------------

const confirmDialog = document.getElementById("confirm-dialog");

/** Resolves true only when the user clicks the confirm button (Cancel, Escape and the backdrop all resolve false). */
function confirmModal({ title, message, confirmLabel }) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-message").textContent = message;
  document.getElementById("confirm-ok").textContent = confirmLabel;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  // Focus starts on Cancel, so a stray Enter never confirms.
  confirmDialog.querySelector('button[value="cancel"]').focus();
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
  });
}

confirmDialog.addEventListener("click", (e) => {
  if (e.target === confirmDialog) confirmDialog.close();
});

// ---- Account ---------------------------------------------------------------

/**
 * After logging out nothing on this page applies
 * anymore, so the tab becomes the login screen instead of an empty page.
 * replace() keeps Back from returning to the signed-out settings page.
 */
function goToLogin() {
  location.replace(chrome.runtime.getURL("onboarding/onboarding.html"));
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  // Logging out deletes this device's local password vault (see
  // clearAccountLocal), so unsynced vault edits get a stronger warning.
  const { passwordsPendingSync } = await getAllLocal();
  const confirmed = await confirmModal({
    title: t("settings.logoutTitle"),
    message: passwordsPendingSync ? t("settings.confirmLogoutPending") : t("settings.confirmLogout"),
    confirmLabel: t("settings.logoutBtn"),
  });
  if (!confirmed) return;
  const btn = document.getElementById("logout-btn");
  btn.disabled = true;
  btn.textContent = t("settings.loggingOut");
  try {
    await auth.logout();
    goToLogin();
  } finally {
    btn.disabled = false;
    btn.textContent = t("settings.logoutBtn");
  }
});

document.getElementById("change-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentInput = document.getElementById("current-password");
  const newInput = document.getElementById("new-password");
  const confirmInput = document.getElementById("confirm-new-password");
  const statusEl = document.getElementById("change-password-status");
  const errorEl = document.getElementById("change-password-error");
  const btn = document.getElementById("change-password-btn");
  show(statusEl);
  show(errorEl);
  if (!currentInput.value || !newInput.value || !confirmInput.value) return show(errorEl, t("connectForm.errFillEveryField"));
  if (newInput.value.length < 8) return show(errorEl, t("connectForm.errNewPasswordTooShort"));
  if (newInput.value !== confirmInput.value) return show(errorEl, t("settings.newPasswordsDontMatch"));
  if (newInput.value === currentInput.value) return show(errorEl, t("settings.newPasswordSameAsCurrent"));
  const confirmed = await confirmModal({
    title: t("settings.changePasswordTitle"),
    message: t("settings.confirmChangePassword"),
    confirmLabel: t("settings.changePasswordBtn"),
  });
  if (!confirmed) return;
  btn.disabled = true;
  btn.textContent = t("settings.changingPassword");
  try {
    await auth.changePassword({ currentPassword: currentInput.value, newPassword: newInput.value });
    currentInput.value = newInput.value = confirmInput.value = "";
    show(statusEl, t("settings.passwordChanged"));
  } catch (err) {
    show(errorEl, err.message || t("settings.couldNotChangePassword"));
  } finally {
    btn.disabled = false;
    btn.textContent = t("settings.changePasswordBtn");
  }
});

// ---- Danger zone -----------------------------------------------------------

/** Runs one of the background's merge/replace choices, reporting in the row's own status/error lines. */
async function runBookmarkAction({ btn, titleKey, confirmKey, choice, busyKey, idleKey, doneKey, failKey, statusId, errorId }) {
  const confirmed = await confirmModal({ title: t(titleKey), message: t(confirmKey), confirmLabel: t(idleKey) });
  if (!confirmed) return;
  const statusEl = document.getElementById(statusId);
  const errorEl = document.getElementById(errorId);
  show(statusEl);
  show(errorEl);
  btn.disabled = true;
  btn.textContent = t(busyKey);
  try {
    const result = await chrome.runtime.sendMessage({ type: "apply-first-sync-choice", choice });
    if (result?.status === "error") show(errorEl, result.message || t(failKey));
    else if (result?.status === "skipped" && result.reason === "locked") show(errorEl, t("passwords.lockedError"));
    else show(statusEl, t(doneKey));
  } finally {
    btn.disabled = false;
    btn.textContent = t(idleKey);
  }
}

document.getElementById("force-restore-btn").addEventListener("click", (e) =>
  runBookmarkAction({
    btn: e.currentTarget,
    titleKey: "popup.restoreBookmarksSummary",
    confirmKey: "settings.confirmForceRestore",
    choice: "replace",
    busyKey: "popup.restoring",
    idleKey: "popup.restoreNow",
    doneKey: "popup.restoredStatus",
    failKey: "popup.couldNotRestore",
    statusId: "force-restore-status",
    errorId: "force-restore-error",
  }),
);

document.getElementById("force-push-btn").addEventListener("click", (e) =>
  runBookmarkAction({
    btn: e.currentTarget,
    titleKey: "popup.pushBookmarksSummary",
    confirmKey: "settings.confirmForcePush",
    choice: "keep-local",
    busyKey: "popup.pushing",
    idleKey: "popup.pushNow",
    doneKey: "popup.pushedStatus",
    failKey: "popup.couldNotPush",
    statusId: "force-push-status",
    errorId: "force-push-error",
  }),
);

// ---- Session ---------------------------------------------------------------

async function init() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) return showView("notConnected");
  document.getElementById("account-label").textContent = `${session.accountEmail} · ${new URL(session.serverUrl).host}`;
  // Deleting the account lives on the server's own dashboard (public/dashboard/).
  document.getElementById("account-page-link").href = new URL("/dashboard/", session.serverUrl).href;
  showView("settings");
}

init();
