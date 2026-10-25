import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

// An idle client whose connection drops (Postgres restarting, an admin
// terminating backends, a network blip) emits 'error' on the pool. With no
// listener that's an unhandled 'error' event and the whole server process
// exits. Log it instead: pg has already discarded the broken client, the
// next query opens a fresh connection, and any in-flight query still
// rejects on its own and becomes a 500 through the error handler.
pool.on("error", (err) => {
  console.error("Idle database connection lost:", err.message);
});

export const db = drizzle(pool, { schema });
