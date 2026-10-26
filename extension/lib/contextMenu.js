// Right-click menu with the saved accounts for the current tab, like
// Bitwarden's: autofill a login, or copy its username, password or current
// 2FA code - plus the password generator, which works in any state. Chrome can't build a context menu at the moment it opens, so
// it's rebuilt ahead of time whenever the active tab, the vault or the lock
// state changes - and every click re-checks the entry against the page it
// was clicked on, in case the menu is a step behind.
import { getActiveKey, getSession } from "./auth.js";
import { entriesForUrl, webOrigin, HOST_ORIGINS } from "./pageCredentials.js";
import { parseTotp, generateTotp } from "./totp.js";
import { initI18n, t } from "./i18n.js";
import { generatePassword, loadGeneratorOptions } from "./passwordGenerator.js";
import { copyText } from "./clipboard.js";

const ROOT_ID = "bs-root";
const CONTEXTS = ["page", "editable", "frame", "selection", "link", "image"];
// Past this many accounts the submenus get unwieldy; the vault page has the rest.
const MAX_ENTRIES = 25;
const ACTIONS = ["fill", "copy-user", "copy-pass", "copy-code"];

let building = Promise.resolve();
let rebuildTimer = null;

/** Rebuilds the menu for the active tab soon; bursts of events (tab switch + load + vault sync) collapse into one rebuild. */
export function refreshContextMenu() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    // Chained so two rebuilds never interleave their removeAll()/create() calls.
    building = building.then(build, build);
  }, 150);
}

function create(props) {
  return new Promise((resolve) => {
    chrome.contextMenus.create({ contexts: CONTEXTS, ...props }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// "&" marks a keyboard accelerator in menu titles; "&&" is a literal one.
function menuTitle(text) {
  return text.replaceAll("&", "&&");
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function build() {
  await chrome.contextMenus.removeAll();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url || !webOrigin(tab.url)) return;
  await initI18n();
  await create({ id: ROOT_ID, title: "BrowserSync" });
  // Filling needs the content script, which only runs with the host permission.
  const canFill = await chrome.permissions.contains({ origins: HOST_ORIGINS });

  const session = await getSession();
  const key = session.isLoggedIn ? await getActiveKey() : null;
  if (session.isLoggedIn && !key) {
    await create({ id: "bs-unlock", parentId: ROOT_ID, title: menuTitle(t("contextMenu.unlock")) });
  } else if (key) {
    await addAccountItems(tab, key, canFill);
  }

  // The generator needs no account or vault, so it's there in every state.
  if (session.isLoggedIn) await create({ id: "bs-separator", parentId: ROOT_ID, type: "separator" });
  await create({ id: "bs-generate-copy", parentId: ROOT_ID, title: menuTitle(t("contextMenu.generateCopy")) });
  if (canFill) {
    await create({ id: "bs-generate-fill", parentId: ROOT_ID, contexts: ["editable"], title: menuTitle(t("contextMenu.generateFill")) });
  }
  if (key) await create({ id: "bs-open", parentId: ROOT_ID, title: menuTitle(t("inPage.manage")) });
}

/** Autofill / copy submenus with the saved accounts for `tab`. */
async function addAccountItems(tab, key, canFill) {
  const entries = (await entriesForUrl(key, tab.url)).slice(0, MAX_ENTRIES);
  if (!entries.length) {
    await create({ id: "bs-none", parentId: ROOT_ID, enabled: false, title: menuTitle(t("contextMenu.noneForSite", { site: hostOf(tab.url) })) });
    return;
  }
  // With domain matching the accounts can come from different hosts; only then is the host worth showing.
  const showHost = new Set(entries.map((entry) => hostOf(entry.url))).size > 1;
  const label = (entry) => {
    const name = entry.username || t("passwords.noUsername");
    return menuTitle(showHost ? `${name} (${hostOf(entry.url)})` : name);
  };
  const groups = [
    canFill && { action: "fill", title: t("contextMenu.fill"), entries },
    { action: "copy-user", title: t("contextMenu.copyUsername"), entries: entries.filter((entry) => entry.username) },
    { action: "copy-pass", title: t("contextMenu.copyPassword"), entries },
    { action: "copy-code", title: t("contextMenu.copyCode"), entries: entries.filter((entry) => parseTotp(entry.totp)) },
  ];
  for (const group of groups) {
    if (!group || !group.entries.length) continue;
    const parentId = `bs-${group.action}`;
    await create({ id: parentId, parentId: ROOT_ID, title: menuTitle(group.title) });
    for (const entry of group.entries) {
      await create({ id: `${parentId}:${entry.id}`, parentId, title: label(entry) });
    }
  }
}

export async function handleContextMenuClick(info, tab) {
  const menuId = String(info.menuItemId);
  if (menuId === "bs-open" || menuId === "bs-unlock") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("passwords/passwords.html") });
    return;
  }
  if (menuId === "bs-generate-copy" || menuId === "bs-generate-fill") {
    const { password } = await generatePassword(await loadGeneratorOptions());
    // Copied on fill too, so the password isn't lost if the site's form is
    // abandoned before the save prompt.
    await copyText(password);
    const origin = webOrigin(tab?.url);
    if (menuId === "bs-generate-fill" && origin) {
      await chrome.tabs
        .sendMessage(tab.id, { type: "bs-fill-generated", source: "context", origin, password }, { frameId: 0 })
        .catch(() => {});
    }
    return;
  }
  const split = menuId.indexOf(":");
  const action = menuId.slice(3, split);
  const id = menuId.slice(split + 1);
  if (split < 0 || !ACTIONS.includes(action) || !tab?.url) return;
  const origin = webOrigin(tab.url);
  const key = await getActiveKey();
  if (!origin || !key) return;
  const entry = (await entriesForUrl(key, tab.url)).find((candidate) => candidate.id === id);
  if (!entry) return;

  if (action === "fill") {
    await chrome.tabs
      .sendMessage(
        tab.id,
        // Same origin check in the content script as a fill from the suggestion list.
        { type: "bs-fill", source: "context", origin, username: entry.username, password: entry.password },
        { frameId: 0 },
      )
      .catch(() => {});
  } else if (action === "copy-user") {
    await copyText(entry.username);
  } else if (action === "copy-pass") {
    await copyText(entry.password);
  } else if (action === "copy-code") {
    const config = parseTotp(entry.totp);
    if (config) await copyText((await generateTotp(config)).code);
  }
}
