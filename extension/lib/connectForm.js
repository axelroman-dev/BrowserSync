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

function describeConnectError(err) {
  if (err instanceof ApiError) {
    if (err.code === "email_taken") return "An account with this email already exists. Try logging in instead.";
    if (err.code === "invalid_credentials") return "Email, password, or recovery passphrase is incorrect.";
    if (err.code === "registration_disabled") return "This server isn't accepting new accounts right now. Ask your admin.";
    if (err.code === "rate_limited") return "Too many attempts. Wait a few minutes and try again.";
    return err.message;
  }
  if (err instanceof NetworkError) return "Could not reach that server. Check the URL and your connection.";
  if (err instanceof auth.WrongSecretError) return err.message;
  return err.message || "Something went wrong.";
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
    el.submitBtn.textContent = mode === "register" ? "Create account" : "Log in";
    el.modeSwitchLink.textContent =
      mode === "register" ? "Already have an account? Log in" : "New here? Create an account";
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
      el.serverToggleLink.textContent = "Use the default server instead";
    } else {
      currentServerUrl = OFFICIAL_SERVER_URL;
      serverVerified = true;
      el.serverToggleLink.textContent = "Using a self-hosted server?";
      updateSubmitEnabled();
    }
  });

  el.serverUrlInput.addEventListener("input", () => {
    serverVerified = false;
    el.testStatus.textContent = "not tested";
    el.testStatus.className = "test-status";
    updateSubmitEnabled();
  });

  el.testConnectionBtn.addEventListener("click", async () => {
    const url = el.serverUrlInput.value.trim();
    if (!isValidUrl(url)) {
      el.testStatus.textContent = "invalid URL";
      el.testStatus.className = "test-status test-status-error";
      return;
    }
    el.testStatus.textContent = "testing...";
    el.testStatus.className = "test-status";
    const ok = await checkHealth(url);
    if (ok) {
      currentServerUrl = url;
      serverVerified = true;
      el.testStatus.textContent = "connected";
      el.testStatus.className = "test-status test-status-ok";
    } else {
      serverVerified = false;
      el.testStatus.textContent = "could not connect";
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
  }

  // --- Main email/password form ---
  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    el.errorMessage.hidden = true;

    const email = el.emailInput.value.trim();
    const password = el.passwordInput.value;
    if (!email || !password) {
      showError("Please fill in both fields.");
      return;
    }
    if (password.length < 8) {
      showError("Password must be at least 8 characters.");
      return;
    }

    el.submitBtn.disabled = true;
    el.submitBtn.textContent = mode === "register" ? "Creating account..." : "Logging in...";
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
          onConnected(await auth.getSession());
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
      el.copyPassphraseBtn.textContent = "Copied!";
      setTimeout(() => (el.copyPassphraseBtn.textContent = "Copy"), 1500);
    } catch {
      // Clipboard permission denied or unavailable - the text is still selectable manually.
    }
  });

  el.continueAfterSaveBtn.addEventListener("click", async () => {
    onConnected(await auth.getSession());
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
      el.deviceSetupError.textContent = "Enter your recovery passphrase.";
      el.deviceSetupError.hidden = false;
      return;
    }
    el.deviceSetupSubmitBtn.disabled = true;
    try {
      await auth.completeDeviceSetup({ ...pendingDeviceSetup, passphrase });
      pendingDeviceSetup = null;
      onConnected(await auth.getSession());
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
      el.forgotError.textContent = "Please fill in every field.";
      el.forgotError.hidden = false;
      return;
    }
    if (newPassword.length < 8) {
      el.forgotError.textContent = "New password must be at least 8 characters.";
      el.forgotError.hidden = false;
      return;
    }
    el.forgotSubmitBtn.disabled = true;
    el.forgotSubmitBtn.textContent = "Resetting...";
    try {
      await auth.resetPassword({ serverUrl: currentServerUrl, email, passphrase, newPassword });
      onConnected(await auth.getSession());
    } catch (err) {
      el.forgotError.textContent = describeConnectError(err);
      el.forgotError.hidden = false;
    } finally {
      el.forgotSubmitBtn.disabled = false;
      el.forgotSubmitBtn.textContent = "Reset password";
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
