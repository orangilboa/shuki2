// Lightweight startup syncer for SQLite.
//
// Choice: we use a custom additive-only syncer instead of `drizzle-kit push`.
// Reasons: drizzle-kit's programmatic API is unstable and meant to be called
// from its own CLI; spawning the CLI on every dev boot is slow and noisy. For
// our scaffold "create tables, add columns, add indexes" is sufficient.
//
// Behaviour:
//   - CREATE TABLE IF NOT EXISTS for every drizzle table.
//   - PRAGMA table_info to find missing columns; ALTER TABLE ADD COLUMN them.
//   - CREATE INDEX IF NOT EXISTS for every declared index.
//   - Never drops or rewrites; safe to run on every boot.

import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { rawConn, config, schema } from "./client.js";

function columnDdl(col: AnySQLiteColumn): string {
  const parts: string[] = [`"${col.name}"`, col.getSQLType().toUpperCase()];
  if (col.primary) parts.push("PRIMARY KEY");
  if (col.notNull) parts.push("NOT NULL");
  const def = (col as { default?: unknown; defaultFn?: unknown }).default;
  if (def !== undefined && def !== null) {
    if (typeof def === "object" && def !== null && "queryChunks" in (def as object)) {
      // a drizzle SQL chunk (like our nowMs) — let SQLite evaluate it.
      // We can't easily stringify SQL chunks here, so we leave it out of the
      // CREATE TABLE; the application-side $defaultFn / sql default will apply
      // on insert. Acceptable for additive scaffolding.
    } else if (typeof def === "string") {
      parts.push(`DEFAULT '${def.replace(/'/g, "''")}'`);
    } else if (typeof def === "number" || typeof def === "boolean") {
      parts.push(`DEFAULT ${Number(def)}`);
    }
  }
  return parts.join(" ");
}

type IndexInfo = { name: string; columns: string[]; unique: boolean };

function extractIndexes(idxBuilders: readonly unknown[]): IndexInfo[] {
  const out: IndexInfo[] = [];
  for (const b of idxBuilders) {
    const cfg = (b as { config?: { name: string; columns: AnySQLiteColumn[]; unique?: boolean } })
      .config;
    if (!cfg) continue;
    out.push({
      name: cfg.name,
      columns: cfg.columns.map((c) => c.name),
      unique: Boolean(cfg.unique)
    });
  }
  return out;
}

function syncTable(table: SQLiteTable): void {
  const cfg = getTableConfig(table);
  const tableName = cfg.name;

  const colDefs = cfg.columns.map(columnDdl);
  const fkDefs = cfg.foreignKeys.map((fk) => {
    const ref = fk.reference();
    const from = ref.columns.map((c) => `"${c.name}"`).join(", ");
    const to = ref.foreignColumns.map((c) => `"${c.name}"`).join(", ");
    const refTable = getTableConfig(ref.foreignTable).name;
    const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : "";
    return `FOREIGN KEY (${from}) REFERENCES "${refTable}"(${to})${onDelete}`;
  });

  const create = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n  ${[...colDefs, ...fkDefs].join(
    ",\n  "
  )}\n)`;
  rawConn.exec(create);

  // Add missing columns (additive only).
  const existing = rawConn
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all() as { name: string }[];
  const have = new Set(existing.map((r) => r.name));
  for (const col of cfg.columns) {
    if (!have.has(col.name)) {
      const ddl = columnDdl(col).replace(" PRIMARY KEY", ""); // can't add PK after the fact
      rawConn.exec(`ALTER TABLE "${tableName}" ADD COLUMN ${ddl}`);
    }
  }

  // Indexes.
  for (const idx of extractIndexes(cfg.indexes)) {
    const u = idx.unique ? "UNIQUE " : "";
    const cols = idx.columns.map((c) => `"${c}"`).join(", ");
    rawConn.exec(
      `CREATE ${u}INDEX IF NOT EXISTS "${idx.name}" ON "${tableName}" (${cols})`
    );
  }
}

// One-time pre-sync renames for the tools→agents terminology shift. Idempotent:
// runs only when the legacy table/column exists and the new one does not.
function preSyncRenames(): void {
  const tables = rawConn
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const have = new Set(tables.map((t) => t.name));
  if (have.has("tools") && !have.has("agents")) {
    rawConn.exec(`ALTER TABLE "tools" RENAME TO "agents"`);
  }
  if (have.has("runs")) {
    const cols = rawConn.prepare(`PRAGMA table_info("runs")`).all() as { name: string }[];
    const colSet = new Set(cols.map((c) => c.name));
    if (colSet.has("tool_id") && !colSet.has("agent_id")) {
      rawConn.exec(`ALTER TABLE "runs" RENAME COLUMN "tool_id" TO "agent_id"`);
    }
  }
  // Drop the obsolete index name; the new sync will recreate "runs_agent_id_idx".
  rawConn.exec(`DROP INDEX IF EXISTS "runs_tool_id_idx"`);
}

export function migrate(): void {
  const tables: SQLiteTable[] = (Object.values(schema) as unknown[]).filter(
    (v): v is SQLiteTable => v instanceof SQLiteTable
  );

  rawConn.exec("BEGIN");
  try {
    preSyncRenames();
    for (const t of tables) syncTable(t);
    rawConn.exec("COMMIT");
  } catch (err) {
    rawConn.exec("ROLLBACK");
    throw err;
  }

  console.log(`[db] sync complete (${config.driver}, ${tables.length} tables)`);
}
