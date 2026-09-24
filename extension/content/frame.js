// Runs inside the iframe that content/credentials.js injects into web
// pages: the suggestion list (?mode=suggest) and the "save this password?"
// prompt (?mode=save). It's an extension page, so the surrounding site
// can't read the usernames shown here or call these handlers - but it CAN
// try to trick the user into clicking it (make it transparent, cover it
// with a decoy, move it under the cursor). clickAllowed() below refuses
// clicks until the frame has been genuinely visible for a moment.
import { initI18n, t } from "../lib/i18n.js";
import { siteIconElement } from "../lib/favicon.js";

await initI18n();

const mode = new URLSearchParams(location.search).get("mode") === "save" ? "save" : "suggest";
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
  const unlockBtn = document.getElementById("unlock-btn");

  const response = await send({ type: "frame-get-suggestions" });
  if (response?.locked) {
    message.textContent = t("inPage.locked");
    message.hidden = false;
    unlockBtn.hidden = false;
    return;
  }
  const suggestions = response?.suggestions ?? [];
  if (!suggestions.length) {
    message.textContent = t("inPage.noneForSite", { site: hostOf(response?.origin) });
    message.hidden = false;
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
    site.textContent = suggestion.site || hostOf(response.origin);
    text.appendChild(site);
    btn.appendChild(text);
    onSafeClick(btn, () => send({ type: "frame-fill", id: suggestion.id }));
    list.appendChild(btn);
  }
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
onSafeClick(document.getElementById("unlock-btn"), () => {
  send({ type: "frame-open-vault" });
  close();
});

if (mode === "save") renderSave();
else renderSuggest();
