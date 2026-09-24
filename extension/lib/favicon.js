// Site icons for saved passwords, read from the browser's own favicon cache
// through the "_favicon" extension API (the "favicon" permission) - never
// fetched from the site or a third-party icon service, either of which
// would tell someone which sites are in the vault. The icon is stored as a
// small data: URL inside the (encrypted) vault entry, so the server's
// dashboard can show it too without fetching anything.
const SIZE = 32;
// A 32px icon is usually 1-3 KB; anything far bigger isn't worth syncing.
const MAX_BYTES = 8 * 1024;
// Chrome answers with a generic globe for pages it has no icon for;
// comparing against the answer for a name that can't exist tells them apart.
const UNKNOWN_PAGE = "https://browsersync.invalid/";

let genericIcon;

/** chrome-extension://…/_favicon/ URL for a page; only usable from extension pages. */
export function faviconUrl(pageUrl, size = SIZE) {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", String(size));
  return url.href;
}

async function readAsDataUrl(pageUrl) {
  const response = await fetch(faviconUrl(pageUrl));
  if (!response.ok) return null;
  const type = response.headers.get("content-type") || "image/png";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES || !type.startsWith("image/")) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${type};base64,${btoa(binary)}`;
}

/** The cached icon for a web page as a data: URL, or null when the browser has none. */
export async function fetchFavicon(pageUrl) {
  if (!/^https?:\/\//i.test(pageUrl ?? "")) return null;
  try {
    genericIcon ??= await readAsDataUrl(UNKNOWN_PAGE);
    const icon = await readAsDataUrl(pageUrl);
    return icon && icon !== genericIcon ? icon : null;
  } catch {
    return null;
  }
}

/** Only image data: URLs are ever rendered from a stored entry. */
export function isStoredFavicon(value) {
  return typeof value === "string" && value.startsWith("data:image/");
}

/**
 * An <img> for a vault entry: its stored icon, else the browser's cached one
 * (entries saved before icons were stored), else the site's first letter.
 */
export function siteIconElement(entry, className = "site-icon") {
  const fallback = () => {
    const letter = document.createElement("span");
    letter.className = `${className} site-icon-letter`;
    letter.textContent = (hostnameOf(entry.url)[0] ?? "?").toUpperCase();
    return letter;
  };
  const src = isStoredFavicon(entry.favicon)
    ? entry.favicon
    : /^https?:\/\//i.test(entry.url ?? "")
      ? faviconUrl(entry.url)
      : null;
  if (!src) return fallback();
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.src = src;
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url ?? "";
  }
}
