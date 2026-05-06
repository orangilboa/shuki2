import { Router, type Request, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { runs, agents } from "../db/schema.js";
import { replay, subscribe, subscribeAll } from "../runs/bus.js";
import { cancelRun, isActive } from "../runs/engine.js";
import type { RunEventEnvelope } from "../runs/events.js";
import { listArtifactsForRun } from "./artifacts.js";

const HEARTBEAT_MS = 15_000;

function rowToTask(r: {
  id: string;
  agentId: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  model: string | null;
  agentName: string | null;
}) {
  return {
    id: r.id,
    agentId: r.agentId,
    name: r.name || r.agentName || "(unknown)",
    status: r.status,
    progress: r.progress,
    startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
    error: r.error,
    model: r.model
  };
}

function setupSse(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // CORS preflight is already handled by the cors() middleware globally.
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function writeEvent(res: Response, env: RunEventEnvelope): void {
  // Each SSE message: `event: run_event\ndata: <json>\n\n`
  res.write(`event: run_event\n`);
  res.write(`data: ${JSON.stringify(env)}\n\n`);
}

function writeHeartbeat(res: Response): void {
  res.write(`: heartbeat ${Date.now()}\n\n`);
}

export const runsRouter: Router = Router();

// ---------- list / detail ------------------------------------------------

runsRouter.get("/", (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  let q = db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      name: runs.name,
      status: runs.status,
      progress: runs.progress,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      error: runs.error,
      model: runs.model,
      agentName: agents.name
    })
    .from(runs)
    .leftJoin(agents, eq(runs.agentId, agents.id))
    .orderBy(desc(runs.startedAt))
    .$dynamic();

  if (status === "running" || status === "queued" || status === "succeeded" || status === "failed") {
    q = q.where(eq(runs.status, status));
  }

  const rows = q.all();
  res.json(rows.map(rowToTask));
});

runsRouter.get("/:id", (req: Request, res: Response) => {
  const r = db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      name: runs.name,
      status: runs.status,
      progress: runs.progress,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      error: runs.error,
      model: runs.model,
      agentName: agents.name
    })
    .from(runs)
    .leftJoin(agents, eq(runs.agentId, agents.id))
    .where(eq(runs.id, req.params.id))
    .get();
  if (!r) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToTask(r));
});

// ---------- per-run SSE --------------------------------------------------

runsRouter.get("/:id/events", async (req: Request, res: Response) => {
  const runId = req.params.id;
  const exists = db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get();
  if (!exists) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  setupSse(req, res);

  // Replay everything we have on disk first.
  const history = await replay(runId);
  let lastSeq = 0;
  for (const ev of history) {
    writeEvent(res, ev);
    if (ev.seq > lastSeq) lastSeq = ev.seq;
  }

  // Then subscribe live. Drop any duplicate that snuck in between replay and
  // subscribe (race window: an event published while we were replaying).
  const unsub = subscribe(runId, (ev) => {
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    writeEvent(res, ev);
  });

  const hb = setInterval(() => writeHeartbeat(res), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(hb);
    unsub();
    res.end();
  });
});

// ---------- artifacts (per-run list) -------------------------------------

runsRouter.get("/:id/artifacts", listArtifactsForRun);

// ---------- cancel -------------------------------------------------------

runsRouter.post("/:id/cancel", (req: Request, res: Response) => {
  const runId = req.params.id;
  const row = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (isActive(runId)) {
    cancelRun(runId);
    res.json({ ok: true, mode: "signal" });
    return;
  }

  // Run isn't active in this process — flip it to failed directly if it
  // wasn't already terminal.
  if (row.status === "queued" || row.status === "running") {
    db.update(runs)
      .set({ status: "failed", finishedAt: Date.now(), error: "aborted" })
      .where(eq(runs.id, runId))
      .run();
    res.json({ ok: true, mode: "direct" });
    return;
  }
  res.json({ ok: true, mode: "noop", status: row.status });
});

// ---------- firehose handler (mounted at /api/events) -------------------

export function eventsFirehose(req: Request, res: Response): void {
  setupSse(req, res);

  const unsub = subscribeAll((ev) => writeEvent(res, ev));
  const hb = setInterval(() => writeHeartbeat(res), HEARTBEAT_MS);

  // Initial comment line so EventSource sees the connection open immediately.
  res.write(`: connected ${Date.now()}\n\n`);

  req.on("close", () => {
    clearInterval(hb);
    unsub();
    res.end();
  });
}
