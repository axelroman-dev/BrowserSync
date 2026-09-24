// Service-worker side of in-page credential suggestions and the "save this
// password?" prompt. Three parties talk here, and none trusts the page:
//
// - content/credentials.js (content script, runs inside the web page): puts
//   the key icon on password fields, reports submitted logins, and fills a
//   credential only when this module sends one. It never receives the
//   vault - only the single credential the user picked, for a site it
//   matches (see urlMatch.js).
// - content/frame.html (an extension page, shown in an iframe the content
//   script injects): renders the suggestion list and the save prompt. Being
//   a chrome-extension:// document, the web page around it can't read the
//   usernames it shows or script its buttons.
// - this module: decrypts the vault and decides what each side gets. The
//   origin is always taken from Chrome's MessageSender (sender.origin /
//   sender.tab.url), never from anything the page could have written.
//
// All of this only runs once the user grants the optional http/https host
// permission from the vault page - see syncContentScriptRegistration().
import { getActiveKey } from "./auth.js";
import { getAllLocal } from "./storage.js";
import { listEntries, saveEntry, syncPasswords } from "./passwordVault.js";
import { entryMatchesUrl, loadPublicSuffixList } from "./urlMatch.js";
import { isNeverSaveHost, addNeverSaveHost } from "./neverSave.js";

export const HOST_ORIGINS = ["http://*/*", "https://*/*"];
const CONTENT_SCRIPT_ID = "browsersync-credentials";
const FRAME_URL = chrome.runtime.getURL("content/frame.html");
// A captured login waits this long for the next page (or the SPA's own
// re-render) to show the save prompt; after that it's dropped.
const PENDING_TTL_MS = 2 * 60 * 1000;

/** Registers the content script while the host permission is granted, and removes it once revoked. */
export async function syncContentScriptRegistration() {
  const granted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (granted && !existing.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        matches: HOST_ORIGINS,
        js: ["content/credentials.js"],
        runAt: "document_idle",
        // Top frame only: the suggestion menu is the thing a malicious page
        // would try to clickjack, and a cross-origin login iframe is where
        // that's easiest to set up.
        allFrames: false,
      },
    ]);
  } else if (!granted && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
  return granted;
}

function webOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Pending captures live in chrome.storage.session (memory only, like the
 * DEK) rather than a variable, because the MV3 service worker is often
 * restarted between a login form's submit and the next page's load.
 */
async function getPending(tabId) {
  const key = `pendingSave:${tabId}`;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) return null;
  if (Date.now() - pending.capturedAt > PENDING_TTL_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return pending;
}

function setPending(tabId, pending) {
  return chrome.storage.session.set({ [`pendingSave:${tabId}`]: pending });
}

function clearPending(tabId) {
  return chrome.storage.session.remove(`pendingSave:${tabId}`);
}

function closeInPage(tabId, target) {
  return chrome.tabs.sendMessage(tabId, { type: "bs-close", target }, { frameId: 0 }).catch(() => {});
}

