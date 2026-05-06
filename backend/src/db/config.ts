// DB config. Postgres is the only supported driver — see docs/postgres.md
// for the rationale (closed-network deploy, no native build chain).

export type DbConfig = {
  /** libpq connection string, e.g. "postgresql://user:pass@host:5432/db" */
  url: string;
};

export function loadDbConfig(): DbConfig {
  const url =
    process.env.DB_URL ??
    "postgresql://openshuki:openshuki@localhost:5432/openshuki";
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      `[db] DB_URL must be a postgres:// or postgresql:// URI, got: ${url}`
    );
  }
  return { url };
}
