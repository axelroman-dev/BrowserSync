// Clipboard writes from the background (the context menu's copy actions -
// see lib/contextMenu.js), Chromium version. A service worker has no
// clipboard access, so this goes through an offscreen document (created on
// first use). The Firefox build ships lib/clipboard.firefox.js in this
// file's place instead (see scripts/build-extension.mjs), so the package
// sent to Mozilla never contains this Chromium-only API.
const OFFSCREEN_URL = "offscreen/clipboard.html";

export async function copyText(text) {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["CLIPBOARD"],
      justification: "Copy a saved username, password or 2FA code chosen from the context menu",
    });
  } catch {
    // Already open.
  }
  await chrome.runtime.sendMessage({ target: "offscreen-clipboard", text });
}
