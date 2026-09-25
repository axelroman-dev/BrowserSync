// Shared "connect" form logic (server step + email/password, plus the
// save-passphrase / device-setup / forgot-password sub-flows that the
// envelope-encryption design needs), used by both onboarding.js (first-run
// full tab) and popup.js (the form shown in the popup itself when logged
// out). Each caller passes references to its own DOM elements so the two
// pages can have different markup/CSS around an identical interaction.
//
// Flow overview (see auth.js for the crypto/server side of each step):
//  - Server step: always first. The user enters the server URL and it must
//    pass a health check before the login/register form is shown; the form
//    then shows the chosen host with a "Change" link back to this step.
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
import { getAllLocal } from "./storage.js";
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

function describeHealthFailure({ reason, version }) {
  switch (reason) {
    case "not_browsersync":
      return t("connectForm.healthNotBrowserSync");
    case "server_outdated":
      return version ? t("connectForm.healthServerOutdatedVersion", { version }) : t("connectForm.healthServerOutdated");
    case "extension_outdated":
      return t("connectForm.healthExtensionOutdated");
    case "unhealthy":
      return t("connectForm.healthUnhealthy");
    default:
      return t("connectForm.testStatusCouldNotConnect");
  }
}

/**
 * @param {object} el - DOM element references (see onboarding.js/popup.js for the exact set used)
 * @param {(session: any) => void} onConnected
 */
export function wireConnectForm(el, onConnected) {
  let mode = "register"; // "register" | "login"
  // Set only once the server step's health check passes - the
  // email/password form can't be reached before that.
  let currentServerUrl = "";
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

  // --- Server step (first screen): the login/register options only show
  // once the server URL has passed a health check ---
  function showServerStep() {
    el.form.hidden = true;
    el.savePassphraseView.hidden = true;
    el.deviceSetupView.hidden = true;
    el.forgotPasswordView.hidden = true;
    if (el.firstSyncChoiceView) el.firstSyncChoiceView.hidden = true;
    el.serverStep.hidden = false;
    el.testStatus.hidden = true;
    el.healthSteps.hidden = true;
    animateIn(el.serverStep);
    el.serverUrlInput.focus();
  }

  // One request answers every check, but walking through them one by one
  // (spinner -> check mark) makes the analysis visible instead of jumping
  // straight to the form. Each step fails for the checkHealth() reasons
  // listed next to it.
  const HEALTH_STEPS = [
    { label: "connectForm.healthStepConnect", fails: ["unreachable"] },
    { label: "connectForm.healthStepIdentity", fails: ["not_browsersync"] },
    { label: "connectForm.healthStepCompat", fails: ["server_outdated", "extension_outdated"] },
    { label: "connectForm.healthStepStatus", fails: ["unhealthy"] },
  ];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STEP_DELAY_MS = reducedMotion ? 80 : 380;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function addHealthStep(labelKey) {
    const li = document.createElement("li");
    li.className = "health-step running";
    const icon = document.createElement("span");
    icon.className = "health-step-icon";
    const text = document.createElement("span");
    text.textContent = t(labelKey);
    li.append(icon, text);
    el.healthSteps.append(li);
    return {
      finish(ok) {
        li.className = `health-step ${ok ? "done" : "failed"}`;
        icon.textContent = ok ? "✓" : "✕";
      },
    };
  }

  /** Animates the checklist for `healthPromise`; resolves to its result once the last step has played. */
  async function runHealthSteps(healthPromise) {
    el.healthSteps.replaceChildren();
    el.healthSteps.classList.remove("success");
    el.healthSteps.hidden = false;
    let health;
    for (const [i, step] of HEALTH_STEPS.entries()) {
      const row = addHealthStep(step.label);
      // The first step waits for the real response; the rest just pace out.
      [health] = await Promise.all([i === 0 ? healthPromise : health, sleep(STEP_DELAY_MS)]);
      const failed = !health.ok && step.fails.includes(health.reason);
      row.finish(!failed);
      if (failed) return health;
    }
    el.healthSteps.classList.add("success");
    await sleep(reducedMotion ? 0 : 450);
    return health;
  }

  let checking = false;
  el.serverStep.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (checking) return;
    const url = el.serverUrlInput.value.trim().replace(/\/+$/, "");
    el.testStatus.hidden = true;
    if (!isValidUrl(url)) {
      el.healthSteps.hidden = true;
      showTestStatus(t("connectForm.testStatusInvalidUrl"), true);
      return;
    }
    checking = true;
    el.testConnectionBtn.disabled = true;
    el.serverUrlInput.readOnly = true;
    el.testConnectionBtn.textContent = t("connectForm.healthCheckingBtn");
    try {
      const health = await runHealthSteps(checkHealth(url));
      if (!health.ok) {
        showTestStatus(describeHealthFailure(health), true);
        return;
      }
      currentServerUrl = url;
      el.serverHost.textContent = health.version ? `${new URL(url).host} (v${health.version})` : new URL(url).host;
      showMainForm();
      el.emailInput.focus();
    } finally {
      checking = false;
      el.testConnectionBtn.disabled = false;
      el.serverUrlInput.readOnly = false;
      el.testConnectionBtn.textContent = t("connectForm.testConnection");
    }
  });

  el.changeServerLink.addEventListener("click", (e) => {
    e.preventDefault();
    showServerStep();
  });

  function showTestStatus(message, isError) {
    el.testStatus.textContent = message;
    el.testStatus.className = isError ? "test-status test-status-error" : "test-status";
    el.testStatus.hidden = false;
  }

  function showMainForm() {
    el.serverStep.hidden = true;
    el.form.hidden = false;
    animateIn(el.form);
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
      el.serverStep.hidden = true;
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

  // Restarting a CSS animation needs the class removed, a reflow, then re-added.
  function animateIn(view) {
    view.classList.remove("view-enter");
    void view.offsetWidth;
    view.classList.add("view-enter");
  }

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

  // Prefill with the server this device used last (kept across logouts),
  // or the official one if it ever exists - the user still has to pass the
  // health check before seeing login/register.
  getAllLocal().then(({ serverUrl }) => {
    if (!el.serverUrlInput.value) el.serverUrlInput.value = serverUrl || OFFICIAL_SERVER_URL || "";
  });

  applyMode();
  return { showServerStep };
}
