// Bookmark sync engine.
//
// THE CORE PROBLEM: chrome.bookmarks node IDs are assigned locally by each
// browser profile and are NOT stable across devices - two browser profiles
// (even on different Chromium-based browsers) syncing "the same" bookmark
// will have picked different IDs for it. So we
// can't diff trees by chrome's own IDs. Instead, every node we've ever seen
// gets our OWN random `syncId` (a UUID) the first time we encounter it
// locally, persisted in chrome.storage.local (bookmarkSyncIds), and that
// syncId - not the chrome ID - is what gets embedded in the encrypted
// payload and used to match nodes across devices.
//
// The three top-level roots (Bookmarks Bar / Other Bookmarks / Mobile
// Bookmarks) are the one exception: Chromium assigns them the fixed local
// IDs "1", "2", "3" on every profile, so we can safely give them fixed,
// well-known syncIds too. That anchors the whole tree - every other node's
// syncId eventually traces back to one of these three constants.
//
// CONFLICT HANDLING (last-write-wins per node, as scoped in the project
// brief): each node's local timestamp is bumped whenever its
// (parent, kind, title, url, index) signature changes versus what we saw at
// the end of the last successful sync. When merging, whichever side has the
// newer timestamp for a given syncId wins outright for that node's fields.
//
// Known limitations of this approach (deliberately not solved here):
//  - It is NOT a CRDT. If both devices edit the same bookmark before either
//    syncs, one edit is silently discarded - there is no merge of the two
//    edits, no conflict UI, and no history of the loser.
//  - Reordering (the `index` field) is part of the LWW signature, so two
//    devices reordering the same folder around the same time will produce
//    a final order that's whichever side's snapshot happened to look newer
//    to the algorithm - not necessarily either side's intended order.
//  - Deletions are permanent tombstones with no undo other than re-adding
//    the bookmark (which creates a fresh syncId). Tombstones older than
//    TOMBSTONE_RETENTION_MS are pruned on every successful sync (see
//    pruneOldTombstones) rather than kept forever - safe as long as no
//    device goes without syncing for longer than the retention window,
//    since a tombstone dropped before every device has applied it could let
//    a device that never saw the deletion resurrect the node next time it
//    reappears in its own live tree (its own next buildLocalSnapshot() would
//    just treat it as a normal existing bookmark again).
//  - A node whose parent was deleted on one device while being edited on
//    another can end up re-parented under "Other Bookmarks" as a fallback
//    rather than disappearing - see `reparentOrphans` below.

import { SYNC_PAYLOAD_VERSION } from "../config.js";
import { getAllLocal, setLocal } from "./storage.js";
import { encryptJSON, decryptJSON } from "./crypto.js";
import { getSyncBlob, putSyncBlob } from "./api.js";

const WELL_KNOWN_ROOTS = { 1: "root-toolbar", 2: "root-other", 3: "root-mobile" };
const FALLBACK_PARENT_SYNC_ID = "root-other";
// How long a deletion tombstone is kept before being dropped from the
// payload. 90 days mirrors the server's default refresh-token TTL (see
// server/.env.example REFRESH_TOKEN_TTL_DAYS) - a device that hasn't synced
// in longer than that has already been signed out and has to fully
// reconcile via the merge/replace prompt anyway, so it was never going to
// benefit from an older tombstone still being around.
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Drops tombstones older than TOMBSTONE_RETENTION_MS from a {syncId: deletedAt} map. */
function pruneOldTombstones(tombstones) {
  const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
  const pruned = {};
  for (const [syncId, deletedAt] of Object.entries(tombstones)) {
    if (deletedAt >= cutoff) pruned[syncId] = deletedAt;
  }
  return pruned;
}

function nodeSignature(node) {
  return JSON.stringify([node.parentSyncId, node.kind, node.title, node.url ?? null, node.index]);
}

/**
 * Walks the live chrome.bookmarks tree and produces a snapshot keyed by our
 * stable syncId, assigning new syncIds for anything not seen before and
 * bumping each node's lastModified timestamp only when its signature
 * actually changed since the last snapshot we recorded.
 */
