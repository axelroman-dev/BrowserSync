import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { getBlob, getBlobMeta, putBlob, BlobTooLargeError, VersionConflictError, type DataType } from "../services/syncService.js";

export const syncRouter = Router();
syncRouter.use(requireAuth);

const ALL_DATA_TYPES: DataType[] = ["bookmarks", "history", "extensions", "passwords"];

/**
 * Metadata-only summary of every data type at once - what the account
 * dashboard (server/public/dashboard) polls to answer "did my last sync
 * actually save?" without fetching (let alone being able to decrypt) any
 * ciphertext. `null` for a data type means nothing has been synced yet.
 */
syncRouter.get("/status", async (req, res) => {
  const blobs = await Promise.all(ALL_DATA_TYPES.map((dataType) => getBlobMeta(req.userId!, dataType)));
  res.json({
    blobs: ALL_DATA_TYPES.map((dataType, i) => {
      const blob = blobs[i];
      return {
        dataType,
        version: blob?.version ?? null,
        sizeBytes: blob?.sizeBytes ?? null,
        clientUpdatedAt: blob?.clientUpdatedAt ?? null,
        updatedAt: blob?.updatedAt ?? null,
      };
    }),
  });
});

const putBodySchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  clientUpdatedAt: z.string().datetime(),
  // Version this client last saw; 0 means "I believe there's no blob yet".
  expectedVersion: z.number().int().min(0),
});

/**
 * The server is deliberately blob-shape-agnostic: it never inspects
 * ciphertext contents, only stores/returns it. bookmarks/history/extensions/passwords
 * all share this exact handler, which is why the public routes are
 * this thin.
 */
function registerSyncRoutes(dataType: DataType) {
  syncRouter.get(`/${dataType}`, async (req, res) => {
    const blob = await getBlob(req.userId!, dataType);
    if (!blob) {
      res.status(404).json({ error: "not_found", message: "No synced data yet." });
      return;
    }
    res.json({
      ciphertext: blob.ciphertext,
      iv: blob.iv,
      version: blob.version,
      clientUpdatedAt: blob.clientUpdatedAt,
      updatedAt: blob.updatedAt,
    });
  });

  syncRouter.post(`/${dataType}`, async (req, res) => {
    const parsed = putBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    try {
      const blob = await putBlob({
        userId: req.userId!,
        dataType,
        ciphertext: parsed.data.ciphertext,
        iv: parsed.data.iv,
        clientUpdatedAt: new Date(parsed.data.clientUpdatedAt),
        expectedVersion: parsed.data.expectedVersion,
      });
      res.json({ version: blob.version, updatedAt: blob.updatedAt });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        // 409 tells the client exactly what's on the server right now so it
        // can merge locally and retry, instead of blindly overwriting.
        res.status(409).json({
          error: "version_conflict",
          message: "Another device synced more recently. Re-fetch and merge before retrying.",
          current: {
            ciphertext: err.current.ciphertext,
            iv: err.current.iv,
            version: err.current.version,
            clientUpdatedAt: err.current.clientUpdatedAt,
          },
        });
        return;
      }
      if (err instanceof BlobTooLargeError) {
        res.status(413).json({ error: "blob_too_large", message: err.message });
        return;
      }
      throw err;
    }
  });
}

registerSyncRoutes("bookmarks");
registerSyncRoutes("history");
registerSyncRoutes("extensions");
registerSyncRoutes("passwords");
