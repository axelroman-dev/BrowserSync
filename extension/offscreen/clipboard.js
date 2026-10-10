// Offscreen document used only to write to the clipboard for the context
// menu (lib/contextMenu.js) - a service worker has no clipboard of its own.
// navigator.clipboard needs a focused document, which an offscreen one
// never is, so this uses execCommand("copy") on a textarea instead.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen-clipboard" || sender.id !== chrome.runtime.id) return false;
  const buffer = document.getElementById("buffer");
  buffer.value = message.text ?? "";
  buffer.select();
  const ok = document.execCommand("copy");
  buffer.value = "";
  sendResponse({ ok });
  return false;
});