async function buildLocalSnapshot() {
  const { bookmarkSyncIds, bookmarkTimestamps, bookmarkTombstones } = await getAllLocal();
  const syncIdMap = { ...bookmarkSyncIds }; // chromeId -> syncId
  const timestamps = { ...bookmarkTimestamps }; // syncId -> {lastModified, signature}
  const tombstones = { ...bookmarkTombstones }; // syncId -> deletedAt ms
  const nodesBySyncId = new Map();
  const seenSyncIds = new Set();
  const now = Date.now();

  function syncIdFor(chromeId) {
    if (WELL_KNOWN_ROOTS[chromeId]) return WELL_KNOWN_ROOTS[chromeId];
    if (!syncIdMap[chromeId]) syncIdMap[chromeId] = crypto.randomUUID();
    return syncIdMap[chromeId];
  }

  function visit(chromeNode, parentSyncId) {
    // chromeId "0" is the invisible super-root; its direct children are the
    // three well-known roots, which we still visit but don't record.
    const isSuperRoot = chromeNode.id === "0";
    const syncId = isSuperRoot ? null : syncIdFor(chromeNode.id);

    if (!isSuperRoot) {
      const node = {
        syncId,
        parentSyncId,
        kind: chromeNode.url ? "bookmark" : "folder",
        title: chromeNode.title ?? "",
        url: chromeNode.url ?? null,
        index: chromeNode.index ?? 0,
        chromeId: chromeNode.id,
      };
      const signature = nodeSignature(node);
      const previous = timestamps[syncId];
      node.lastModified = previous && previous.signature === signature ? previous.lastModified : now;
      timestamps[syncId] = { lastModified: node.lastModified, signature };
      nodesBySyncId.set(syncId, node);
      seenSyncIds.add(syncId);
    }

    for (const child of chromeNode.children ?? []) {
      visit(child, isSuperRoot ? null : syncId);
    }
  }

  const [superRoot] = await chrome.bookmarks.getTree();
  visit(superRoot, null);

  // Anything we'd previously assigned a syncId to but no longer see in the
  // live tree was deleted locally since the last sync - tombstone it.
  for (const syncId of Object.keys(timestamps)) {
    if (!seenSyncIds.has(syncId) && !tombstones[syncId]) {
      tombstones[syncId] = now;
    }
  }

  return { nodesBySyncId, timestamps, tombstones, syncIdMap };
}

/** Serializes a snapshot into the plaintext shape that gets encrypted and uploaded. */
function toPayload(snapshot) {
  return {
    version: SYNC_PAYLOAD_VERSION,
    nodes: [...snapshot.nodesBySyncId.values()].map(({ syncId, parentSyncId, kind, title, url, index, lastModified }) => ({
      syncId,
      parentSyncId,
      kind,
      title,
      url,
      index,
      lastModified,
    })),
    tombstones: Object.entries(snapshot.tombstones).map(([syncId, deletedAt]) => ({ syncId, deletedAt })),
  };
}

/**
 * Applies the outcome of a merge to the live browser bookmark tree: creates
 * nodes that exist remotely but not locally, updates/moves ones whose
 * remote timestamp is newer, and deletes ones covered by a tombstone.
 * Mutates and returns the local syncIdMap/timestamps so they can be persisted.
 */
