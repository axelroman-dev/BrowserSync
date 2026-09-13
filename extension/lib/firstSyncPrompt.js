// Decides whether THIS device needs to ask "merge or replace?" before its
// very first bookmark sync, and applies whichever choice the user makes.
// Used by connectForm.js right after login/registration/device-setup
// succeeds, before the first runSyncCycle() call.
//
// Why this exists: bookmarksSync.js matches nodes across devices by a
// per-device-assigned syncId, not by content. A device that already has its
// own bookmarks (e.g. it was used before BrowserSync was installed, or it's
// a fresh browser profile with some starter bookmarks) has no syncIds in
// common with an account's already-synced bookmarks, so a plain merge adds
// every synced bookmark as a new local one even when "the same" bookmark
// already exists locally - producing duplicates - while contributing every
// pre-existing local bookmark to the synced set too. Asking once, up front,
// whether to keep both (merge, accepting possible duplicates) or start fresh
// from what's already synced (replace, discarding this device's pre-existing
// bookmarks) avoids that surprise without changing the merge engine itself.
import { getAllLocal } from "./storage.js";
import { hasLocalBookmarkContent, wipeLocalBookmarksForFreshStart } from "./bookmarksSync.js";
import { getSyncBlob } from "./api.js";

export async function needsFirstSyncChoice() {
  const { bookmarksInitializedAt } = await getAllLocal();
  if (bookmarksInitializedAt) return false;
  if (!(await hasLocalBookmarkContent())) return false;
  // Only worth asking if the account already has bookmarks synced from
  // elsewhere to choose between - a brand-new account (or one that's never
  // synced bookmarks) has nothing to merge with or replace with, so there's
  // no meaningful "replace" option and no duplicate risk either.
  const remoteBlob = await getSyncBlob("bookmarks");
  return Boolean(remoteBlob);
}

export async function applyFirstSyncChoice(choice) {
  if (choice === "replace") await wipeLocalBookmarksForFreshStart();
}
