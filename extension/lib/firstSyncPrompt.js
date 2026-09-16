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
// gives three ways out: keep both (merge, accepting possible duplicates),
// start fresh from what's already synced (replace, discarding this
// device's pre-existing bookmarks), or the reverse - keep this device's
// bookmarks and discard what's synced (keep-local) - without changing the
// merge engine itself.
import { getAllLocal, setLocal } from "./storage.js";
import { hasLocalBookmarkContent, wipeLocalBookmarksForFreshStart, tombstoneRemoteOnlyNodes } from "./bookmarksSync.js";
import { getSyncBlob } from "./api.js";
import { getActiveKey } from "./auth.js";

export async function needsFirstSyncChoice() {
  const { bookmarksInitializedAt, serverUrl, accountEmail, lastSyncedAccountKey } = await getAllLocal();
  const currentAccountKey = `${serverUrl}::${accountEmail}`;
  if (lastSyncedAccountKey && lastSyncedAccountKey !== currentAccountKey) {
    // This device's syncId bookkeeping was built for a different account
    // (or the same email on a different self-hosted server) that used to be
    // signed in here (storage.js's clearAccountLocal keeps it across a
    // logout so re-logging into the SAME account can resume cleanly) - for
    // a genuinely different account it's meaningless and would wrongly
    // suppress this check, so drop it and fall through to a real
    // first-sync evaluation for this account.
    await setLocal({ bookmarkSyncIds: {}, bookmarkTimestamps: {}, bookmarkTombstones: {}, bookmarksInitializedAt: null });
  } else if (bookmarksInitializedAt) {
    return false;
  }
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
  else if (choice === "keep-local") await tombstoneRemoteOnlyNodes(await getActiveKey());
  const { serverUrl, accountEmail } = await getAllLocal();
  // Marks the question as answered right away, independently of whether the
  // sync that follows actually succeeds - otherwise a failed/deferred first
  // sync (e.g. the alarm ticks before the user's next "Sync now") would see
  // bookmarksInitializedAt still unset and ask again, even though "merge" or
  // "replace" was already decided. runSyncCycle() also re-sets both of these
  // on every successful sync, which is harmless. lastSyncedAccountKey
  // records which account the syncId bookkeeping now belongs to, so a later
  // logout/login of this SAME account (which keeps the bookkeeping, see
  // storage.js's clearAccountLocal) doesn't trip this question again.
  await setLocal({ bookmarksInitializedAt: Date.now(), lastSyncedAccountKey: `${serverUrl}::${accountEmail}` });
}
