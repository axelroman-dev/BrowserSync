// Shared "connect" form logic (email/password + server switch, plus the
// save-passphrase / device-setup / forgot-password sub-flows that the
// envelope-encryption design needs), used by both onboarding.js (first-run
// full tab) and popup.js (the form shown in the popup itself when logged
// out). Each caller passes references to its own DOM elements so the two
// pages can have different markup/CSS around an identical interaction.
//
// Flow overview (see auth.js for the crypto/server side of each step):
//  - Register: email+password only. The passphrase is generated for the
//    user and shown exactly once, right after account creation, on the
//    "save your recovery passphrase" sub-view.
//  - Login: email+password. If this is a brand-new device (no local
//    password-wrapped key envelope yet), auth.login() reports
//    needsPassphrase and we show the "set up this device" sub-view asking
//    for the recovery passphrase, once.
//  - Forgot password: a separate small flow (email + passphrase + new
//    password) reachable from the login view.
import { OFFICIAL_SERVER_URL } from "../config.js";
import * as auth from "./auth.js";
import { checkHealth, ApiError, NetworkError } from "./api.js";
import { needsFirstSyncChoice, applyFirstSyncChoice } from "./firstSyncPrompt.js";
import { armConfirm } from "./uiConfirm.js";
import { t } from "./i18n.js";

function describeConnectError(err) {
  if (err instanceof ApiError) {
    if (err.code === "email_taken") return t("connectForm.errEmailTaken");
    if (err.code === "invalid_credentials") return t("connectForm.errInvalidCredentials");
    if (err.code === "registration_disabled") return t("connectForm.errRegistrationDisabled");
    if (err.code === "rate_limited") return t("connectForm.errRateLimited");
    return err.message;
  }
  if (err instanceof NetworkError) return t("connectForm.errNetworkServer");
  if (err instanceof auth.WrongSecretError) return err.message;
  return err.message || t("common.somethingWentWrong");
}

/**
 * @param {object} el - DOM element references (see onboarding.js/popup.js for the exact set used)
 * @param {(session: any) => void} onConnected
 */
