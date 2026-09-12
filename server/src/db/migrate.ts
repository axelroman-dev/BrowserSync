import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

/**
 * Runs any pending SQL files in ./migrations against DATABASE_URL. Safe to
 * run every container start: drizzle tracks applied migrations in a
 * "drizzle"."__drizzle_migrations" table and skips ones already applied.
 */
async function main() {
  console.log("Running database migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations complete.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
