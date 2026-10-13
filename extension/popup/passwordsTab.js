// Passwords tab of the popup: the vault at a glance, like Bitwarden's
// popup - the current site's logins on top, everything else searchable
// below, one-click copy of username / password / 2FA code, and a compact
// add/edit form. Import, export and the vault settings stay on the full
// page (passwords/passwords.html). Vault logic lives in lib/passwordVault.js;
// uploads go through the service worker like the full page does, so closing
// the popup right after saving doesn't cut them short.
import * as auth from "../lib/auth.js";
import { getAllLocal } from "../lib/storage.js";
import { siteIconElement } from "../lib/favicon.js";
import { parseTotp, generateTotp } from "../lib/totp.js";
import { listEntries, saveEntry, deleteEntry } from "../lib/passwordVault.js";
import { entryMatchesUrl, loadPublicSuffixList } from "../lib/urlMatch.js";
import { generatePassword, loadGeneratorOptions } from "../lib/passwordGenerator.js";
import { armConfirm } from "../lib/uiConfirm.js";
import { t } from "../lib/i18n.js";

// Same as the vault page. Best effort: the popup closes as soon as it loses
// focus, and the clear only runs while it's still open.
const CLIPBOARD_CLEAR_MS = 30_000;

const ICONS = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};

const $ = (id) => document.getElementById(id);

let entries = [];
let editingId = null;
let clipboardTimer = null;
let activeTabUrl = null;

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function hostOf(entry) {
  if (!entry.origin) return entry.url || t("passwords.noSite");
  return new URL(entry.origin).host;
}

async function requireKey() {
  const key = await auth.getActiveKey();
  if (!key) throw new Error(t("passwords.lockedError"));
  return key;
}

function svgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}

function iconButton(icon, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pw-icon-button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.appendChild(svgIcon(icon));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(btn);
  });
  return btn;
}

async function copy(value, btn, isSecret) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    showError($("pw-error"), t("passwords.copyFailed"));
    return;
  }
  if (!btn.classList.contains("copied")) {
    const original = btn.firstChild;
    btn.replaceChildren(svgIcon("check"));
    btn.classList.add("copied");
    setTimeout(() => {
      btn.replaceChildren(original);
      btn.classList.remove("copied");
    }, 1200);
  }
  if (isSecret) {
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), CLIPBOARD_CLEAR_MS);
  }
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = "pw-row";
  row.tabIndex = 0;
  row.title = t("passwords.edit");
  row.appendChild(siteIconElement(entry, "pw-site-icon"));

  const info = document.createElement("div");
  info.className = "pw-row-info";
  const site = document.createElement("span");
  site.className = "pw-row-site";
  site.textContent = hostOf(entry);
  const user = document.createElement("span");
  user.className = "pw-row-user";
  user.textContent = entry.username || t("passwords.noUsername");
  info.append(site, user);
  row.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "pw-row-actions";
  if (entry.username) actions.appendChild(iconButton("user", t("passwords.copyUsername"), (btn) => copy(entry.username, btn, false)));
  actions.appendChild(iconButton("key", t("passwords.copyPassword"), (btn) => copy(entry.password, btn, true)));
  const totp = parseTotp(entry.totp);
  if (totp) {
    actions.appendChild(
      iconButton("clock", t("passwords.copyCode"), async (btn) => copy((await generateTotp(totp)).code, btn, false)),
    );
  }
  row.appendChild(actions);

  row.addEventListener("click", () => openEditor(entry));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === row) openEditor(entry);
  });
  return row;
}

function emptyHint(text) {
  const p = document.createElement("p");
  p.className = "pw-empty";
  p.textContent = text;
  return p;
}

async function render() {
  const query = $("pw-search").value.trim().toLowerCase();
  const matches = (entry) => `${entry.url} ${entry.username} ${entry.notes}`.toLowerCase().includes(query);

  // Logins for the page the popup was opened over - hidden while searching,
  // where everything matching is listed once below anyway.
  let siteEntries = [];
  if (!query && activeTabUrl && entries.length) {
    const [psl, { passwordMatchDefault }] = await Promise.all([loadPublicSuffixList(), getAllLocal()]);
    siteEntries = entries.filter((entry) => entryMatchesUrl(entry, activeTabUrl, passwordMatchDefault, psl));
  }
  $("pw-site-group").hidden = !siteEntries.length;
  if (siteEntries.length) {
    $("pw-site-title").textContent = t("popup.pwForSite", { site: new URL(activeTabUrl).host });
    $("pw-site-list").replaceChildren(...siteEntries.map(renderRow));
  }

  const visible = query ? entries.filter(matches) : entries;
  $("pw-all-title").hidden = !entries.length;
  $("pw-list").replaceChildren(
    ...(visible.length
      ? visible.map(renderRow)
      : [emptyHint(entries.length ? t("passwords.noMatches") : t("popup.pwEmpty"))]),
  );
}

