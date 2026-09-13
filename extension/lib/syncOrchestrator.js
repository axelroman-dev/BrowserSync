// Shared entry point for "run a sync cycle," called both from background.js
// (on a chrome.alarms tick) and from popup.js (the manual "Sync now"
// button) so the two never duplicate this logic. Both contexts run this
// independently rather than message-passing through one another; if a
// manual sync and a scheduled one happen to race, the server's per-blob
// version check (see syncService.js on the backend) rejects the second
// write and its retry-with-merge handles the rest safely.
import { getSession, getActiveKey } from "./auth.js";
import { getAllLocal, setLocal } from "./storage.js";
import { syncBookmarks } from "./bookmarksSync.js";
import { syncHistory } from "./historySync.js";
import { syncExtensionsList } from "./extensionsList.js";
import { NetworkError, ApiError } from "./api.js";
import { needsFirstSyncChoice, applyFirstSyncChoice } from "./firstSyncPrompt.js";

function describeError(err) {
  if (err?.code === "decrypt_failed") return "Could not decrypt synced data - try unlocking again from the popup.";
  if (err instanceof NetworkError) return "Could not reach the server. Check your connection.";
  if (err instanceof ApiError && err.status === 401) return "Session expired. Please log in again.";
  if (err instanceof ApiError) return err.message || "The server rejected the sync request.";
  return err?.message || "Unknown sync error.";
}

export async function runSyncCycle() {
  const session = await getSession();
  if (!session.isLoggedIn) return { status: "skipped", reason: "not_logged_in" };
  if (!session.isUnlocked) return { status: "skipped", reason: "locked" };
  // Guards EVERY caller (manual "Sync now", the background alarm, unlock,
  // repair - not just the post-login flow in connectForm.js) against
  // silently duplicating a device's pre-existing bookmarks the first time it
  // ever syncs - see firstSyncPrompt.js for why a plain merge can't tell a
  // pre-existing local bookmark apart from a genuinely new one. The
  // background alarm has no UI to ask with, so it just skips here and waits
  // for the user to resolve it from the popup (see runSyncCycleInteractive).
  if (await needsFirstSyncChoice()) return { status: "skipped", reason: "needs_first_sync_choice" };

  const key = await getActiveKey();
  const { historyEnabled } = await getAllLocal();

  try {
    const bookmarksResult = await syncBookmarks(key);
    if (historyEnabled) await syncHistory(key);
    await syncExtensionsList(key);

    // Marks this device as past its first bookmark sync, so firstSyncPrompt.js
    // never asks the merge-or-replace question again once it's been answered
    // (or was moot because there was nothing to ask about).
    await setLocal({ lastSyncAt: Date.now(), lastSyncStatus: "ok", lastSyncError: null, bookmarksInitializedAt: Date.now() });
    return { status: "ok", bookmarksResult };
  } catch (err) {
    const message = describeError(err);
    await setLocal({ lastSyncAt: Date.now(), lastSyncStatus: "error", lastSyncError: message });
    return { status: "error", message };
  }
}

/**
 * Same as runSyncCycle(), but when this device's very first bookmark sync
 * needs the merge-or-replace choice, resolves it right here with a plain
 * confirm() dialog instead of just skipping. The nicer themed version of
 * this same question lives in connectForm.js's first-sync-choice-view and
 * covers the common case (right after login); this is the fallback for
 * every other entry point that can show UI - manual "Sync now", unlock,
 * repair - so none of them can silently duplicate bookmarks either. Only
 * call this from a page with a window (popup/onboarding/viewer), never from
 * the background service worker.
 */
export async function runSyncCycleInteractive() {
  const result = await runSyncCycle();
  if (result.status !== "skipped" || result.reason !== "needs_first_sync_choice") return result;

  const replace = confirm(
    "This device has bookmarks that have never been synced with this account.\n\n" +
      "Press OK to REPLACE this device's bookmarks with the ones already synced.\n" +
      "Press Cancel to MERGE them instead - bookmarks that exist on both sides may end up duplicated.",
  );
  await applyFirstSyncChoice(replace ? "replace" : "merge");
  return runSyncCycle();
}
