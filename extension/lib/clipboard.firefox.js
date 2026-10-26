// Firefox version of lib/clipboard.js - the build copies it over that file
// (see scripts/build-extension.mjs). Firefox's background is an event page
// with a DOM, so it can write to the clipboard directly (the
// "clipboardWrite" permission).
export async function copyText(text) {
  await navigator.clipboard.writeText(text);
}
