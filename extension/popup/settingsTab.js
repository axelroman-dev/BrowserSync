// Settings tab of the popup: the handful of settings that get changed often
// (what syncs and how often, in-page passwords, autofill). Each control
// saves as soon as it changes. The rest - devices, backup, log out,
// restoring/pushing bookmarks, deleting the account - stays on the full
// settings page, linked at the bottom. Lock lives on the Sync tab.
import { getAllLocal, setLocal } from "../lib/storage.js";
import { HOST_ORIGINS } from "../lib/pageCredentials.js";
import { t } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);

function showError(message) {
  $("set-error").textContent = message ?? "";
  $("set-error").hidden = !message;
}

async function renderAutofill(inPageEnabled) {
  const { passwordAutofill } = await getAllLocal();
  $("set-autofill").value = passwordAutofill === "focus" ? "focus" : passwordAutofill ? "on" : "off";
  // Autofill rides on the in-page content script, so it's only offered while that's on.
  $("set-autofill").disabled = !inPageEnabled;
  $("set-autofill-hint").textContent = t("passwords.autofillNeedsInPage");
  $("set-autofill-hint").hidden = inPageEnabled;
}

async function render() {
  const settings = await getAllLocal();
  $("set-history-enabled").checked = settings.historyEnabled;
  $("set-history-days").value = settings.historyDays;
  $("set-history-days-row").hidden = !settings.historyEnabled;
  $("set-sync-interval").value = settings.syncIntervalMinutes;
  const inPageEnabled = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  $("set-inpage").checked = inPageEnabled;
  await renderAutofill(inPageEnabled);
}

async function saveSync() {
  await setLocal({
    historyEnabled: $("set-history-enabled").checked,
    historyDays: Math.min(3650, Math.max(1, Number($("set-history-days").value) || 90)),
    syncIntervalMinutes: Math.min(1440, Math.max(5, Number($("set-sync-interval").value) || 15)),
  });
  await chrome.runtime.sendMessage({ type: "refresh-alarm" });
  // Shows the clamped values if what was typed was out of range.
  await render();
}

for (const id of ["set-history-enabled", "set-history-days", "set-sync-interval"]) {
  $(id).addEventListener("change", saveSync);
}

// permissions.request() needs the user's click, so it's the first thing the
// change handler does. Chrome's prompt can close the popup before it
// resolves; the grant still happens and background.js registers the content
// script from permissions.onAdded.
$("set-inpage").addEventListener("change", async (e) => {
  const enable = e.target.checked;
  const origins = { origins: HOST_ORIGINS };
  showError("");
  try {
    if (enable) await chrome.permissions.request(origins);
    else await chrome.permissions.remove(origins);
  } catch (err) {
    showError(err.message);
  }
  await chrome.runtime.sendMessage({ type: "refresh-content-scripts" }).catch(() => null);
  await render();
});

$("set-autofill").addEventListener("change", async (e) => {
  const { value } = e.target;
  await setLocal({ passwordAutofill: value === "focus" ? "focus" : value === "on" });
});

/** Wires the link to the full settings page. */
export function wireSettingsTab() {
  $("more-settings-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("settings/settings.html") });
  });
}

/** Called each time the tab is opened. */
export async function showSettingsTab() {
  showError("");
  await render();
}
