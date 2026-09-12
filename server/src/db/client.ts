import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, { schema });
