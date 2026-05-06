// Driver-selecting DB client.
// All app code imports `db` from here. Routes never touch better-sqlite3 directly.

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { loadDbConfig, sqlitePathFromUrl, type DbConfig } from "./config.js";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;
export type RawConn = Database.Database;

function buildSqlite(cfg: DbConfig): { db: Db; rawConn: RawConn } {
  const filePath = path.resolve(process.cwd(), sqlitePathFromUrl(cfg.url));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const rawConn = new Database(filePath);
  rawConn.pragma("journal_mode = WAL");
  rawConn.pragma("foreign_keys = ON");
  const db = drizzleSqlite(rawConn, { schema });
  return { db, rawConn };
}

export const config: DbConfig = loadDbConfig();

const built = (() => {
  switch (config.driver) {
    case "sqlite":
      return buildSqlite(config);
    case "postgres":
      // TODO: implement via drizzle-orm/node-postgres + pg-core schema.
      throw new Error(
        "[db] driver=postgres not_implemented — sqlite is the only supported driver today. " +
          "Set DB_DRIVER=sqlite."
      );
    default: {
      const _exhaustive: never = config.driver;
      throw new Error(`[db] unknown driver: ${String(_exhaustive)}`);
    }
  }
})();

export const db: Db = built.db;
export const rawConn: RawConn = built.rawConn;
export { schema };
