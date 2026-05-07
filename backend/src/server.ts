import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { conversationsRouter } from "./routes/conversations.js";
import { runningRouter, scheduledRouter, agentsRouter } from "./routes/agents.js";
import { runsRouter, eventsFirehose, interactionsRouter } from "./routes/runs.js";
import { artifactsRouter } from "./routes/artifacts.js";
import { endpointsRouter, modelsRouter } from "./routes/endpoints.js";
import { migrate } from "./db/migrate.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);

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
app.get("/api/events", eventsFirehose);

// Run schema sync BEFORE we start accepting requests.
async function start(): Promise<void> {
  await migrate();
  app.listen(PORT, () => {
    console.log(`[openshuki-backend] listening on http://localhost:${PORT}`);
  });
}

start().catch((err: unknown) => {
  console.error("[openshuki-backend] startup failed:", err);
  process.exit(1);
});
