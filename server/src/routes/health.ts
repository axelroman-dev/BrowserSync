import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const healthRouter = Router();

/**
 * No auth required: used by Docker's HEALTHCHECK and by the extension's
 * "Test connection" button when a user points it at a self-hosted server,
 * both of which run before any login has happened.
 */
healthRouter.get("/", async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "error", message: "Database unreachable" });
  }
});
