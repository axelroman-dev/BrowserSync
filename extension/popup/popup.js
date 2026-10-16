import { wireConnectForm } from "../lib/connectForm.js";
import * as auth from "../lib/auth.js";
import * as api from "../lib/api.js";
import { getAllLocal } from "../lib/storage.js";
import { armConfirm } from "../lib/uiConfirm.js";
import { needsFirstSyncChoice } from "../lib/firstSyncPrompt.js";
import { wireSetupForm, renderSetupForm, isSetupComplete } from "../lib/setupForm.js";
import { initI18n, t } from "../lib/i18n.js";
import { mountGeneratorPanel } from "../lib/generatorPanel.js";
import { showPasswordsTab } from "./passwordsTab.js";
import { wireSettingsTab, showSettingsTab } from "./settingsTab.js";

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

// True while a "Sync now" click is running, so the status line says so.
let syncing = false;

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
  passwords: document.getElementById("passwords-view"),
  generator: document.getElementById("generator-view"),
  settings: document.getElementById("settings-view"),
};

// Once connected and unlocked, the popup is a set of full-page tabs with a
// bar at the bottom (like Bitwarden's). The connect/unlock/setup steps
// stay full-screen without it.
const TAB_VIEWS = ["status", "passwords", "generator", "settings"];
const tabBar = document.getElementById("tab-bar");
let activeTab = "status";
let popupGenerator = null;

function showView(name) {
  const tabbed = TAB_VIEWS.includes(name);
  if (tabbed) activeTab = name;
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  tabBar.hidden = !tabbed;
  document.body.classList.toggle("with-tabs", tabbed);
  for (const tab of tabBar.querySelectorAll(".tab")) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
  if (name === "generator") showGenerator();
  if (name === "passwords") showPasswordsTab();
  if (name === "settings") showSettingsTab();
}

// Built on first open; coming back to the tab generates a fresh password.
async function showGenerator() {
  if (popupGenerator) await popupGenerator.regenerate();
  else popupGenerator = await mountGeneratorPanel(document.getElementById("popup-generator"));
}

for (const tab of tabBar.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    if (tab.dataset.tab !== activeTab) showView(tab.dataset.tab);
  });
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

// Same name background.js gives the periodic sync alarm.
const SYNC_ALARM_NAME = "browsersync-periodic-sync";

function formatNextSync(alarm) {
  if (!alarm) return "";
  const minutes = Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 60000));
  return minutes < 1 ? t("popup.nextSyncSoon") : t("popup.nextSyncIn", { minutes });
}

async function countBookmarks() {
  const count = (nodes) => nodes.reduce((sum, node) => sum + (node.url ? 1 : 0) + count(node.children ?? []), 0);
  return count(await chrome.bookmarks.getTree());
}

/** The "What's synced" list: one line per kind of data, with what this device has of it. */
async function renderSyncedList(local) {
  const bookmarks = await countBookmarks().catch(() => null);
  document.getElementById("synced-bookmarks").textContent =
    bookmarks === null ? t("popup.syncedOn") : t("popup.syncedBookmarkCount", { count: String(bookmarks) });

  document.getElementById("synced-history").textContent = local.historyEnabled
    ? t("popup.syncedHistoryDays", { days: String(local.historyDays) })
    : t("popup.syncedOff");

  const passwordsEl = document.getElementById("synced-passwords");
  passwordsEl.classList.toggle("warn", Boolean(local.passwordsSyncError || local.passwordsPendingSync));
  if (local.passwordsSyncError) {
    passwordsEl.textContent = t("popup.syncedPasswordsError");
    passwordsEl.title = local.passwordsSyncError;
  } else {
    passwordsEl.textContent = local.passwordsPendingSync ? t("popup.syncedPasswordsPending") : t("popup.syncedOn");
    passwordsEl.title = "";
  }
}

