import { wireConnectForm } from "../lib/connectForm.js";

const el = {
  form: document.getElementById("connect-form"),
  emailInput: document.getElementById("email"),
  passwordInput: document.getElementById("password"),
  submitBtn: document.getElementById("submit-btn"),
  modeSwitchLink: document.getElementById("mode-switch-link"),
  forgotPasswordLink: document.getElementById("forgot-password-link"),
  errorMessage: document.getElementById("error-message"),

  serverToggleLink: document.getElementById("server-toggle-link"),
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

  forgotPasswordView: document.getElementById("forgot-password-view"),
  forgotEmailInput: document.getElementById("forgot-email"),
  forgotPassphraseInput: document.getElementById("forgot-passphrase"),
  forgotNewPasswordInput: document.getElementById("forgot-new-password"),
  forgotError: document.getElementById("forgot-error"),
  forgotSubmitBtn: document.getElementById("forgot-submit-btn"),
  forgotCancelLink: document.getElementById("forgot-cancel-link"),
};

wireConnectForm(el, (session) => {
  for (const view of [el.form, el.savePassphraseView, el.deviceSetupView, el.forgotPasswordView]) view.hidden = true;
  document.getElementById("connected-view").hidden = false;
  document.getElementById("connected-email").textContent = session.accountEmail;
  chrome.runtime.sendMessage({ type: "refresh-alarm" });
});
