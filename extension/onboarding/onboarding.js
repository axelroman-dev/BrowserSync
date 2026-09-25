import { wireConnectForm } from "../lib/connectForm.js";
import { PRIVACY_POLICY_URL } from "../config.js";
import { wireSetupForm, renderSetupForm } from "../lib/setupForm.js";
import { initI18n } from "../lib/i18n.js";

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

  serverStep: document.getElementById("server-step"),
  serverHost: document.getElementById("server-host"),
  changeServerLink: document.getElementById("change-server-link"),
  serverUrlInput: document.getElementById("server-url"),
  testConnectionBtn: document.getElementById("test-connection"),
  testStatus: document.getElementById("test-status"),
  healthSteps: document.getElementById("health-steps"),

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

// Last step after connecting: the same preferences as the popup's settings
// panel plus the in-page password option (see lib/setupForm.js), so a new
// install is fully set up here without hunting through the popup. The first
// sync starts on Finish (not on connect) so an unchecked "Sync browsing
// history" is respected from the very first cycle.
wireConnectForm(el, async (session) => {
  for (const view of [el.serverStep, el.form, el.savePassphraseView, el.deviceSetupView, el.firstSyncChoiceView, el.forgotPasswordView]) {
    view.hidden = true;
  }
  document.getElementById("connected-view").hidden = false;
  document.querySelector(".footer-note").hidden = true;
  document.getElementById("connected-email").textContent = session.accountEmail;
  await renderSetupForm();
});

wireSetupForm(async () => {
  // Not awaited: the service worker runs the sync to completion even
  // after this tab is gone, and the popup shows how it went.
  chrome.runtime.sendMessage({ type: "run-sync" }).catch(() => {});
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  else window.close();
});
