// Service worker: owns the periodic sync alarm, the first-run onboarding
// tab, and (via onMessage below) running sync cycles on the popup's behalf
// so they aren't tied to the popup document's short lifetime. Kept
// intentionally thin - all real logic lives in lib/.
import { getAllLocal } from "./lib/storage.js";
import { runSyncCycle } from "./lib/syncOrchestrator.js";
import { applyFirstSyncChoice } from "./lib/firstSyncPrompt.js";
import { syncPasswords } from "./lib/passwordVault.js";
import { getSession, getActiveKey } from "./lib/auth.js";
import { handleCredentialMessage, syncContentScriptRegistration, forgetTab } from "./lib/pageCredentials.js";
import { initI18n } from "./lib/i18n.js";

// So t() (used by a handful of translated error messages deep in
// bookmarksSync.js/historySync.js/auth.js) resolves correctly for sync
// failures that happen here rather than in a page - this service worker has
// no `document`, so initI18n() only loads the dictionary here, it doesn't
// try to translate any markup (see the guard in lib/i18n.js). MV3 restarts
// this worker often (it's killed after ~30s idle), so this naturally
// re-reads the language preference on close to every wake-up rather than
// ever going stale for long.
//
// Started here (not awaited) so the fetch kicks off immediately - top-level
// await is disallowed in service workers by spec, and stricter Chromium
// builds (e.g. Helium) enforce it, unlike some Chrome versions. Every path
// below that can reach t() awaits this promise first instead.
const i18nReady = initI18n();

const SYNC_ALARM_NAME = "browsersync-periodic-sync";

async function ensureAlarm() {
  const { syncIntervalMinutes } = await getAllLocal();
  const existing = await chrome.alarms.get(SYNC_ALARM_NAME);
  if (!existing || existing.periodInMinutes !== syncIntervalMinutes) {
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: syncIntervalMinutes });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await i18nReady;
  await ensureAlarm();
  await syncContentScriptRegistration();
  const session = await getSession();
  if (!session.isLoggedIn) {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

chrome.runtime.onStartup.addListener(ensureAlarm);

// The in-page password content script is registered dynamically, only
// while the user has granted the optional host permission (see
// lib/pageCredentials.js) - and revoking it from chrome://extensions must
// stop it too, not just the vault page's own toggle.
chrome.permissions.onAdded.addListener(() => syncContentScriptRegistration());
chrome.permissions.onRemoved.addListener(() => syncContentScriptRegistration());
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    i18nReady.then(() => runSyncCycle());
  }
});

// Lets popup.js ask the (potentially not-yet-running) service worker to
// re-read the sync interval after the user changes it in settings, and lets
// it delegate the actual sync work here too (see below) - unlike a popup
// document, the service worker doesn't get torn down just because the user
// clicked away, so a sync kicked off from the popup keeps running to
// completion even if the popup closes mid-request.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // In-page suggestions and the save prompt - lib/pageCredentials.js checks
  // each sender itself and returns null for anything it doesn't own.
  const credentialResponse = handleCredentialMessage(message, sender);
  if (credentialResponse) {
    credentialResponse.then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "refresh-content-scripts") {
    syncContentScriptRegistration().then(
      (enabled) => sendResponse({ enabled }),
      (err) => sendResponse({ enabled: false, message: err?.message }),
    );
    return true;
  }
  if (message?.type === "refresh-alarm") {
    ensureAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  // Runs one plain sync cycle and reports back what happened. Used by the
  // popup instead of importing syncOrchestrator directly, so the request
  // survives the popup closing (losing focus closes it, and it isn't
  // reopened just because a promise inside it is still pending).
  if (message?.type === "run-sync") {
    i18nReady.then(() => runSyncCycle()).then(sendResponse);
    return true;
  }
  // Syncs only the password vault - sent by the vault page after every
  // edit, so a saved password reaches the server right away instead of at
  // the next alarm tick, and without the bookmarks first-sync guard in
  // runSyncCycle (vault entries merge by id, so there's nothing to
  // duplicate). Runs here rather than in the page for the same reason as
  // "run-sync": closing the tab mustn't cut the upload short.
  if (message?.type === "sync-passwords") {
    i18nReady
      .then(() => getActiveKey())
      .then((key) => (key ? syncPasswords(key) : Promise.reject(new Error("locked"))))
      .then(
        (result) => sendResponse({ status: "ok", ...result }),
        (err) => sendResponse({ status: "error", message: err?.message }),
      );
    return true;
  }
  // Resolves the merge/replace choice, then runs a sync cycle immediately
  // after - used both by the first-sync-choice buttons and by the popup's
  // manual "restore from server" button, which re-asks the same choice
  // outside the first-run flow.
  if (message?.type === "apply-first-sync-choice") {
    i18nReady
      .then(() => applyFirstSyncChoice(message.choice))
      .then(() => runSyncCycle())
      .then(sendResponse);
    return true;
  }
  return false;
});
