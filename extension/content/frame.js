// Runs inside the iframe that content/credentials.js injects into web
// pages: the suggestion list (?mode=suggest) and the "save this password?"
// prompt (?mode=save). It's an extension page, so the surrounding site
// can't read the usernames shown here or call these handlers - but it CAN
// try to trick the user into clicking it (make it transparent, cover it
// with a decoy, move it under the cursor). clickAllowed() below refuses
// clicks until the frame has been genuinely visible for a moment.
import { initI18n, t } from "../lib/i18n.js";
import { siteIconElement } from "../lib/favicon.js";
import { generatePassword, loadGeneratorOptions } from "../lib/passwordGenerator.js";

await initI18n();

const params = new URLSearchParams(location.search);
// "unlock": the context menu's password prompt - just the unlock form, closed once unlocked.
const mode = ["save", "unlock"].includes(params.get("mode")) ? params.get("mode") : "suggest";
// "otp": opened from a verification-code field - lists entries with a 2FA secret and fills the current code.
const kind = params.get("kind") === "otp" ? "otp" : "login";
// Opened from a password field: also offer a generated password.
const offerGenerate = params.get("generate") === "1";
const openedAt = performance.now();
const MIN_VISIBLE_MS = 500;

// IntersectionObserver v2: isVisible is false whenever anything covers this
// frame or an ancestor makes it transparent, filtered or transformed.
// Browsers without it fall back to just the open delay.
let visibleSince = null;
let visibilityTracked = false;
try {
  const observer = new IntersectionObserver(
    (records) => {
      const record = records[records.length - 1];
      if (!record.isVisible) visibleSince = null;
      else if (visibleSince === null) visibleSince = performance.now();
    },
    { trackVisibility: true, delay: 100 },
  );
  observer.observe(document.body);
  visibilityTracked = "isVisible" in IntersectionObserverEntry.prototype;
} catch {
  visibilityTracked = false;
}

function clickAllowed(event) {
  if (!event.isTrusted) return false;
  const now = performance.now();
  if (now - openedAt < MIN_VISIBLE_MS) return false;
  if (!visibilityTracked) return true;
  return visibleSince !== null && now - visibleSince >= MIN_VISIBLE_MS;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function onSafeClick(el, handler) {
  el.addEventListener("click", (event) => {
    if (clickAllowed(event)) handler(event);
  });
}

function close() {
  send({ type: "frame-close", target: mode });
}

onSafeClick(document.getElementById("close-btn"), () => {
  if (mode === "save") send({ type: "frame-dismiss-pending" });
  close();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
});

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin ?? "";
  }
}

async function renderSuggest() {
  document.getElementById("suggest-view").hidden = false;
  const list = document.getElementById("suggestions");
  const message = document.getElementById("suggest-message");

  const response = await send({ type: "frame-get-suggestions", kind });
  if (response?.locked) {
    message.textContent = t("inPage.locked");
    message.classList.add("compact");
    message.hidden = false;
    showUnlockForm();
    return;
  }
  message.classList.remove("compact");
  const suggestions = response?.suggestions ?? [];
  if (!suggestions.length) {
    message.textContent = t(kind === "otp" ? "inPage.noCodesForSite" : "inPage.noneForSite", { site: hostOf(response?.origin) });
    message.hidden = false;
    if (kind === "login") document.getElementById("add-btn").hidden = false;
    return;
  }
  for (const suggestion of suggestions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion";
    btn.appendChild(siteIconElement(suggestion));
    const text = document.createElement("span");
    text.className = "suggestion-text";
    text.textContent = suggestion.username || t("passwords.noUsername");
    const site = document.createElement("small");
    site.textContent = kind === "otp" ? t("inPage.codeFor", { site: suggestion.site || hostOf(response.origin) }) : suggestion.site || hostOf(response.origin);
    text.appendChild(site);
    btn.appendChild(text);
    onSafeClick(btn, () => send({ type: "frame-fill", id: suggestion.id, kind }));
    list.appendChild(btn);
  }
}