/** Vault entries that should be offered on `pageUrl`, per each entry's URL-matching mode. */
async function entriesForUrl(key, pageUrl) {
  const [entries, psl, { passwordMatchDefault }] = await Promise.all([
    listEntries(key),
    loadPublicSuffixList(),
    getAllLocal(),
  ]);
  return entries.filter((entry) => entryMatchesUrl(entry, pageUrl, passwordMatchDefault, psl));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isFromOurFrame(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(FRAME_URL) && sender.tab;
}

function isFromContentScript(sender) {
  return sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0 && !sender.url?.startsWith("chrome-extension:");
}

async function handleCapture(message, sender) {
  const origin = webOrigin(sender.origin ?? sender.url);
  const password = typeof message.password === "string" ? message.password : "";
  const username = typeof message.username === "string" ? message.username.trim() : "";
  if (!origin || !password) return { ok: false };
  // The user chose "Never for this site" here before: don't even keep the
  // captured password around.
  if (await isNeverSaveHost(new URL(origin).hostname)) return { ok: false };
  const key = await getActiveKey();
  // Locked: nothing to compare against or encrypt with, so no prompt.
  if (!key) return { ok: false };

  // Same matching as suggestions: a login on sub.example.com that's
  // already saved for example.com isn't "new".
  const sameSite = await entriesForUrl(key, sender.url);
  const sameUser = sameSite.find((entry) => entry.username === username);
  if (sameUser?.password === password) {
    await clearPending(sender.tab.id);
    return { ok: true };
  }
  await setPending(sender.tab.id, {
    origin,
    pageUrl: sender.url,
    username,
    password,
    updateId: sameUser?.id ?? null,
    capturedAt: Date.now(),
    shown: false,
  });
  return { ok: true };
}

/** Asked by the content script on every page load (and after an SPA login): should it show the save prompt? */
async function handleCheckPending(sender) {
  const pending = await getPending(sender.tab.id);
  if (!pending || pending.shown) return { show: false };
  // Shown once per capture: if the user navigates on without answering,
  // don't keep popping it up on every page after.
  await setPending(sender.tab.id, { ...pending, shown: true });
  return { show: true };
}

async function handleGetSuggestions(sender) {
  const origin = webOrigin(sender.tab.url);
  const key = await getActiveKey();
  if (!key) return { locked: true, origin };
  const entries = origin ? await entriesForUrl(key, sender.tab.url) : [];
  return {
    origin,
    // `site` is where the entry was saved, which with domain matching can
    // differ from the current page (example.com vs login.example.com).
    suggestions: entries.map((entry) => ({
      id: entry.id,
      username: entry.username,
      site: hostOf(entry.url),
      url: entry.url,
      favicon: entry.favicon ?? null,
    })),
  };
}

async function handleFill(message, sender) {
  const origin = webOrigin(sender.tab.url);
  const key = await getActiveKey();
  if (!key || !origin) return { ok: false };
  // Re-checked here, not just when the list was built: the tab may have
  // navigated to another site while the menu was open.
  const entry = (await entriesForUrl(key, sender.tab.url)).find((candidate) => candidate.id === message.id);
  if (!entry) return { ok: false };
  await chrome.tabs.sendMessage(
    sender.tab.id,
    // The content script refuses the fill unless its own location.origin
    // still matches, closing the last navigation race.
    { type: "bs-fill", origin, username: entry.username, password: entry.password },
    { frameId: 0 },
  );
  return { ok: true };
}

async function handleGetPending(sender) {
  const pending = await getPending(sender.tab.id);
  if (!pending) return { pending: null };
  return {
    pending: {
      origin: pending.origin,
      host: new URL(pending.origin).hostname,
      username: pending.username,
      isUpdate: Boolean(pending.updateId),
    },
  };
}

/** "Never for this site": remembers the pending login's host and drops the captured password. */
async function handleNeverPending(sender) {
  const pending = await getPending(sender.tab.id);
  if (pending) await addNeverSaveHost(new URL(pending.origin).hostname);
  await clearPending(sender.tab.id);
  return { ok: true };
}

async function handleSavePending(sender) {
  const pending = await getPending(sender.tab.id);
  const key = await getActiveKey();
  if (!pending || !key) return { ok: false };
  // An update only replaces the password: the entry keeps its saved URL,
  // notes and matching mode.
  const existing = pending.updateId ? (await listEntries(key)).find((entry) => entry.id === pending.updateId) : null;
  await saveEntry(key, {
    id: existing?.id,
    url: existing?.url ?? pending.origin,
    username: pending.username,
    password: pending.password,
    notes: existing?.notes ?? "",
    match: existing?.match ?? null,
    faviconPageUrl: pending.pageUrl,
  });
  await clearPending(sender.tab.id);
  // Upload right away rather than at the next alarm; a failure is recorded
  // as passwordsSyncError and retried by the regular sync cycle.
  syncPasswords(key).catch(() => {});
  return { ok: true };
}

/**
 * Routes one runtime message. Returns a promise for messages this module
 * owns, or null so background.js can try its other handlers.
 */
export function handleCredentialMessage(message, sender) {
  switch (message?.type) {
    case "cs-capture":
      return isFromContentScript(sender) ? handleCapture(message, sender) : null;
    case "cs-check-pending":
      return isFromContentScript(sender) ? handleCheckPending(sender) : null;
    case "frame-get-suggestions":
      return isFromOurFrame(sender) ? handleGetSuggestions(sender) : null;
    case "frame-fill":
      return isFromOurFrame(sender) ? handleFill(message, sender) : null;
    case "frame-get-pending":
      return isFromOurFrame(sender) ? handleGetPending(sender) : null;
    case "frame-save-pending":
      return isFromOurFrame(sender) ? handleSavePending(sender) : null;
    case "frame-never-pending":
      return isFromOurFrame(sender) ? handleNeverPending(sender) : null;
    case "frame-dismiss-pending":
      return isFromOurFrame(sender) ? clearPending(sender.tab.id).then(() => ({ ok: true })) : null;
    case "frame-close":
      return isFromOurFrame(sender) ? closeInPage(sender.tab.id, message.target).then(() => ({ ok: true })) : null;
    case "frame-open-vault":
      return isFromOurFrame(sender)
        ? chrome.tabs.create({ url: chrome.runtime.getURL("passwords/passwords.html") }).then(() => ({ ok: true }))
        : null;
    default:
      return null;
  }
}

/** Drops a tab's pending capture when the tab closes. */
export function forgetTab(tabId) {
  return clearPending(tabId);
}
