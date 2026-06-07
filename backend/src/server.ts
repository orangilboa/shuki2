import "dotenv/config";
import { pathToFileURL } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { conversationsRouter } from "./routes/conversations.js";
import { runningRouter, scheduledRouter, agentsRouter } from "./routes/agents.js";
import { runsRouter, eventsFirehose, interactionsRouter } from "./routes/runs.js";
import { artifactsRouter } from "./routes/artifacts.js";
import { endpointsRouter, modelsRouter } from "./routes/endpoints.js";
import { channelsRouter } from "./routes/channels.js";
import { startEnabled as startEnabledChannels, stopAll as stopAllChannels } from "./channels/runtime.js";
// Side-effect import: registers all built-in channel-kind adapters.
import "./channels/adapters/index.js";
import { commandsRouter } from "./routes/commands.js";
import { registerBuiltinCommands } from "./commands/builtin.js";
import { migrate } from "./db/migrate.js";

const PORT = Number(process.env.PORT ?? 4000);

// Build the Express app (routes + middleware) without binding a port. Exported
// so tests can mount it on an ephemeral port via `start()`.
export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use("/api/conversations", conversationsRouter);
  app.use("/api/scheduled", scheduledRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/running", runningRouter);
  app.use("/api/runs", runsRouter);
  app.use("/api/interactions", interactionsRouter);
  app.use("/api/artifacts", artifactsRouter);
  app.use("/api/endpoints", endpointsRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/channels", channelsRouter);
  app.use("/api/commands", commandsRouter);
  app.get("/api/events", eventsFirehose);

  registerBuiltinCommands();
  return app;
}

// Run schema sync + start enabled channels BEFORE accepting requests.
// Returns the bound http.Server so callers (tests) can close it.
export async function start(port: number = PORT) {
  await migrate();
  await startEnabledChannels();
  const app = createApp();
  return await new Promise<ReturnType<Express["listen"]>>((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[openshuki-backend] listening on http://localhost:${boundPort}`);
      resolve(server);
    });
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void stopAllChannels().finally(() => process.exit(0));
  });
}

// Auto-start only when invoked directly (e.g. `tsx src/server.ts`,
// `tsx watch src/server.ts`), not when imported by a test harness.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  start().catch((err: unknown) => {
    console.error("[openshuki-backend] startup failed:", err);
    process.exit(1);
  });
}