async function loadEntries() {
  try {
    entries = await listEntries(await requireKey());
    showError($("pw-error"), "");
  } catch (err) {
    entries = [];
    showError($("pw-error"), err.message);
  }
  await render();
}

function requestSync() {
  chrome.runtime.sendMessage({ type: "sync-passwords" }).catch(() => null);
}

// ---- Add / edit -----------------------------------------------------------

const fields = {
  url: $("pw-url"),
  username: $("pw-username"),
  password: $("pw-password"),
  totp: $("pw-totp"),
  notes: $("pw-notes"),
};

function setPasswordVisible(visible) {
  fields.password.type = visible ? "text" : "password";
  $("pw-toggle-btn").textContent = visible ? t("passwords.hide") : t("passwords.show");
}

function showPane(editing) {
  $("pw-list-pane").hidden = editing;
  $("pw-edit-pane").hidden = !editing;
}

function openEditor(entry = null) {
  editingId = entry?.id ?? null;
  $("pw-edit-title").textContent = entry ? t("passwords.editTitle") : t("passwords.addTitle");
  // A new entry starts on the site the popup was opened over.
  fields.url.value = entry?.url ?? (activeTabUrl ? new URL(activeTabUrl).origin : "");
  fields.username.value = entry?.username ?? "";
  fields.password.value = entry?.password ?? "";
  fields.totp.value = entry?.totp ?? "";
  fields.notes.value = entry?.notes ?? "";
  setPasswordVisible(false);
  $("pw-delete-btn").hidden = !entry;
  showError($("pw-edit-error"), "");
  showPane(true);
  (entry ? fields.password : fields.url.value ? fields.username : fields.url).focus();
}

function closeEditor() {
  for (const field of Object.values(fields)) field.value = "";
  editingId = null;
  showPane(false);
}

async function mutate(fn) {
  try {
    await fn(await requireKey());
  } catch (err) {
    showError($("pw-edit-error"), err.message || t("common.somethingWentWrong"));
    return;
  }
  closeEditor();
  await loadEntries();
  requestSync();
}

$("pw-toggle-btn").addEventListener("click", () => setPasswordVisible(fields.password.type === "password"));

// Uses the options last picked in the Generator tab.
$("pw-generate-btn").addEventListener("click", async () => {
  const { password } = await generatePassword(await loadGeneratorOptions());
  fields.password.value = password;
  setPasswordVisible(true);
});

$("pw-back-btn").addEventListener("click", closeEditor);
$("pw-add-btn").addEventListener("click", () => openEditor());
$("pw-search").addEventListener("input", render);

$("pw-edit-pane").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!fields.url.value.trim() || !fields.password.value) {
    showError($("pw-edit-error"), t("passwords.siteAndPasswordRequired"));
    return;
  }
  if (fields.totp.value.trim() && !parseTotp(fields.totp.value)) {
    showError($("pw-edit-error"), t("passwords.totpInvalidInput"));
    return;
  }
  const saveBtn = $("pw-save-btn");
  saveBtn.disabled = true;
  await mutate((key) =>
    saveEntry(key, {
      id: editingId,
      url: fields.url.value,
      username: fields.username.value.trim(),
      password: fields.password.value,
      notes: fields.notes.value,
      totp: fields.totp.value,
      // Keeps an edited entry's own matching mode; new ones follow the default.
      match: entries.find((entry) => entry.id === editingId)?.match ?? null,
      faviconPageUrl: activeTabUrl && !editingId ? activeTabUrl : undefined,
    }),
  );
  saveBtn.disabled = false;
});

// Armed on first click rather than here: this module runs before popup.js
// has translated the page, and armConfirm() restores the label it saw.
const deleteBtn = $("pw-delete-btn");
let confirmDelete = null;
deleteBtn.addEventListener("click", async () => {
  confirmDelete ??= armConfirm(deleteBtn, () => t("popup.pwConfirmDelete"));
  if (!confirmDelete()) return;
  const id = editingId;
  await mutate((key) => deleteEntry(key, id));
});

$("passwords-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("passwords/passwords.html") });
});

// Picks up another device's changes when a background sync lands while the
// popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "passwordVault" in changes && !$("passwords-view").hidden && $("pw-edit-pane").hidden) {
    loadEntries();
  }
});

/** Called each time the tab is opened. */
export async function showPasswordsTab() {
  closeEditor();
  $("pw-search").value = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  activeTabUrl = /^https?:/i.test(tab?.url ?? "") ? tab.url : null;
  await loadEntries();
  $("pw-search").focus();
  requestSync();
}
