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
