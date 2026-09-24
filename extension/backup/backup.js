// Full backup page: export chosen parts to a file encrypted with a backup
// password, or open such a file and restore chosen parts. All the format
// and restore logic lives in lib/backup.js.
import * as auth from "../lib/auth.js";
import {
  collectBackup,
  encryptBackup,
  decryptBackup,
  describeBackup,
  restoreBackup,
  downloadFile,
  datedFilename,
  MIN_BACKUP_PASSWORD_LENGTH,
} from "../lib/backup.js";
import { initI18n, t } from "../lib/i18n.js";

await initI18n();

const views = {
  notConnected: document.getElementById("not-connected-view"),
  locked: document.getElementById("locked-view"),
  needsRepair: document.getElementById("needs-repair-view"),
  backup: document.getElementById("backup-view"),
};

// The decrypted contents of an opened backup, only between "Open backup"
// and Restore/Cancel.
let openedBackup = null;

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function show(el, message) {
  el.textContent = message ?? "";
  el.hidden = !message;
}

function checkedParts(form) {
  return Object.fromEntries(["passwords", "bookmarks", "settings"].map((name) => [name, form.elements[name].checked]));
}

async function requireKey() {
  const key = await auth.getActiveKey();
  if (!key) {
    await init();
    throw new Error(t("passwords.lockedError"));
  }
  return key;
}

// ---- Export ----------------------------------------------------------------

document.getElementById("export-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const errorEl = document.getElementById("export-error");
  const noticeEl = document.getElementById("export-notice");
  const backupPassword = document.getElementById("export-backup-password").value;
  const confirmPassword = document.getElementById("export-backup-password-confirm").value;
  const accountPassword = document.getElementById("export-account-password").value;
  const include = checkedParts(form);
  show(errorEl);
  show(noticeEl);

  if (!Object.values(include).some(Boolean)) return show(errorEl, t("backup.pickSomething"));
  if (backupPassword.length < MIN_BACKUP_PASSWORD_LENGTH) {
    return show(errorEl, t("backup.backupPasswordTooShort", { min: String(MIN_BACKUP_PASSWORD_LENGTH) }));
  }
  if (backupPassword !== confirmPassword) return show(errorEl, t("backup.backupPasswordsDontMatch"));
  if (!accountPassword) return show(errorEl, t("common.enterPassword"));

  const btn = document.getElementById("export-btn");
  btn.disabled = true;
  btn.textContent = t("backup.working");
  try {
    await auth.verifyPassword(accountPassword);
    const data = await collectBackup(await requireKey(), include);
    downloadFile(datedFilename("browsersync-backup", "json"), await encryptBackup(data, backupPassword), "application/json");
    form.reset();
    show(noticeEl, t("backup.exported"));
  } catch (err) {
    show(errorEl, err.message || t("common.somethingWentWrong"));
  } finally {
    document.getElementById("export-account-password").value = "";
    btn.disabled = false;
    btn.textContent = t("backup.exportBtn");
  }
});

// ---- Restore ---------------------------------------------------------------

document.getElementById("open-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("open-error");
  const file = document.getElementById("restore-file").files?.[0];
  const backupPassword = document.getElementById("restore-backup-password").value;
  show(errorEl);
  if (!file) return show(errorEl, t("backup.pickFile"));
  if (!backupPassword) return show(errorEl, t("backup.enterBackupPassword"));

  const btn = document.getElementById("open-btn");
  btn.disabled = true;
  btn.textContent = t("backup.working");
  try {
    openedBackup = await decryptBackup(await file.text(), backupPassword);
    renderRestoreChoices();
  } catch (err) {
    show(errorEl, err.message || t("common.somethingWentWrong"));
  } finally {
    document.getElementById("restore-backup-password").value = "";
    btn.disabled = false;
    btn.textContent = t("backup.openBtn");
  }
});

function renderRestoreChoices() {
  const counts = describeBackup(openedBackup.data);
  const created = openedBackup.createdAt ? new Date(openedBackup.createdAt).toLocaleString() : "?";
  document.getElementById("restore-summary").textContent = t("backup.fileSummary", { date: created });

  const rows = {
    passwords: [counts.passwords !== null, t("backup.partPasswordsCount", { count: String(counts.passwords) })],
    bookmarks: [counts.bookmarks !== null, t("backup.partBookmarksCount", { count: String(counts.bookmarks) })],
    settings: [counts.settings !== null, null],
  };
  const form = document.getElementById("restore-form");
  for (const [name, [present, label]] of Object.entries(rows)) {
    document.getElementById(`restore-${name}-row`).hidden = !present;
    form.elements[name].checked = present;
    if (label) document.getElementById(`restore-${name}-label`).textContent = label;
  }
  show(document.getElementById("restore-error"));
  show(document.getElementById("restore-result"));
  document.getElementById("open-form").hidden = true;
  form.hidden = false;
}

function closeRestore() {
  openedBackup = null;
  document.getElementById("restore-form").hidden = true;
  document.getElementById("open-form").hidden = false;
  document.getElementById("open-form").reset();
}

document.getElementById("restore-cancel-btn").addEventListener("click", closeRestore);

document.getElementById("restore-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("restore-error");
  const include = checkedParts(e.target);
  show(errorEl);
  if (!Object.values(include).some(Boolean)) return show(errorEl, t("backup.pickSomething"));

  const btn = document.getElementById("restore-btn");
  btn.disabled = true;
  btn.textContent = t("backup.working");
  try {
    const result = await restoreBackup(await requireKey(), openedBackup.data, include);
    // Upload right away instead of waiting for the next alarm tick.
    if (result.passwords) chrome.runtime.sendMessage({ type: "sync-passwords" }).catch(() => {});
    if (result.settings) await chrome.runtime.sendMessage({ type: "refresh-alarm" }).catch(() => {});
    const lines = [];
    if (result.passwords) lines.push(t("backup.restoredPasswords", { added: String(result.passwords.added), skipped: String(result.passwords.skipped) }));
    if (result.bookmarks) lines.push(t("backup.restoredBookmarks", { count: String(result.bookmarks.created) }));
    if (result.bookmarks?.failed) lines.push(t("backup.restoredBookmarksFailed", { count: String(result.bookmarks.failed) }));
    if (result.settings) lines.push(t("backup.restoredSettings"));
    closeRestore();
    show(document.getElementById("restore-result"), lines.join(" "));
  } catch (err) {
    show(errorEl, err.message || t("common.somethingWentWrong"));
  } finally {
    btn.disabled = false;
    btn.textContent = t("backup.restoreBtn");
  }
});

// ---- Session ---------------------------------------------------------------

document.getElementById("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("unlock-password");
  const errorEl = document.getElementById("unlock-error");
  if (!input.value) return show(errorEl, t("common.enterPassword"));
  show(errorEl);
  try {
    await auth.unlock(input.value);
  } catch (err) {
    if (err.code === "no_local_envelope") return showView("needsRepair");
    return show(errorEl, err.message || t("common.couldNotUnlock"));
  } finally {
    input.value = "";
  }
  await init();
});

async function init() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) return showView("notConnected");
  document.getElementById("account-label").textContent = `${session.accountEmail} · ${new URL(session.serverUrl).host}`;
  if (!session.isUnlocked) return showView(session.hasLocalEnvelope ? "locked" : "needsRepair");
  showView("backup");
}

init();
