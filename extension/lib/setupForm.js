// The "Set up BrowserSync" step (history, sync interval, in-page password
// suggestions) shared by onboarding.html and the popup. Both pages use the
// same setup-* element ids. The popup shows it whenever setupCompletedAt is
// still unset, which covers closing the onboarding tab before Finish.
import { getAllLocal, setLocal } from "./storage.js";
import { HOST_ORIGINS } from "./pageCredentials.js";
import { t } from "./i18n.js";

const byId = (id) => document.getElementById(id);

export async function isSetupComplete() {
  const { setupCompletedAt } = await getAllLocal();
  return Boolean(setupCompletedAt);
}

/**
 * Wires the setup form's controls once. `onFinish` runs after the choices
 * are saved; the caller decides what comes next (closing the tab, or showing
 * the popup's status view).
 */
export function wireSetupForm(onFinish) {
  const historyEnabledInput = byId("setup-history-enabled");
  const inPageInput = byId("setup-inpage");

  historyEnabledInput.addEventListener("change", renderHistoryDays);

  // permissions.request() needs the user's click, so it runs right in the
  // checkbox's change handler; declining the Chrome prompt unticks it
  // again. In the popup, Chrome's prompt can close the popup before this
  // resolves, but the grant still happens and background.js registers the
  // content script from permissions.onAdded.
  inPageInput.addEventListener("change", async () => {
    const origins = { origins: HOST_ORIGINS };
    try {
      inPageInput.checked = inPageInput.checked
        ? await chrome.permissions.request(origins)
        : !(await chrome.permissions.remove(origins));
    } catch {
      inPageInput.checked = await chrome.permissions.contains(origins);
    }
  });

  byId("setup-finish-btn").addEventListener("click", async () => {
    const btn = byId("setup-finish-btn");
    const errorEl = byId("setup-error");
    btn.disabled = true;
    errorEl.hidden = true;
    try {
      await setLocal({
        historyEnabled: historyEnabledInput.checked,
        historyDays: Math.max(1, Number(byId("setup-history-days").value) || 90),
        syncIntervalMinutes: Math.max(5, Number(byId("setup-sync-interval").value) || 15),
        setupCompletedAt: Date.now(),
      });
      await chrome.runtime.sendMessage({ type: "refresh-alarm" });
      await chrome.runtime.sendMessage({ type: "refresh-content-scripts" });
      await onFinish();
    } catch (err) {
      errorEl.textContent = err?.message || t("common.somethingWentWrong");
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

/** Fills the form with the current settings; call each time it's shown. */
export async function renderSetupForm() {
  const settings = await getAllLocal();
  byId("setup-history-enabled").checked = settings.historyEnabled;
  byId("setup-history-days").value = settings.historyDays;
  byId("setup-sync-interval").value = settings.syncIntervalMinutes;
  byId("setup-inpage").checked = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  renderHistoryDays();
}

function renderHistoryDays() {
  byId("setup-history-days-row").hidden = !byId("setup-history-enabled").checked;
}
