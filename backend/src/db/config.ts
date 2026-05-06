// Driver-agnostic DB config.
// Today: only "sqlite" is implemented. "postgres" is a planned future driver.
// Swapping drivers should be a config change (DB_DRIVER, DB_URL) — never a code change.

export type DbDriver = "sqlite" | "postgres";

export type DbConfig = {
  driver: DbDriver;
  /**
   * Connection string.
   * - sqlite:   "file:./data/openshuki.db" (the "file:" prefix is stripped)
   * - postgres: a libpq URI like "postgres://user:pass@host:5432/db"
   */
  url: string;
};

function parseDriver(raw: string | undefined): DbDriver {
  const v = (raw ?? "sqlite").toLowerCase();
  if (v === "sqlite" || v === "postgres") return v;
  throw new Error(`[db] unsupported DB_DRIVER=${raw}; expected "sqlite" | "postgres"`);
}

export function loadDbConfig(): DbConfig {
  const driver = parseDriver(process.env.DB_DRIVER);
  const url = process.env.DB_URL ?? "file:./data/openshuki.db";
  return { driver, url };
}

/**
 * Resolve a sqlite URL to a filesystem path.
 * Accepts both "file:./data/openshuki.db" and a bare path.
 */
export function sqlitePathFromUrl(url: string): string {
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}
