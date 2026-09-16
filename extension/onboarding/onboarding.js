import { wireConnectForm } from "../lib/connectForm.js";
import { PRIVACY_POLICY_URL } from "../config.js";
import { initI18n, t } from "../lib/i18n.js";

await initI18n();

document.getElementById("privacy-link").href = PRIVACY_POLICY_URL;

const el = {
  form: document.getElementById("connect-form"),
  formTitle: document.getElementById("connect-title"),
  emailInput: document.getElementById("email"),
  passwordInput: document.getElementById("password"),
  submitBtn: document.getElementById("submit-btn"),
  modeSwitchLink: document.getElementById("mode-switch-link"),
  forgotPasswordLink: document.getElementById("forgot-password-link"),
  errorMessage: document.getElementById("error-message"),

  serverToggleLink: document.getElementById("server-toggle-link"),
  serverRequiredHint: document.getElementById("server-required-hint"),
  serverSection: document.getElementById("server-section"),
  serverUrlInput: document.getElementById("server-url"),
  testConnectionBtn: document.getElementById("test-connection"),
  testStatus: document.getElementById("test-status"),

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
};

wireConnectForm(el, async (session) => {
  for (const view of [el.form, el.savePassphraseView, el.deviceSetupView, el.firstSyncChoiceView, el.forgotPasswordView]) {
    view.hidden = true;
  }
  document.getElementById("connected-view").hidden = false;
  document.getElementById("connected-email").textContent = session.accountEmail;
  await chrome.runtime.sendMessage({ type: "refresh-alarm" });

  // Unlike popup.js, this used to just sit on "You're connected" and rely on
  // the next background alarm tick (up to syncIntervalMinutes away) to
  // actually sync - so picking "replace" here wiped this device's bookmarks
  // immediately but could leave it looking empty for a long while instead of
  // repopulating them from the server right away. Run it now instead, via
  // the background service worker so it survives this tab closing.
  const statusEl = document.getElementById("connected-sync-status");
  const errorEl = document.getElementById("connected-sync-error");
  const result = await chrome.runtime.sendMessage({ type: "run-sync" });
  if (result?.status === "ok") {
    statusEl.textContent = t("onboarding.syncedOk");
  } else if (result?.status === "error") {
    statusEl.hidden = true;
    errorEl.textContent = result.message || t("onboarding.syncFailedFallback");
    errorEl.hidden = false;
  } else if (result?.status === "skipped" && result?.reason === "needs_first_sync_choice") {
    statusEl.textContent = t("onboarding.syncNeedsChoice");
  } else {
    statusEl.hidden = true;
  }
});