async function applyMergeToBrowser(local, remoteNodesBySyncId, combinedTombstones) {
  const syncIdMap = { ...local.syncIdMap };
  const timestamps = { ...local.timestamps };
  const localNodes = local.nodesBySyncId;
  // chrome.bookmarks.create()/move()/update() can and does fail mid-batch -
  // most commonly Chrome's own bookmark write-rate quota
  // (MAX_WRITE_OPERATIONS_PER_HOUR / MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE)
  // kicking in during a big restore (many creates in a row - e.g. right
  // after "replace with synced bookmarks" wipes everything and recreates it
  // all at once). The catch blocks below used to only console.warn and carry
  // on as if that node had been handled, which silently produced an
  // incomplete/reshuffled tree (a failed folder's children still get filed
  // under "Other Bookmarks" by the fallback pass further down, since their
  // real parent never got created - flattening them) while runSyncCycle()
  // reported a clean "ok". Collecting failures here lets syncBookmarks()
  // report a real error instead of lying about success.
  const failures = [];

  // 1. Deletions: anything tombstoned that still exists locally goes away.
  for (const [syncId, deletedAt] of Object.entries(combinedTombstones)) {
    const existing = localNodes.get(syncId);
    if (existing) {
      await chrome.bookmarks.remove(existing.chromeId).catch(() => {});
      localNodes.delete(syncId);
      delete timestamps[syncId];
      for (const [chromeId, sid] of Object.entries(syncIdMap)) {
        if (sid === syncId) delete syncIdMap[chromeId];
      }
    }
    timestamps[syncId] = timestamps[syncId] ?? { lastModified: deletedAt, signature: "__deleted__" };
  }

  // 2. Remote-only or remote-newer nodes need to be created/updated locally.
  //    Processed in a worklist so a parent that itself needs creating first
  //    is handled before its children (folders before their contents).
  const pending = [...remoteNodesBySyncId.values()].filter((n) => !combinedTombstones[n.syncId]);
  let progress = true;
  const skipped = [];
  while (pending.length && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const remoteNode = pending[i];
      const localNode = localNodes.get(remoteNode.syncId);

      if (localNode) {
        const localTimestamp = timestamps[remoteNode.syncId]?.lastModified ?? 0;
        if (remoteNode.lastModified > localTimestamp) {
          const parentLocal = remoteNode.parentSyncId ? localNodes.get(remoteNode.parentSyncId) : null;
          if (remoteNode.parentSyncId && !parentLocal) continue; // parent not created yet, retry next pass
          try {
            if (parentLocal && (localNode.parentSyncId !== remoteNode.parentSyncId || localNode.index !== remoteNode.index)) {
              await chrome.bookmarks.move(localNode.chromeId, { parentId: parentLocal.chromeId, index: remoteNode.index });
            }
            if (localNode.title !== remoteNode.title || localNode.url !== remoteNode.url) {
              await chrome.bookmarks.update(localNode.chromeId, { title: remoteNode.title, url: remoteNode.url ?? undefined });
            }
          } catch (err) {
            console.warn("BrowserSync: failed to apply remote update", remoteNode.syncId, err);
            failures.push({ syncId: remoteNode.syncId, title: remoteNode.title, err });
          }
          localNode.parentSyncId = remoteNode.parentSyncId;
          localNode.title = remoteNode.title;
          localNode.url = remoteNode.url;
          localNode.index = remoteNode.index;
          timestamps[remoteNode.syncId] = { lastModified: remoteNode.lastModified, signature: nodeSignature(remoteNode) };
        }
        pending.splice(i, 1);
        progress = true;
        continue;
      }

      // Node doesn't exist locally yet - create it, once its parent does.
      let parentLocal = remoteNode.parentSyncId ? localNodes.get(remoteNode.parentSyncId) : null;
      if (remoteNode.parentSyncId && !parentLocal) continue; // wait for a future pass

      try {
        const created = await chrome.bookmarks.create({
          parentId: parentLocal ? parentLocal.chromeId : undefined,
          title: remoteNode.title,
          url: remoteNode.kind === "bookmark" ? remoteNode.url ?? undefined : undefined,
          index: remoteNode.index,
        });
        syncIdMap[created.id] = remoteNode.syncId;
        localNodes.set(remoteNode.syncId, { ...remoteNode, chromeId: created.id });
        timestamps[remoteNode.syncId] = { lastModified: remoteNode.lastModified, signature: nodeSignature(remoteNode) };
      } catch (err) {
        console.warn("BrowserSync: failed to create bookmark from remote", remoteNode.syncId, err);
        failures.push({ syncId: remoteNode.syncId, title: remoteNode.title, err });
      }
      pending.splice(i, 1);
      progress = true;
    }
    skipped.length = 0;
    skipped.push(...pending);
  }

  // Anything left has a parent that will never resolve (e.g. the parent was
  // deleted elsewhere while this node was edited concurrently, OR its
  // parent's own create() failed above - see the failures tracking note) -
  // fall back to filing it under "Other Bookmarks" rather than silently
  // dropping it. Still counts as a failure: silently reparenting a node out
  // of its real folder is not the same as actually restoring it correctly.
  for (const remoteNode of skipped) {
    const fallbackParent = localNodes.get(FALLBACK_PARENT_SYNC_ID);
    try {
      const created = await chrome.bookmarks.create({
        parentId: fallbackParent?.chromeId,
        title: remoteNode.title,
        url: remoteNode.kind === "bookmark" ? remoteNode.url ?? undefined : undefined,
      });
      syncIdMap[created.id] = remoteNode.syncId;
      timestamps[remoteNode.syncId] = { lastModified: remoteNode.lastModified, signature: nodeSignature(remoteNode) };
      failures.push({ syncId: remoteNode.syncId, title: remoteNode.title, err: new Error("parent could not be resolved - filed under Other Bookmarks instead") });
    } catch (err) {
      console.warn("BrowserSync: could not recover orphaned node", remoteNode.syncId, err);
      failures.push({ syncId: remoteNode.syncId, title: remoteNode.title, err });
    }
  }

  return { syncIdMap, timestamps, failures };
}

