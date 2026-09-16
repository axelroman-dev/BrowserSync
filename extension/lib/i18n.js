// Runtime translation for every page this extension renders itself (popup,
// onboarding, viewer, devices) — separate from chrome.i18n/_locales, which
// only covers the name/description Chrome shows in chrome://extensions and
// can't be switched at runtime by our own UI. Dictionaries live in
// extension/locales/<lang>.json (fetched, not bundled), so adding a language
// later is just adding a JSON file plus an <option>, no code changes.
import { getAllLocal, setLocal } from "./storage.js";

const SUPPORTED_LANGUAGES = ["en", "es"];
const FALLBACK_LANGUAGE = "en";

let dictionary = {};

function normalizeLanguage(tag) {
  if (!tag) return null;
  const base = tag.toLowerCase().split("-")[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : null;
}

async function resolveLanguage() {
  const { language } = await getAllLocal();
  if (language && language !== "auto") {
    return normalizeLanguage(language) ?? FALLBACK_LANGUAGE;
  }
  return normalizeLanguage(chrome.i18n.getUILanguage()) ?? FALLBACK_LANGUAGE;
}

function lookup(key) {
  let node = dictionary;
  for (const part of key.split(".")) {
    node = node?.[part];
    if (node === undefined) return undefined;
  }
  return typeof node === "string" ? node : undefined;
}

/** Dot-path translation lookup with {{placeholder}} interpolation. Falls back to the key itself if missing, so a gap is visible instead of blank. */
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
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.setAttribute("title", t(el.dataset.i18nTitle));
  }
}

/** Persists the chosen language ("auto"/"en"/"es") and reloads this document so every piece of already-rendered dynamic text (not just data-i18n statics) re-derives in the new language. */
export async function setLanguage(lang) {
  await setLocal({ language: lang });
  location.reload();
}

/**
 * Resolves the active language, loads its dictionary, translates every
 * data-i18n* element already in the document, and wires up any
 * #language-select found on the page. Call this before a page's own
 * render()/init() so nothing briefly flashes in English.
 */
export async function initI18n() {
  const lang = await resolveLanguage();
  const url = chrome.runtime.getURL(`locales/${lang}.json`);
  dictionary = await fetch(url).then((res) => res.json());
  // Guarded because this same module is also loaded by background.js (the
  // service worker) so that t() works for errors thrown during a
  // background-triggered sync - and a service worker has no `document` at
  // all, only the dictionary-loading part above applies there.
  if (typeof document !== "undefined") {
    applyToDocument();

    const select = document.getElementById("language-select");
    if (select) {
      const { language } = await getAllLocal();
      select.value = language ?? "auto";
      select.addEventListener("change", () => setLanguage(select.value));
    }
  }

  return { t, lang };
}
