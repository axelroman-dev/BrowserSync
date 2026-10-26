// The few places where Chromium and Firefox differ, detected from what the
// running browser actually provides rather than from the user agent. The
// same source tree ships to both (see scripts/build-extension.mjs, which
// only rewrites the manifest); everything else in lib/ uses the chrome.*
// namespace, which Firefox implements with promises too.

/** This extension's own base URL - chrome-extension://<id>/ or moz-extension://<uuid>/. */
export const EXTENSION_ORIGIN = chrome.runtime.getURL("");

export const IS_FIREFOX = EXTENSION_ORIGIN.startsWith("moz-extension:");

// chrome.offscreen is Chromium-only; Firefox's background is an event page
// with its own DOM, so it can write to the clipboard directly.
export const HAS_OFFSCREEN = Boolean(chrome.offscreen);

// The "_favicon" extension endpoint (the "favicon" permission) is
// Chromium-only; Firefox has no equivalent that doesn't fetch from the site.
export const HAS_FAVICON_API = !IS_FIREFOX;

// The browser's built-in top-level bookmark folders, by local ID, mapped to
// the fixed syncIds every device agrees on (see lib/bookmarksSync.js).
// Chromium always uses "1"/"2"/"3"; Firefox uses fixed GUIDs and has a
// fourth root, the Bookmarks Menu, which Chromium doesn't have - there it
// becomes a plain folder inside Other Bookmarks.
export const BOOKMARK_ROOTS = IS_FIREFOX
  ? { toolbar_____: "root-toolbar", unfiled_____: "root-other", mobile______: "root-mobile", menu________: "root-menu" }
  : { 1: "root-toolbar", 2: "root-other", 3: "root-mobile" };

export const MENU_ROOT_SYNC_ID = "root-menu";
export const ROOT_SYNC_IDS = new Set(["root-toolbar", "root-other", "root-mobile", MENU_ROOT_SYNC_ID]);

/** Local ID of the browser's own "Other Bookmarks" folder. */
export const OTHER_BOOKMARKS_ID = IS_FIREFOX ? "unfiled_____" : "2";