/**
 * Runs one full bookmark sync cycle: download the current remote blob (if
 * any), decrypt it, merge with the local tree, apply remote-side changes to
 * the browser, then re-encrypt and upload the merged result. On a 409
 * version conflict the server hands back its current blob, which is merged
 * in and the write retried - see putSyncBlob in api.js.
 */
export async function syncBookmarks(key) {
  const local = await buildLocalSnapshot();
  const remoteBlob = await getSyncBlob("bookmarks");

  let remotePayload = { nodes: [], tombstones: [] };
  let expectedVersion = 0;
  if (remoteBlob) {
    try {
      remotePayload = await decryptJSON(key, remoteBlob.ciphertext, remoteBlob.iv);
    } catch {
      throw Object.assign(new Error("Could not decrypt remote bookmarks. Your local data key may be out of date - try unlocking again."), {
        code: "decrypt_failed",
      });
    }
    expectedVersion = remoteBlob.version;
  }

  const remoteNodesBySyncId = new Map(remotePayload.nodes.map((n) => [n.syncId, n]));
  let combinedTombstones = { ...local.tombstones };
  for (const t of remotePayload.tombstones ?? []) {
    if (!combinedTombstones[t.syncId]) combinedTombstones[t.syncId] = t.deletedAt;
  }
  combinedTombstones = pruneOldTombstones(combinedTombstones);

  const { syncIdMap, timestamps, failures } = await applyMergeToBrowser(local, remoteNodesBySyncId, combinedTombstones);

  // Re-snapshot after applying remote changes so the upload reflects the
  // fully merged state (local edits the remote side didn't have, plus
  // whatever we just pulled in).
  await setLocal({ bookmarkSyncIds: syncIdMap, bookmarkTimestamps: timestamps, bookmarkTombstones: combinedTombstones });
  const merged = await buildLocalSnapshot();
  const payload = toPayload(merged);
  const { ciphertext, iv } = await encryptJSON(key, payload);

  let result = await putSyncBlob("bookmarks", {
    ciphertext,
    iv,
    clientUpdatedAt: new Date().toISOString(),
    expectedVersion,
  });

  if (result.conflict) {
    // Someone else wrote in between our GET and our POST. Merge their
    // latest version in too and retry exactly once.
    const conflictPayload = await decryptJSON(key, result.conflict.ciphertext, result.conflict.iv);
    const conflictNodes = new Map(conflictPayload.nodes.map((n) => [n.syncId, n]));
    let conflictTombstones = { ...merged.tombstones };
    for (const t of conflictPayload.tombstones ?? []) {
      if (!conflictTombstones[t.syncId]) conflictTombstones[t.syncId] = t.deletedAt;
    }
    conflictTombstones = pruneOldTombstones(conflictTombstones);
    const retryState = await applyMergeToBrowser(merged, conflictNodes, conflictTombstones);
    failures.push(...retryState.failures);
    await setLocal({ bookmarkSyncIds: retryState.syncIdMap, bookmarkTimestamps: retryState.timestamps, bookmarkTombstones: conflictTombstones });
    const finalSnapshot = await buildLocalSnapshot();
    const finalPayload = toPayload(finalSnapshot);
    const encrypted = await encryptJSON(key, finalPayload);
    result = await putSyncBlob("bookmarks", {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      clientUpdatedAt: new Date().toISOString(),
      expectedVersion: result.conflict.version,
    });
    if (result.conflict) {
      // Conflicted again right after merging the first conflict in - some
      // other device is writing at the same time as us. Reporting success
      // here (the old behavior) would be a lie: our upload never actually
      // landed, `result.version` would be undefined, and the next restore
      // would pull whatever that other device wrote instead of what this
      // sync thought it had just saved - silent data loss from the user's
      // point of view. Throw instead so runSyncCycle() reports a real error
      // and the next sync (scheduled or manual) retries from scratch.
      throw Object.assign(new Error("Could not save bookmarks - another device synced at the same moment. Try syncing again."), {
        code: "sync_conflict",
      });
    }
  }

  await setLocal({ bookmarkBlobVersion: result.version });

  if (failures.length > 0) {
    // Whatever DID apply cleanly is already saved above (including to the
    // server) - don't discard that progress. But reporting plain "ok" here
    // (the old behavior) would hide that some bookmarks failed to apply -
    // most commonly Chrome's own bookmark write-rate limit kicking in during
    // a big restore - leaving a silently incomplete/reshuffled tree (see the
    // failures-tracking note in applyMergeToBrowser above). Throwing makes
    // runSyncCycle() report a real error so the user knows to retry instead
    // of trusting a green "just synced" that isn't the whole picture.
    console.warn("BrowserSync: sync completed with failures", failures);
    throw Object.assign(
      new Error(
        `Synced, but ${failures.length} bookmark(s) could not be applied (often a temporary Chrome bookmark rate limit) - try syncing again in a minute.`,
      ),
      { code: "partial_sync_failure" },
    );
  }

  return { nodeCount: merged.nodesBySyncId.size };
}

