// Shared entry point for "run a sync cycle," called only from background.js
// - on a chrome.alarms tick, and via chrome.runtime.onMessage on behalf of
// the popup (its manual "Sync now"/"Restore from server" buttons message
// the service worker rather than importing this module directly, so the
// sync keeps running even if the popup closes mid-request - see
// background.js and popup.js). If a manual sync and a scheduled one happen
// to race, the server's per-blob version check (see syncService.js on the
// backend) rejects the second write and its retry-with-merge handles the
// rest safely.
import { getSession, getActiveKey } from "./auth.js";
import { getAllLocal, setLocal } from "./storage.js";
import { syncBookmarks } from "./bookmarksSync.js";
import { syncHistory } from "./historySync.js";
import { syncExtensionsList } from "./extensionsList.js";
import { NetworkError, ApiError } from "./api.js";
import { needsFirstSyncChoice } from "./firstSyncPrompt.js";

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
  // background alarm has no UI to ask with, so it just skips here; popup.js's
  // syncNowInteractive() surfaces it as a status-view hint pointing the user
  // at Settings -> "Restore bookmarks from server" instead (there's no good
  // way to ask a real merge-or-replace question without a proper modal -
  // window.confirm() renders clipped to the popup's small window frame, see
  // uiConfirm.js).
  if (await needsFirstSyncChoice()) return { status: "skipped", reason: "needs_first_sync_choice" };

  const key = await getActiveKey();
  const { historyEnabled } = await getAllLocal();

  try {
    const bookmarksResult = await syncBookmarks(key);
    if (historyEnabled) await syncHistory(key);
    await syncExtensionsList(key);

    // Marks this device as past its first bookmark sync, so firstSyncPrompt.js
    // never asks the merge-or-replace question again once it's been answered
    // (or was moot because there was nothing to ask about). lastSyncedAccountKey
    // records which account the syncId bookkeeping now belongs to - see
    // storage.js's clearAccountLocal and firstSyncPrompt.js.
    await setLocal({
      lastSyncAt: Date.now(),
      lastSyncStatus: "ok",
      lastSyncError: null,
      bookmarksInitializedAt: Date.now(),
      lastSyncedAccountKey: `${session.serverUrl}::${session.accountEmail}`,
    });
    return { status: "ok", bookmarksResult };
  } catch (err) {
    const message = describeError(err);
    await setLocal({ lastSyncAt: Date.now(), lastSyncStatus: "error", lastSyncError: message });
    return { status: "error", message };
  }
}
