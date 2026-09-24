// Password vault page: list, add, edit, delete, copy and import saved
// passwords. All vault logic (encryption, merge, locking) lives in
// lib/passwordVault.js - this file only renders it. Uploads are delegated
// to the service worker ("sync-passwords" in background.js) so closing the
// tab right after saving doesn't cut the upload short.
import * as auth from "../lib/auth.js";
import { getAllLocal, setLocal } from "../lib/storage.js";
import { generatePassword } from "../lib/crypto.js";
import { siteIconElement } from "../lib/favicon.js";
import { listEntries, saveEntry, deleteEntry, importEntries, parseCsv } from "../lib/passwordVault.js";
import { HOST_ORIGINS } from "../lib/pageCredentials.js";
import { initI18n, t } from "../lib/i18n.js";

await initI18n();

// How long a copied password stays on the clipboard. Best effort: the
// clear only works while this tab still has focus (browsers refuse
// clipboard writes from background tabs).
const CLIPBOARD_CLEAR_MS = 30_000;

const views = {
  notConnected: document.getElementById("not-connected-view"),
  locked: document.getElementById("locked-view"),
  needsRepair: document.getElementById("needs-repair-view"),
  vault: document.getElementById("vault-view"),
};

const dialog = document.getElementById("entry-dialog");
const fields = {
  url: document.getElementById("entry-url"),
  match: document.getElementById("entry-match"),
  username: document.getElementById("entry-username"),
  password: document.getElementById("entry-password"),
  notes: document.getElementById("entry-notes"),
};

let entries = [];
let matchDefault = "domain";

const MATCH_LABEL_KEYS = {
  domain: "passwords.matchDomain",
  host: "passwords.matchHost",
  startsWith: "passwords.matchStartsWith",
  exact: "passwords.matchExact",
};
const MATCH_HINT_KEYS = {
  domain: "passwords.matchDomainHint",
  host: "passwords.matchHostHint",
  startsWith: "passwords.matchStartsWithHint",
  exact: "passwords.matchExactHint",
};
let editingId = null;
let revealedIds = new Set();
let clipboardTimer = null;

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function siteLabel(entry) {
  if (!entry.origin) return entry.url || t("passwords.noSite");
  return new URL(entry.origin).host;
}

/** Throws a locked error instead of returning null, so callers can't encrypt with a missing key. */
async function requireKey() {
  const key = await auth.getActiveKey();
  if (!key) {
    await init();
    throw new Error(t("passwords.lockedError"));
  }
  return key;
}

async function loadEntries() {
  try {
    entries = await listEntries(await requireKey());
    showError(document.getElementById("vault-error"), "");
  } catch (err) {
    entries = [];
    showError(document.getElementById("vault-error"), err.message);
  }
  renderEntries();
  await renderSyncLine();
}

async function renderSyncLine() {
  const line = document.getElementById("sync-line");
  const { passwordsPendingSync, passwordsSyncError } = await getAllLocal();
  if (passwordsSyncError) {
    line.textContent = t("passwords.syncFailed", { error: passwordsSyncError });
  } else if (passwordsPendingSync) {
    line.textContent = t("passwords.syncPending");
  } else {
    line.textContent = t("passwords.syncedCount", { count: String(entries.length) });
  }
}

function renderEntries() {
  const container = document.getElementById("entries-list");
  container.replaceChildren();

  const query = document.getElementById("search-input").value.trim().toLowerCase();
  const visible = query
    ? entries.filter((entry) => `${entry.url} ${entry.username} ${entry.notes}`.toLowerCase().includes(query))
    : entries;

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = entries.length ? t("passwords.noMatches") : t("passwords.empty");
    container.appendChild(empty);
    return;
  }
  for (const entry of visible) container.appendChild(renderEntryRow(entry));
}

