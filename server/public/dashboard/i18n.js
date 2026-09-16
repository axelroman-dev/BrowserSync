// Runtime translation for the dashboard - a parallel, independent copy of
// extension/lib/i18n.js's idea (same API shape: initI18n/t/setLanguage),
// not a shared import, because this page runs outside the extension: no
// chrome.* APIs, served over plain HTTP, own localStorage instead of
// chrome.storage. See that file's header comment for the overall design.
const SUPPORTED_LANGUAGES = ["en", "es"];
const FALLBACK_LANGUAGE = "en";
const LANGUAGE_STORAGE_KEY = "browsersync_dashboard_language";

let dictionary = {};

function normalizeLanguage(tag) {
  if (!tag) return null;
  const base = tag.toLowerCase().split("-")[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : null;
}

function getStoredLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? "auto";
  } catch {
    return "auto";
  }
}

function resolveLanguage() {
  const stored = getStoredLanguage();
  if (stored && stored !== "auto") {
    return normalizeLanguage(stored) ?? FALLBACK_LANGUAGE;
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const normalized = normalizeLanguage(tag);
    if (normalized) return normalized;
  }
  return FALLBACK_LANGUAGE;
}

function lookup(key) {
  let node = dictionary;
  for (const part of key.split(".")) {
    node = node?.[part];
    if (node === undefined) return undefined;
  }
  return typeof node === "string" ? node : undefined;
}

export function t(key, params) {
  let value = lookup(key);
  if (value === undefined) {
    console.warn(`i18n: missing key "${key}"`);
    return key;
  }
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{{${name}}}`, replacement);
    }
  }
  return value;
}

function applyToDocument(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  }
}

export function setLanguage(lang) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // localStorage unavailable (private mode, blocked site data) - the
    // reload below still applies the choice for this page load via
    // resolveLanguage()'s navigator.language fallback if storage can't hold it.
  }
  location.reload();
}

export async function initI18n() {
  const lang = resolveLanguage();
  dictionary = await fetch(`locales/${lang}.json`).then((res) => res.json());
  applyToDocument();

  const select = document.getElementById("language-select");
  if (select) {
    select.value = getStoredLanguage();
    select.addEventListener("change", () => setLanguage(select.value));
  }

  return { t, lang };
}