export function wireConnectForm(el, onConnected) {
  // No officially hosted server exists yet (see config.js) - every install
  // must point at a self-hosted one, so the server-URL field starts
  // required and expanded instead of hidden behind a "default" nobody set.
  const hasOfficialServer = Boolean(OFFICIAL_SERVER_URL);

  let mode = "register"; // "register" | "login"
  let currentServerUrl = hasOfficialServer ? OFFICIAL_SERVER_URL : "";
  // true until the user opens the custom-server section and edits it - or,
  // with no official server at all, false until they test their own.
  let serverVerified = hasOfficialServer;
  // Held only in memory, only for the few seconds between a login() call
  // that needs device setup and the user submitting the passphrase for it.
  let pendingDeviceSetup = null; // { email, password, dekEnvelope }

  function applyMode() {
    if (el.formTitle) el.formTitle.textContent = mode === "register" ? t("connectForm.createAccountTitle") : t("connectForm.logInTitle");
    el.submitBtn.textContent = mode === "register" ? t("connectForm.createAccountBtn") : t("connectForm.logInBtn");
    el.modeSwitchLink.textContent =
      mode === "register" ? t("connectForm.switchToLogin") : t("connectForm.switchToRegister");
    el.forgotPasswordLink.hidden = mode !== "login";
  }

  el.modeSwitchLink.addEventListener("click", (e) => {
    e.preventDefault();
    mode = mode === "register" ? "login" : "register";
    el.errorMessage.hidden = true;
    applyMode();
  });

  el.serverToggleLink.addEventListener("click", (e) => {
    e.preventDefault();
    const willShow = el.serverSection.hidden;
    el.serverSection.hidden = !willShow;
    if (willShow) {
      el.serverUrlInput.value = currentServerUrl;
      el.serverToggleLink.textContent = t("connectForm.useDefaultServer");
    } else {
      currentServerUrl = OFFICIAL_SERVER_URL;
      serverVerified = true;
      el.serverToggleLink.textContent = t("connectForm.usingSelfHosted");
      updateSubmitEnabled();
    }
  });

  el.serverUrlInput.addEventListener("input", () => {
    serverVerified = false;
    el.testStatus.textContent = t("connectForm.testStatusNotTested");
    el.testStatus.className = "test-status";
    updateSubmitEnabled();
  });

  el.testConnectionBtn.addEventListener("click", async () => {
    const url = el.serverUrlInput.value.trim();
    if (!isValidUrl(url)) {
      el.testStatus.textContent = t("connectForm.testStatusInvalidUrl");
      el.testStatus.className = "test-status test-status-error";
      return;
    }
    el.testStatus.textContent = t("connectForm.testStatusTesting");
    el.testStatus.className = "test-status";
    const ok = await checkHealth(url);
    if (ok) {
      currentServerUrl = url;
      serverVerified = true;
      el.testStatus.textContent = t("connectForm.testStatusConnected");
      el.testStatus.className = "test-status test-status-ok";
    } else {
      serverVerified = false;
      el.testStatus.textContent = t("connectForm.testStatusCouldNotConnect");
      el.testStatus.className = "test-status test-status-error";
    }
    updateSubmitEnabled();
  });

  function updateSubmitEnabled() {
    el.submitBtn.disabled = !serverVerified;
  }

  function showMainForm() {
    el.form.hidden = false;
    el.savePassphraseView.hidden = true;
    el.deviceSetupView.hidden = true;
    el.forgotPasswordView.hidden = true;
    if (el.firstSyncChoiceView) el.firstSyncChoiceView.hidden = true;
  }

  // Gate every path that's about to call onConnected() through the
  // "this device already has bookmarks" check first - see firstSyncPrompt.js
  // for why this only ever fires on a device's genuine first bookmark sync.
  async function proceedToConnected() {
    if (el.firstSyncChoiceView && (await needsFirstSyncChoice())) {
      el.form.hidden = true;
      el.savePassphraseView.hidden = true;
      el.deviceSetupView.hidden = true;
      el.forgotPasswordView.hidden = true;
      if (el.firstSyncError) el.firstSyncError.hidden = true;
      el.firstSyncChoiceView.hidden = false;
      return;
    }
    onConnected(await auth.getSession());
  }

  el.firstSyncMergeBtn?.addEventListener("click", async () => {
    await applyFirstSyncChoice("merge");
    onConnected(await auth.getSession());
  });

  // window.confirm() renders clipped to the popup's small window frame
  // (text and buttons cut off against its edges) - see uiConfirm.js.
  const confirmReplace = el.firstSyncReplaceBtn && armConfirm(el.firstSyncReplaceBtn, t("connectForm.confirmCantBeUndone"));
  el.firstSyncReplaceBtn?.addEventListener("click", async () => {
    if (!confirmReplace()) return;
    el.firstSyncReplaceBtn.disabled = true;
    try {
      await applyFirstSyncChoice("replace");
      onConnected(await auth.getSession());
    } finally {
      el.firstSyncReplaceBtn.disabled = false;
    }
  });

  const confirmKeepLocal =
    el.firstSyncKeepLocalBtn && armConfirm(el.firstSyncKeepLocalBtn, t("connectForm.confirmCantBeUndone"));
  el.firstSyncKeepLocalBtn?.addEventListener("click", async () => {
    if (!confirmKeepLocal()) return;
    el.firstSyncKeepLocalBtn.disabled = true;
    if (el.firstSyncError) el.firstSyncError.hidden = true;
    try {
      await applyFirstSyncChoice("keep-local");
      onConnected(await auth.getSession());
    } catch (err) {
      // Unlike merge/replace, this needs the DEK to read what's currently
      // synced (see bookmarksSync.js's tombstoneRemoteOnlyNodes) and can
      // genuinely fail (e.g. decrypt_failed). el.errorMessage lives inside
      // el.form, which is hidden while this view shows - a real, visible
      // error element for this view specifically.
      if (el.firstSyncError) {
        el.firstSyncError.textContent = describeConnectError(err);
        el.firstSyncError.hidden = false;
      }
    } finally {
      el.firstSyncKeepLocalBtn.disabled = false;
    }
  });

  // --- Main email/password form ---
  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    el.errorMessage.hidden = true;

    const email = el.emailInput.value.trim();
    const password = el.passwordInput.value;
    if (!email || !password) {
      showError(t("connectForm.errFillBothFields"));
      return;
    }
    if (password.length < 8) {
      showError(t("connectForm.errPasswordTooShort"));
      return;
    }

    el.submitBtn.disabled = true;
    el.submitBtn.textContent = mode === "register" ? t("connectForm.creatingAccount") : t("connectForm.loggingIn");
    try {
      if (mode === "register") {
        const { passphrase } = await auth.register({ serverUrl: currentServerUrl, email, password });
        showSavePassphraseView(passphrase);
      } else {
        const result = await auth.login({ serverUrl: currentServerUrl, email, password });
        if (result.needsPassphrase) {
          pendingDeviceSetup = { email, password, dekEnvelope: result.dekEnvelope };
          showDeviceSetupView();
        } else {
          await proceedToConnected();
        }
      }
    } catch (err) {
      showError(describeConnectError(err));
    } finally {
      el.submitBtn.disabled = false;
      applyMode();
    }
  });

  // --- Save-passphrase sub-view (shown once, right after registration) ---
  function showSavePassphraseView(passphrase) {
    el.form.hidden = true;
    el.savePassphraseView.hidden = false;
    el.generatedPassphraseDisplay.textContent = passphrase;
    el.savedConfirmCheckbox.checked = false;
    el.continueAfterSaveBtn.disabled = true;
  }

  el.savedConfirmCheckbox.addEventListener("change", () => {
    el.continueAfterSaveBtn.disabled = !el.savedConfirmCheckbox.checked;
  });

  el.copyPassphraseBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.generatedPassphraseDisplay.textContent);
      el.copyPassphraseBtn.textContent = t("common.copied");
      setTimeout(() => (el.copyPassphraseBtn.textContent = t("common.copy")), 1500);
    } catch {
      // Clipboard permission denied or unavailable - the text is still selectable manually.
    }
  });

  el.continueAfterSaveBtn.addEventListener("click", async () => {
    await proceedToConnected();
  });

  // --- Device-setup sub-view (shown once per new device, on first login) ---
  function showDeviceSetupView() {
    el.form.hidden = true;
    el.deviceSetupView.hidden = false;
    el.deviceSetupError.hidden = true;
    el.deviceSetupPassphraseInput.value = "";
  }

  el.deviceSetupSubmitBtn.addEventListener("click", async () => {
    const passphrase = el.deviceSetupPassphraseInput.value;
    if (!passphrase) {
      el.deviceSetupError.textContent = t("connectForm.enterRecoveryPassphrase");
      el.deviceSetupError.hidden = false;
      return;
    }
    el.deviceSetupSubmitBtn.disabled = true;
    try {
      await auth.completeDeviceSetup({ ...pendingDeviceSetup, passphrase });
      pendingDeviceSetup = null;
      await proceedToConnected();
    } catch (err) {
      el.deviceSetupError.textContent = describeConnectError(err);
      el.deviceSetupError.hidden = false;
    } finally {
      el.deviceSetupSubmitBtn.disabled = false;
    }
  });

  // --- Forgot-password sub-view ---
  el.forgotPasswordLink.addEventListener("click", (e) => {
    e.preventDefault();
    el.form.hidden = true;
    el.forgotPasswordView.hidden = false;
    el.forgotError.hidden = true;
    el.forgotEmailInput.value = el.emailInput.value.trim();
    el.forgotPassphraseInput.value = "";
    el.forgotNewPasswordInput.value = "";
  });

  el.forgotCancelLink.addEventListener("click", (e) => {
    e.preventDefault();
    showMainForm();
  });

  el.forgotSubmitBtn.addEventListener("click", async () => {
    const email = el.forgotEmailInput.value.trim();
    const passphrase = el.forgotPassphraseInput.value;
    const newPassword = el.forgotNewPasswordInput.value;
    if (!email || !passphrase || !newPassword) {
      el.forgotError.textContent = t("connectForm.errFillEveryField");
      el.forgotError.hidden = false;
      return;
    }
    if (newPassword.length < 8) {
      el.forgotError.textContent = t("connectForm.errNewPasswordTooShort");
      el.forgotError.hidden = false;
      return;
    }
    el.forgotSubmitBtn.disabled = true;
    el.forgotSubmitBtn.textContent = t("connectForm.resettingBtn");
    try {
      await auth.resetPassword({ serverUrl: currentServerUrl, email, passphrase, newPassword });
      await proceedToConnected();
    } catch (err) {
      el.forgotError.textContent = describeConnectError(err);
      el.forgotError.hidden = false;
    } finally {
      el.forgotSubmitBtn.disabled = false;
      el.forgotSubmitBtn.textContent = t("connectForm.resetPasswordBtn");
    }
  });

  function showError(message) {
    el.errorMessage.textContent = message;
    el.errorMessage.hidden = false;
  }

  function isValidUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  if (!hasOfficialServer) {
    // Nothing to "toggle" - there's no default to fall back to, so just
    // show the required server field permanently and explain why.
    el.serverToggleLink.hidden = true;
    el.serverSection.hidden = false;
    if (el.serverRequiredHint) el.serverRequiredHint.hidden = false;
  }

  applyMode();
  updateSubmitEnabled();
}
