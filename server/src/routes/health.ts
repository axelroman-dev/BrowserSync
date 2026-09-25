import { readFileSync } from "node:fs";
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const healthRouter = Router();

/** Lets the extension tell a BrowserSync server apart from any other server that answers with {"status":"ok"}. */
export const SERVICE_ID = "browsersync";

/**
 * Version of the REST API the extension talks to, separate from the release
 * version: bump API_VERSION only when a change breaks the extension, and
 * raise MIN_API_VERSION when support for older extensions is dropped. The
 * extension compares these against its own API_VERSION (extension/config.js).
 */
export const API_VERSION = 1;
export const MIN_API_VERSION = 1;

// package.json sits one level above both src/ (tsx in dev) and dist/ (the
// Docker image), so the same relative path works in both.
const SERVER_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const identity = {
  service: SERVICE_ID,
  version: SERVER_VERSION,
  apiVersion: API_VERSION,
  minApiVersion: MIN_API_VERSION,
};

/**
 * No auth required: used by Docker's HEALTHCHECK and by the extension's
 * "Test connection" step when a user points it at a self-hosted server,
 * both of which run before any login has happened.
 */
healthRouter.get("/", async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ status: "ok", ...identity });
  } catch {
    res.status(503).json({ status: "error", ...identity, message: "Database unreachable" });
  }
});
