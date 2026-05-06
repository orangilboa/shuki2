import type { Config } from "drizzle-kit";

// Used by `npm run db:push` for manual ad-hoc schema work.
// Runtime startup uses src/db/migrate.ts directly — see that file.
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/openshuki.db"
  },
  strict: false,
  verbose: true
} satisfies Config;
