// History sync: much simpler than bookmarks because history entries don't
// need per-node identity/move tracking - they're just "URL was visited at
// time T, N times." We merge by URL, keeping the max lastVisitTime/
// visitCount seen on either side, and drop anything older than the
// configured retention window before uploading (so the payload doesn't
// grow forever).
//
// KNOWN LIMITATION: chrome.history.addUrl() - the only write API
// available to extensions - always records the visit as happening "now,"
// with no way to backdate it. So a history entry pulled in from another
// device will show up in this browser's own history UI as visited today,
// even though the timestamp we track internally (and re-upload) correctly
// preserves the original visit time. In practice this means: the URL
// becomes searchable/available locally (the main point of syncing history
// at all), but Chromium's native history view will show an inaccurate
// "today" for entries that originated elsewhere.
import { SYNC_PAYLOAD_VERSION } from "../config.js";
import { getAllLocal, setLocal } from "./storage.js";
import { encryptJSON, decryptJSON } from "./crypto.js";
import { getSyncBlob, putSyncBlob } from "./api.js";

async function collectLocalEntries(sinceMs) {
  const items = await chrome.history.search({ text: "", startTime: sinceMs, maxResults: 100000 });
  return items
    .filter((item) => item.url)
    .map((item) => ({
      url: item.url,
      title: item.title ?? "",
      lastVisitTime: item.lastVisitTime ?? sinceMs,
      visitCount: item.visitCount ?? 1,
    }));
}

function mergeEntries(localEntries, remoteEntries, cutoffMs) {
  const byUrl = new Map();
  for (const entry of [...remoteEntries, ...localEntries]) {
    if (entry.lastVisitTime < cutoffMs) continue; // prune anything outside the retention window
    const existing = byUrl.get(entry.url);
    if (!existing || entry.lastVisitTime > existing.lastVisitTime) {
      byUrl.set(entry.url, { ...entry, visitCount: Math.max(entry.visitCount, existing?.visitCount ?? 0) });
    }
  }
  return [...byUrl.values()];
}

export async function syncHistory(key) {
  const { historyDays } = await getAllLocal();
  const cutoffMs = Date.now() - historyDays * 24 * 60 * 60 * 1000;

  const [localEntries, remoteBlob] = await Promise.all([collectLocalEntries(cutoffMs), getSyncBlob("history")]);

  let remoteEntries = [];
  let expectedVersion = 0;
  if (remoteBlob) {
    let remotePayload;
    try {
      remotePayload = await decryptJSON(key, remoteBlob.ciphertext, remoteBlob.iv);
    } catch {
      throw Object.assign(new Error("Could not decrypt remote history. Your local data key may be out of date - try unlocking again."), {
        code: "decrypt_failed",
      });
    }
    remoteEntries = remotePayload.entries ?? [];
    expectedVersion = remoteBlob.version;
  }

  const merged = mergeEntries(localEntries, remoteEntries, cutoffMs);

  // Pull in URLs we don't have locally yet, so history becomes usable/
  // searchable across devices (see the module-level limitation note above).
  const localUrls = new Set(localEntries.map((e) => e.url));
  const newFromRemote = merged.filter((e) => !localUrls.has(e.url));
  for (const entry of newFromRemote) {
    await chrome.history.addUrl({ url: entry.url }).catch(() => {});
  }

  const payload = { version: SYNC_PAYLOAD_VERSION, entries: merged };
  const { ciphertext, iv } = await encryptJSON(key, payload);
  const result = await putSyncBlob("history", {
    ciphertext,
    iv,
    clientUpdatedAt: new Date().toISOString(),
    expectedVersion,
  });

  if (result.conflict) {
    // Same reasoning as bookmarksSync: someone wrote in between our GET and
    // POST. History merges are commutative/idempotent (union-by-url), so a
    // second attempt with the freshly merged set is safe.
    const conflictPayload = await decryptJSON(key, result.conflict.ciphertext, result.conflict.iv);
    const remerged = mergeEntries(merged, conflictPayload.entries ?? [], cutoffMs);
    const retryPayload = { version: SYNC_PAYLOAD_VERSION, entries: remerged };
    const encrypted = await encryptJSON(key, retryPayload);
    const retryResult = await putSyncBlob("history", {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      clientUpdatedAt: new Date().toISOString(),
      expectedVersion: result.conflict.version,
    });
    await setLocal({ historyBlobVersion: retryResult.version });
    return { entryCount: remerged.length };
  }

  await setLocal({ historyBlobVersion: result.version });
  return { entryCount: merged.length };
}

/** Fetches and decrypts the current remote history blob, for display only. */
export async function fetchRemoteHistory(key) {
  const blob = await getSyncBlob("history");
  if (!blob) return { entries: [], updatedAt: null };
  const payload = await decryptJSON(key, blob.ciphertext, blob.iv);
  const entries = [...(payload.entries ?? [])].sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  return { entries, updatedAt: blob.updatedAt };
}