/**
 * Builds a nested tree (for read-only display, e.g. the "view synced data"
 * page) from the flat `nodes` array of a decrypted bookmarks payload. Pure
 * function - doesn't touch chrome.bookmarks or local storage, so it's safe
 * to call on a remote blob without affecting the sync engine's own state.
 */
export function buildDisplayTree(nodes) {
  const bySyncId = new Map(nodes.map((n) => [n.syncId, { ...n, children: [] }]));
  const roots = [];
  for (const node of bySyncId.values()) {
    if (node.parentSyncId && bySyncId.has(node.parentSyncId)) {
      bySyncId.get(node.parentSyncId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortByIndex = (a, b) => a.index - b.index;
  for (const node of bySyncId.values()) node.children.sort(sortByIndex);
  roots.sort(sortByIndex);
  return roots;
}

/** Fetches and decrypts the current remote bookmarks blob, for display only. */
export async function fetchRemoteBookmarksTree(key) {
  const blob = await getSyncBlob("bookmarks");
  if (!blob) return { tree: [], updatedAt: null };
  const payload = await decryptJSON(key, blob.ciphertext, blob.iv);
  return { tree: buildDisplayTree(payload.nodes ?? []), updatedAt: blob.updatedAt };
}

/**
 * True if the live bookmarks tree has anything in it beyond the three empty
 * root folders. Used by the "first sync on this device" prompt (see
 * firstSyncPrompt.js) to decide whether it's worth asking how to reconcile
 * pre-existing local bookmarks with what's already synced, before the first
 * sync on this device silently treats them all as new (see the module
 * comment at the top of this file - matching is by syncId, not content, so
 * anything pre-existing locally has no syncId in common with the synced copy
 * even if it's "the same" bookmark, and ends up duplicated instead of matched).
 */
export async function hasLocalBookmarkContent() {
  const [superRoot] = await chrome.bookmarks.getTree();
  const roots = superRoot.children ?? [];
  return roots.some((root) => (root.children ?? []).length > 0);
}

/**
 * Deletes every local bookmark/folder (keeping the three root folders
 * themselves) and clears this device's sync bookkeeping, so the very next
 * sync starts from a blank slate and simply adopts whatever's already
 * synced instead of merging pre-existing local bookmarks in. Used when the
 * user picks "replace" in the first-sync prompt.
 */
export async function wipeLocalBookmarksForFreshStart() {
  const [superRoot] = await chrome.bookmarks.getTree();
  for (const root of superRoot.children ?? []) {
    for (const child of root.children ?? []) {
      await chrome.bookmarks.removeTree(child.id).catch(() => {});
    }
  }
  await setLocal({ bookmarkSyncIds: {}, bookmarkTimestamps: {}, bookmarkTombstones: {} });
}