function rowButton(label, onClick, className = "row-button") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "entry-row";
  row.appendChild(siteIconElement(entry));

  const info = document.createElement("div");
  info.className = "entry-info";

  const site = document.createElement("div");
  site.className = "entry-site";
  if (entry.origin) {
    const link = document.createElement("a");
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = siteLabel(entry);
    site.appendChild(link);
  } else {
    site.textContent = siteLabel(entry);
  }
  // Only entries that override the default say so - the rest follow the
  // setting above the list.
  if (entry.match && MATCH_LABEL_KEYS[entry.match]) {
    const badge = document.createElement("span");
    badge.className = "match-badge";
    badge.textContent = t(MATCH_LABEL_KEYS[entry.match]);
    site.appendChild(badge);
  }
  info.appendChild(site);

  const username = document.createElement("div");
  username.className = "entry-username";
  username.textContent = entry.username || t("passwords.noUsername");
  info.appendChild(username);

  const revealed = revealedIds.has(entry.id);
  const secret = document.createElement("div");
  secret.className = "entry-secret";
  secret.textContent = revealed ? entry.password : "••••••••••";
  info.appendChild(secret);

  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  if (entry.username) {
    actions.appendChild(rowButton(t("passwords.copyUsername"), (e) => copyToClipboard(entry.username, e.target, false)));
  }
  actions.appendChild(rowButton(t("passwords.copyPassword"), (e) => copyToClipboard(entry.password, e.target, true)));
  actions.appendChild(
    rowButton(revealed ? t("passwords.hide") : t("passwords.show"), () => {
      if (revealed) revealedIds.delete(entry.id);
      else revealedIds.add(entry.id);
      renderEntries();
    }),
  );
  actions.appendChild(rowButton(t("passwords.edit"), () => openDialog(entry)));
  actions.appendChild(
    rowButton(
      t("passwords.delete"),
      async () => {
        if (!confirm(t("passwords.confirmDelete", { site: siteLabel(entry), username: entry.username || "—" }))) return;
        await runMutation(async (key) => deleteEntry(key, entry.id));
      },
      "row-button danger",
    ),
  );
  row.appendChild(actions);

  return row;
}

async function copyToClipboard(value, btn, isSecret) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    showError(document.getElementById("vault-error"), t("passwords.copyFailed"));
    return;
  }
  btn.textContent = t("common.copied");
  setTimeout(() => (btn.textContent = original), 1500);
  if (isSecret) {
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), CLIPBOARD_CLEAR_MS);
  }
}

/** Applies a local change, re-renders, then asks the service worker to upload it. */
async function runMutation(fn) {
  const errorEl = document.getElementById("vault-error");
  try {
    await fn(await requireKey());
  } catch (err) {
    showError(errorEl, err.message || t("common.somethingWentWrong"));
    return false;
  }
  await loadEntries();
  requestSync();
  return true;
}

async function requestSync() {
  const response = await chrome.runtime.sendMessage({ type: "sync-passwords" }).catch(() => null);
  // syncPasswords stores its own error for renderSyncLine; the storage
  // listener below re-renders once the merged vault lands.
  if (response?.status !== "ok") await renderSyncLine();
}

function openDialog(entry = null) {
  editingId = entry?.id ?? null;
  document.getElementById("entry-dialog-title").textContent = entry ? t("passwords.editTitle") : t("passwords.addTitle");
  fields.url.value = entry?.url ?? "";
  document.getElementById("entry-match-default").textContent = t("passwords.matchUseDefault", {
    mode: t(MATCH_LABEL_KEYS[matchDefault]),
  });
  fields.match.value = entry?.match ?? "";
  renderEntryMatchHint();
  fields.username.value = entry?.username ?? "";
  fields.password.value = entry?.password ?? "";
  fields.notes.value = entry?.notes ?? "";
  setPasswordVisible(false);
  showError(document.getElementById("entry-error"), "");
  dialog.showModal();
  (entry ? fields.password : fields.url).focus();
}

function setPasswordVisible(visible) {
  fields.password.type = visible ? "text" : "password";
  document.getElementById("entry-toggle-btn").textContent = visible ? t("passwords.hide") : t("passwords.show");
}

document.getElementById("entry-toggle-btn").addEventListener("click", () => {
  setPasswordVisible(fields.password.type === "password");
});

document.getElementById("entry-generate-btn").addEventListener("click", () => {
  fields.password.value = generatePassword();
  setPasswordVisible(true);
});

document.getElementById("entry-cancel-btn").addEventListener("click", () => dialog.close());

document.getElementById("entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("entry-error");
  if (!fields.url.value.trim() || !fields.password.value) {
    showError(errorEl, t("passwords.siteAndPasswordRequired"));
    return;
  }
  const saveBtn = document.getElementById("entry-save-btn");
  saveBtn.disabled = true;
  const ok = await runMutation((key) =>
    saveEntry(key, {
      id: editingId,
      url: fields.url.value,
      match: fields.match.value || null,
      username: fields.username.value.trim(),
      password: fields.password.value,
      notes: fields.notes.value,
    }),
  );
  saveBtn.disabled = false;
  if (ok) dialog.close();
  else showError(errorEl, document.getElementById("vault-error").textContent);
});

function renderEntryMatchHint() {
  document.getElementById("entry-match-hint").textContent = t(MATCH_HINT_KEYS[fields.match.value || matchDefault]);
}
fields.match.addEventListener("change", renderEntryMatchHint);

