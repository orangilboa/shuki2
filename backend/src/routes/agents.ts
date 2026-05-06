import { Router, type Request, type Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { runs, scheduledTasks, agents } from "../db/schema.js";
import { startRun } from "../runs/engine.js";
import {
  createUserAgent,
  deleteUserAgent,
  ensureConfigAgentShadow,
  findById as findAgentById,
  isConfigAgent,
  listAll as listAllAgents,
  updateUserAgent
} from "../agents/store.js";
import { AgentSpecError, validateAgentExec, validateAgentInputs } from "../agents/spec.js";
import type { Agent, RunningTask, ScheduledTask } from "../types/index.js";

// ---------- /api/scheduled -----------------------------------------------

export const scheduledRouter: Router = Router();
scheduledRouter.get("/", async (_req: Request, res: Response) => {
  const rows = await db.select().from(scheduledTasks);
  const out: ScheduledTask[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    cron: r.cron,
    nextRun: new Date(r.nextRunAt).toISOString(),
    description: r.description
  }));
  res.json(out);
});

// ---------- /api/agents --------------------------------------------------

export const agentsRouter: Router = Router();

agentsRouter.get("/", async (_req: Request, res: Response) => {
  const out: Agent[] = await listAllAgents();
  res.json(out);
});

agentsRouter.get("/:id", async (req: Request, res: Response) => {
  const agent = await findAgentById((req.params.id as string));
  if (!agent) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(agent);
});

agentsRouter.post("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }
  let description = "";
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      res.status(400).json({ error: "invalid_description" });
      return;
    }
    description = body.description;
  }
  let model: string | null = null;
  if (body.model !== undefined) {
    if (body.model === null) {
      model = null;
    } else if (typeof body.model === "string") {
      model = body.model.length > 0 ? body.model : null;
    } else {
      res.status(400).json({ error: "invalid_model" });
      return;
    }
  }
  try {
    const inputs = validateAgentInputs(body.inputs);
    const exec = validateAgentExec(body.exec);
    const created = await createUserAgent({ name: body.name, description, model, inputs, exec });
    res.json(created);
  } catch (err) {
    if (err instanceof AgentSpecError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

agentsRouter.patch("/:id", async (req: Request, res: Response) => {
  const id = (req.params.id as string);
  if (isConfigAgent(id)) {
    res.status(403).json({ error: "config_agents_are_read_only" });
    return;
  }
  const existing = await findAgentById(id);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: {
    name?: string;
    description?: string;
    model?: string | null;
    inputs?: ReturnType<typeof validateAgentInputs>;
    exec?: ReturnType<typeof validateAgentExec>;
  } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      res.status(400).json({ error: "invalid_name" });
      return;
    }
    patch.name = body.name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      res.status(400).json({ error: "invalid_description" });
      return;
    }
    patch.description = body.description;
  }
  if (body.model !== undefined) {
    if (body.model === null) {
      patch.model = null;
    } else if (typeof body.model === "string") {
      patch.model = body.model.length > 0 ? body.model : null;
    } else {
      res.status(400).json({ error: "invalid_model" });
      return;
    }
  }
  try {
    if (body.inputs !== undefined) patch.inputs = validateAgentInputs(body.inputs);
    if (body.exec !== undefined) patch.exec = validateAgentExec(body.exec);
  } catch (err) {
    if (err instanceof AgentSpecError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const updated = await updateUserAgent(id, patch);
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

agentsRouter.delete("/:id", async (req: Request, res: Response) => {
  const id = (req.params.id as string);
  if (isConfigAgent(id)) {
    res.status(403).json({ error: "config_agents_are_read_only" });
    return;
  }
  const ok = await deleteUserAgent(id);
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.status(204).end();
});

agentsRouter.post("/:id/run", async (req: Request, res: Response) => {
  const agent = await findAgentById((req.params.id as string));
  if (!agent) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = (req.body ?? {}) as { model?: unknown; inputs?: unknown };
  // Accept either a flat body of inputs, or an explicit { inputs, model }.
  const rawInputs =
    body.inputs !== undefined
      ? body.inputs
      : (() => {
          const { model: _model, ...rest } = body;
          return rest;
        })();

  // Per-invocation model overrides the agent default.
  const requestedModel = typeof body.model === "string" && body.model.length > 0 ? body.model : null;
  const model = requestedModel ?? agent.model ?? null;

  // Config-file agents aren't in the DB; ensure a shadow row so the
  // `runs.agent_id` FK can be satisfied. Idempotent.
  if (agent.source === "config") await ensureConfigAgentShadow(agent.id);

  const id = crypto.randomUUID();
  const now = Date.now();
  const suffix = agent.exec.kind === "subprocess" ? "subprocess" : "mock";
  const name = `${agent.name} (${suffix})`;
  await db.insert(runs).values({
    id,
    agentId: agent.id,
    name,
    status: "running",
    progress: 0,
    startedAt: now,
    inputsJson: JSON.stringify(rawInputs ?? {}),
    model
  });

  const task: RunningTask = {
    id,
    agentId: agent.id,
    name,
    status: "running",
    progress: 0,
    startedAt: new Date(now).toISOString()
  };

  // Fire-and-forget: kick off the in-process run engine. Engine writes
  // terminal state to the runs row and publishes events.
  const handle = startRun(agent.id, id, rawInputs ?? {}, { model });
  handle.promise.catch(() => {
    /* errors already persisted/published */
  });

  res.json(task);
});

// ---------- /api/running -------------------------------------------------

export const runningRouter: Router = Router();
runningRouter.get("/", async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      name: runs.name,
      status: runs.status,
      progress: runs.progress,
      startedAt: runs.startedAt,
      agentName: agents.name
    })
    .from(runs)
    .leftJoin(agents, eq(runs.agentId, agents.id))
    .where(inArray(runs.status, ["queued", "running"]));

  const out: RunningTask[] = rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    name: r.name || r.agentName || "(unknown)",
    status: r.status,
    progress: r.progress,
    startedAt: new Date(r.startedAt).toISOString()
  }));
  res.json(out);
});
