// Service worker: owns the periodic sync alarm and the first-run onboarding
// tab. Kept intentionally thin - all real logic lives in lib/, which is
// also what the popup imports directly for its manual "Sync now" button.
import { getAllLocal } from "./lib/storage.js";
import { getSession } from "./lib/auth.js";
import { runSyncCycle } from "./lib/syncOrchestrator.js";

const SYNC_ALARM_NAME = "browsersync-periodic-sync";

async function ensureAlarm() {
  const { syncIntervalMinutes } = await getAllLocal();
  const existing = await chrome.alarms.get(SYNC_ALARM_NAME);
  if (!existing || existing.periodInMinutes !== syncIntervalMinutes) {
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: syncIntervalMinutes });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  const session = await getSession();
  if (!session.isLoggedIn) {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    runSyncCycle();
  }
});

// Lets popup.js ask the (potentially not-yet-running) service worker to
// re-read the sync interval after the user changes it in settings.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "refresh-alarm") {
    ensureAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