async function renderStatusView() {
  const session = await auth.getSession();
  const local = await getAllLocal();
  document.getElementById("status-server").textContent = new URL(session.serverUrl).host;
  document.getElementById("status-account").textContent = session.accountEmail;
  document.getElementById("account-avatar").textContent = (session.accountEmail?.[0] ?? "?").toUpperCase();

  const indicator = document.getElementById("sync-indicator");
  const text = document.getElementById("sync-text");
  const errorEl = document.getElementById("sync-error");

  indicator.className = "dot " + (session.lastSyncStatus === "error" ? "dot-error" : session.lastSyncAt ? "dot-ok" : "dot-idle");
  text.textContent = formatRelativeTime(session.lastSyncAt);
  document.getElementById("sync-next").textContent = syncing
    ? t("popup.syncing")
    : formatNextSync(await chrome.alarms.get(SYNC_ALARM_NAME));
  if (session.lastSyncStatus === "error" && session.lastSyncError) {
    errorEl.textContent = session.lastSyncError;
    errorEl.hidden = false;
  } else if (firstSyncChoicePending) {
    errorEl.textContent = t("popup.firstSyncChoicePending");
    errorEl.hidden = false;
  } else {
    errorEl.hidden = true;
  }
  await renderSyncedList(local);
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
  for (const id of ["session-notice", "server-step", "connect-form", "save-passphrase-view", "device-setup-view", "forgot-password-view", "first-sync-error"]) {
    document.getElementById(id).hidden = true;
  }
  document.getElementById("first-sync-choice-view").hidden = false;
}

async function render() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) {
    showView("connect");
    // The connect view may still show a sub-step from an earlier visit
    // (e.g. the merge/replace question before a logout) - start over, going
    // straight to "Log in" when this device already knows its server and
    // account (see resumeKnownServer).
    await connectForm.resumeKnownServer();
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
  // Re-renders (after a sync, say) keep whichever tab the user is on,
  // without rebuilding it.
  if (views[activeTab].hidden) showView(activeTab);
  await renderStatusView();
}

wireSetupForm(renderThenSync);

// --- Connect view wiring (shared with onboarding.js) ---
const connectForm = wireConnectForm(
  {
    form: document.getElementById("connect-form"),
    formTitle: document.getElementById("connect-title"),
    emailInput: document.getElementById("email"),
    passwordInput: document.getElementById("password"),
    submitBtn: document.getElementById("submit-btn"),
    modeSwitchLink: document.getElementById("mode-switch-link"),
    forgotPasswordLink: document.getElementById("forgot-password-link"),
    errorMessage: document.getElementById("error-message"),

    serverStep: document.getElementById("server-step"),
    serverHost: document.getElementById("server-host"),
    changeServerLink: document.getElementById("change-server-link"),
    serverUrlInput: document.getElementById("server-url"),
    testConnectionBtn: document.getElementById("test-connection"),
    testStatus: document.getElementById("test-status"),
    healthSteps: document.getElementById("health-steps"),
    sessionNotice: document.getElementById("session-notice"),

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
    document.getElementById("unlock-password").value = "";
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
  btn.classList.add("spinning");
  syncing = true;
  await renderStatusView();
  try {
    await syncNowInteractive();
  } finally {
    syncing = false;
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
  await renderStatusView();
});

for (const link of document.querySelectorAll(".quick-link")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL(link.dataset.page) });
  });
}

// Keeps the status current while the popup stays open (a background sync
// finishing, the vault being edited in another tab).
chrome.storage.onChanged.addListener((changes, area) => {
  const relevant = ["lastSyncAt", "lastSyncStatus", "passwordsPendingSync", "passwordsSyncError"];
  if (area === "local" && !views.status.hidden && relevant.some((key) => key in changes)) renderStatusView();
});

// Locking lands back on the unlock view, and unlocking starts on the Sync
// tab again.
document.getElementById("lock-btn").addEventListener("click", async () => {
  await auth.lock();
  activeTab = "status";
  await render();
});

wireSettingsTab();

render();
