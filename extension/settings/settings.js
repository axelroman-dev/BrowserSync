// Settings page, opened from the popup's gear icon (it used to be a panel
// inside the popup itself, too cramped for the danger-zone actions). It's
// also the only place to log out from once unlocked. Every destructive
// action asks through confirmModal below rather than window.confirm().
import * as auth from "../lib/auth.js";
import { getAllLocal, setLocal } from "../lib/storage.js";
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

// ---- Sync ------------------------------------------------------------------

const historyEnabledInput = document.getElementById("history-enabled");

function renderHistoryDays() {
  document.getElementById("history-days-row").hidden = !historyEnabledInput.checked;
}
historyEnabledInput.addEventListener("change", renderHistoryDays);

async function renderSyncForm() {
  const settings = await getAllLocal();
  historyEnabledInput.checked = settings.historyEnabled;
  document.getElementById("history-days").value = settings.historyDays;
  document.getElementById("sync-interval").value = settings.syncIntervalMinutes;
  renderHistoryDays();
}

document.getElementById("sync-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const historyDays = Math.min(3650, Math.max(1, Number(document.getElementById("history-days").value) || 90));
  const syncIntervalMinutes = Math.min(1440, Math.max(5, Number(document.getElementById("sync-interval").value) || 15));
  await setLocal({ historyEnabled: historyEnabledInput.checked, historyDays, syncIntervalMinutes });
  await chrome.runtime.sendMessage({ type: "refresh-alarm" });
  await renderSyncForm();
  show(document.getElementById("sync-notice"), t("settings.saved"));
});

// ---- Account ---------------------------------------------------------------

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
    await init();
  } finally {
    btn.disabled = false;
    btn.textContent = t("settings.logoutBtn");
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

document.getElementById("delete-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const passwordInput = document.getElementById("delete-password");
  const errorEl = document.getElementById("delete-error");
  show(errorEl);
  if (!passwordInput.value) return show(errorEl, t("popup.enterPasswordToConfirm"));
  const confirmed = await confirmModal({
    title: t("popup.deleteAccountSummary"),
    message: t("settings.confirmDeleteAccount"),
    confirmLabel: t("popup.deleteMyAccount"),
  });
  if (!confirmed) return;
  try {
    await auth.deleteAccount(passwordInput.value);
    await init();
  } catch (err) {
    show(errorEl, err.message || t("popup.couldNotDeleteAccount"));
  } finally {
    passwordInput.value = "";
  }
});

// ---- Session ---------------------------------------------------------------

async function init() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) return showView("notConnected");
  document.getElementById("account-label").textContent = `${session.accountEmail} · ${new URL(session.serverUrl).host}`;
  showView("settings");
  await renderSyncForm();
}

init();