async function renderMatchDefault() {
  ({ passwordMatchDefault: matchDefault } = await getAllLocal());
  const select = document.getElementById("match-default-select");
  select.value = matchDefault;
  document.getElementById("match-default-hint").textContent = t(MATCH_HINT_KEYS[matchDefault]);
}

document.getElementById("match-default-select").addEventListener("change", async (e) => {
  await setLocal({ passwordMatchDefault: e.target.value });
  await renderMatchDefault();
});

// Nothing sensitive lingers in the (hidden) form after the dialog closes.
dialog.addEventListener("close", () => {
  for (const field of Object.values(fields)) field.value = "";
  editingId = null;
});

// In-page suggestions need the optional http/https host permission; the
// service worker registers or removes the content script as it's granted or
// revoked (see lib/pageCredentials.js). While off, a card at the top offers
// to turn it on; once on, the card goes away and the switch stays in
// Settings, where turning it off asks first.
let inPageEnabled = false;

async function renderInPageToggle() {
  inPageEnabled = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  document.getElementById("inpage-card").hidden = inPageEnabled;
  document.getElementById("inpage-status").textContent = inPageEnabled ? t("passwords.inPageOnHint") : t("passwords.inPageOffShort");
  document.getElementById("inpage-toggle").textContent = inPageEnabled ? t("passwords.inPageDisable") : t("passwords.inPageEnable");
}

async function setInPageEnabled(enable) {
  // permissions.request() must run straight from the click (a user
  // gesture), so it's called before anything else is awaited.
  const change = enable
    ? chrome.permissions.request({ origins: HOST_ORIGINS })
    : chrome.permissions.remove({ origins: HOST_ORIGINS });
  let changed = false;
  try {
    changed = await change;
  } catch (err) {
    showError(document.getElementById("vault-error"), err.message);
  }
  await chrome.runtime.sendMessage({ type: "refresh-content-scripts" }).catch(() => null);
  await renderInPageToggle();
  if (changed && enable) showError(document.getElementById("vault-notice"), t("passwords.inPageEnabledNotice"));
}

document.getElementById("inpage-enable-btn").addEventListener("click", () => setInPageEnabled(true));

document.getElementById("inpage-toggle").addEventListener("click", () => {
  if (!inPageEnabled) {
    setInPageEnabled(true);
  } else if (confirm(t("passwords.confirmDisableInPage"))) {
    setInPageEnabled(false);
  }
});

document.getElementById("add-btn").addEventListener("click", () => openDialog());

document.getElementById("search-input").addEventListener("input", renderEntries);

document.getElementById("import-btn").addEventListener("click", () => document.getElementById("import-file").click());

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const noticeEl = document.getElementById("vault-notice");
  showError(noticeEl, "");
  const rows = parseCsv(await file.text());
  if (!rows) {
    showError(document.getElementById("vault-error"), t("passwords.importUnrecognized"));
    return;
  }
  let result;
  await runMutation(async (key) => {
    result = await importEntries(key, rows);
  });
  if (result) {
    showError(noticeEl, t("passwords.importDone", { added: String(result.added), skipped: String(result.skipped) }));
  }
});

document.getElementById("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("unlock-password");
  const errorEl = document.getElementById("unlock-error");
  if (!input.value) {
    showError(errorEl, t("common.enterPassword"));
    return;
  }
  showError(errorEl, "");
  try {
    await auth.unlock(input.value);
  } catch (err) {
    if (err.code === "no_local_envelope") {
      showView("needsRepair");
      return;
    }
    showError(errorEl, err.message || t("common.couldNotUnlock"));
    return;
  } finally {
    input.value = "";
  }
  await init();
});

// Keeps the page current when a background sync pulls another device's
// changes, and falls back to the right view on logout/lock elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("accountEmail" in changes || ("accessToken" in changes && !changes.accessToken.newValue))) {
    init();
  } else if (area === "session" && "encryptionKeyRaw" in changes) {
    init();
  } else if (area === "local" && ("passwordVault" in changes || "passwordsSyncError" in changes)) {
    if (!views.vault.hidden) loadEntries();
  }
});

async function init() {
  const session = await auth.getSession();
  if (!session.isLoggedIn) {
    entries = [];
    showView("notConnected");
    return;
  }
  document.getElementById("account-label").textContent = `${session.accountEmail} · ${new URL(session.serverUrl).host}`;
  if (!session.isUnlocked) {
    entries = [];
    showView(session.hasLocalEnvelope ? "locked" : "needsRepair");
    return;
  }
  showView("vault");
  await Promise.all([loadEntries(), renderInPageToggle(), renderMatchDefault()]);
  // Pull whatever other devices saved since the last background sync.
  requestSync();
}

init();