// Generated here, in the extension's own document, and only sent to the
// page once the user clicks "Fill" - the site never sees the alternatives.
function renderGenerate() {
  document.getElementById("generate-section").hidden = false;
  const row = document.getElementById("generated-row");
  const output = document.getElementById("generated-password");
  let password = "";
  async function regenerate() {
    ({ password } = await generatePassword(await loadGeneratorOptions()));
    output.textContent = password;
    output.title = password;
  }
  onSafeClick(document.getElementById("generate-btn"), async (event) => {
    event.currentTarget.hidden = true;
    await regenerate();
    row.hidden = false;
  });
  onSafeClick(document.getElementById("regenerate-btn"), regenerate);
  onSafeClick(document.getElementById("use-generated-btn"), () => {
    if (password) send({ type: "frame-fill-generated", password });
  });
}

async function renderSave() {
  document.getElementById("save-view").hidden = false;
  const { pending } = (await send({ type: "frame-get-pending" })) ?? {};
  if (!pending) {
    close();
    return;
  }
  const site = hostOf(pending.origin);
  document.getElementById("save-title").textContent = pending.isUpdate
    ? t("inPage.updateTitle", { site })
    : t("inPage.saveTitle", { site });
  document.getElementById("save-username").textContent = pending.username || t("passwords.noUsername");
  const saveBtn = document.getElementById("save-btn");
  saveBtn.textContent = pending.isUpdate ? t("inPage.update") : t("passwords.save");

  onSafeClick(saveBtn, async () => {
    saveBtn.disabled = true;
    const result = await send({ type: "frame-save-pending" });
    if (result?.ok) {
      saveBtn.textContent = t("inPage.saved");
      setTimeout(close, 900);
    } else {
      saveBtn.disabled = false;
      document.getElementById("save-username").textContent = t("inPage.saveFailed");
    }
  });
  const neverBtn = document.getElementById("never-btn");
  neverBtn.textContent = t("inPage.neverForSite");
  neverBtn.title = t("inPage.neverForHost", { host: pending.host });
  onSafeClick(neverBtn, async () => {
    await send({ type: "frame-never-pending" });
    close();
  });
  onSafeClick(document.getElementById("dismiss-btn"), async () => {
    await send({ type: "frame-dismiss-pending" });
    close();
  });
}

onSafeClick(document.getElementById("manage-btn"), () => {
  send({ type: "frame-open-vault" });
  close();
});
// Opens the popup's add form in its own small window, for this site.
onSafeClick(document.getElementById("add-btn"), () => {
  send({ type: "frame-add-login" });
  close();
});
// Locked: the password is typed into this frame (an extension page the site
// can't read) and unlocked in place, then the frame closes so the user is
// back on the page - no separate tab or window.
let unlockWired = false;
function showUnlockForm() {
  const form = document.getElementById("unlock-form");
  const input = document.getElementById("unlock-password");
  const errorEl = document.getElementById("unlock-error");
  const submit = document.getElementById("unlock-submit");
  form.hidden = false;
  input.focus();
  if (unlockWired) return;
  unlockWired = true;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Enter in the field is fine; a click on the button gets the same
    // anti-clickjacking check as every other button here.
    if (!event.isTrusted || (event.submitter && !clickAllowed(event))) return;
    if (!input.value) {
      errorEl.textContent = t("common.enterPassword");
      errorEl.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = t("common.unlocking");
    const result = await send({ type: "frame-unlock", password: input.value }).catch(() => null);
    input.value = "";
    submit.disabled = false;
    submit.textContent = t("common.unlock");
    if (!result?.ok) {
      if (result?.error === "no_local_envelope") {
        // Needs the recovery passphrase: that flow lives in the full page.
        send({ type: "frame-open-vault" });
        close();
        return;
      }
      errorEl.textContent = result?.message || t("common.couldNotUnlock");
      errorEl.hidden = false;
      input.focus();
      return;
    }
    // Unlocked: get out of the way so the user is straight back on the page.
    close();
  });
}

/** mode=unlock: the suggest view cut down to the locked message and the password form. */
async function renderUnlock() {
  const response = await send({ type: "frame-get-suggestions", kind: "login" });
  // Already unlocked (from the popup, say) since the menu was built.
  if (!response?.locked) return close();
  document.getElementById("suggest-view").hidden = false;
  document.querySelector("#suggest-view .footer").hidden = true;
  const message = document.getElementById("suggest-message");
  message.textContent = t("inPage.locked");
  message.classList.add("compact");
  message.hidden = false;
  showUnlockForm();
}

if (mode === "save") renderSave();
else if (mode === "unlock") renderUnlock();
else {
  if (offerGenerate) renderGenerate();
  renderSuggest();
}
