import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { syncBlobs, type SyncBlob } from "../db/schema.js";
import { config } from "../config.js";

export type DataType = "bookmarks" | "history" | "extensions";

export class BlobTooLargeError extends Error {}
export class VersionConflictError extends Error {
  constructor(public current: SyncBlob) {
    super("version_conflict");
  }
}

export async function getBlob(userId: string, dataType: DataType): Promise<SyncBlob | null> {
  const [row] = await db
    .select()
    .from(syncBlobs)
    .where(and(eq(syncBlobs.userId, userId), eq(syncBlobs.dataType, dataType)))
    .limit(1);
  return row ?? null;
}

export interface PutBlobInput {
  userId: string;
  dataType: DataType;
  ciphertext: string;
  iv: string;
  clientUpdatedAt: Date;
  /** Version the client last downloaded/derived its merge from. Omitted (or 0) for a brand-new blob. */
  expectedVersion: number;
}

/**
 * Upserts the encrypted blob with optimistic concurrency: if another device
 * has already advanced the row's version past what this client saw, we
 * reject with the current row instead of silently overwriting it. The
 * client is expected to re-fetch, re-merge its local changes on top
 * (per-node last-write-wins for bookmarks), and retry the POST - see
 * lib/bookmarksSync.js on the extension side. Without this, two devices
 * syncing within the same few seconds could stomp on each other's changes
 * with the "last POST wins" version.
 */
export async function putBlob(input: PutBlobInput): Promise<SyncBlob> {
  const sizeBytes = Buffer.byteLength(input.ciphertext, "utf8");
  if (sizeBytes > config.maxBlobBytes) {
    throw new BlobTooLargeError(`Blob of ${sizeBytes} bytes exceeds limit of ${config.maxBlobBytes}`);
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(syncBlobs)
      .where(and(eq(syncBlobs.userId, input.userId), eq(syncBlobs.dataType, input.dataType)))
      .for("update");

    if (!existing) {
      const [created] = await tx
        .insert(syncBlobs)
        .values({
          userId: input.userId,
          dataType: input.dataType,
          ciphertext: input.ciphertext,
          iv: input.iv,
          version: 1,
          clientUpdatedAt: input.clientUpdatedAt,
          sizeBytes,
        })
        .returning();
      return created;
    }

    if (existing.version !== input.expectedVersion) {
      throw new VersionConflictError(existing);
    }

    const [updated] = await tx
      .update(syncBlobs)
      .set({
        ciphertext: input.ciphertext,
        iv: input.iv,
        version: existing.version + 1,
        clientUpdatedAt: input.clientUpdatedAt,
        sizeBytes,
        updatedAt: new Date(),
      })
      .where(eq(syncBlobs.id, existing.id))
      .returning();
    return updated;
  });
}
