// Installed-extension list: metadata only, for reference across your own
// devices ("what did I have installed on the other machine?") - explicitly
// NOT auto-installed/applied anywhere. We only ever upload IDs + names, and
// only ever read the remote list back for display; nothing here calls
// chrome.management to install/enable/disable anything.
import { SYNC_PAYLOAD_VERSION } from "../config.js";
import { setLocal } from "./storage.js";
import { encryptJSON, decryptJSON } from "./crypto.js";
import { getSyncBlob, putSyncBlob } from "./api.js";

async function collectLocalExtensions() {
  const all = await chrome.management.getAll();
  return all
    .filter((ext) => ext.type === "extension")
    .map((ext) => ({ id: ext.id, name: ext.name, enabled: ext.enabled }));
}

export async function syncExtensionsList(key) {
  const [localExtensions, remoteBlob] = await Promise.all([collectLocalExtensions(), getSyncBlob("extensions")]);

  const expectedVersion = remoteBlob?.version ?? 0;
  const payload = { version: SYNC_PAYLOAD_VERSION, extensions: localExtensions };
  const { ciphertext, iv } = await encryptJSON(key, payload);
  const result = await putSyncBlob("extensions", {
    ciphertext,
    iv,
    clientUpdatedAt: new Date().toISOString(),
    expectedVersion,
  });

  if (result.conflict) {
    // This device's own install list is authoritative for itself; on a
    // conflict we simply overwrite with our current list at the version the
    // server actually has now. There's nothing to "merge" - it's a snapshot.
    const retryResult = await putSyncBlob("extensions", {
      ciphertext,
      iv,
      clientUpdatedAt: new Date().toISOString(),
      expectedVersion: result.conflict.version,
    });
    await setLocal({ extensionsBlobVersion: retryResult.version });
    return { extensionCount: localExtensions.length };
  }

  await setLocal({ extensionsBlobVersion: result.version });
  return { extensionCount: localExtensions.length };
}

/**
 * Fetches and decrypts the current remote extensions blob, for display only.
 * Note this reflects whichever device synced most recently - each sync
 * overwrites the whole list with that device's own installed extensions,
 * there's no cross-device merge (see the module comment above).
 */
export async function fetchRemoteExtensions(key) {
  const blob = await getSyncBlob("extensions");
  if (!blob) return { extensions: [], updatedAt: null };
  const payload = await decryptJSON(key, blob.ciphertext, blob.iv);
  return { extensions: payload.extensions ?? [], updatedAt: blob.updatedAt };
}
