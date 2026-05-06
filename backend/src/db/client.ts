// Postgres-only DB client. App code imports `db` from here; no driver
// branching, no SQLite fallback — see docs/postgres.md.

import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadDbConfig } from "./config.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export const config = loadDbConfig();

export const pool: Pool = new Pool({ connectionString: config.url });

export const db: Db = drizzle(pool, { schema });

export { schema };
