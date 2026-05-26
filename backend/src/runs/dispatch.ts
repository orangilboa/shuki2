// Shared run-dispatch helper. Both POST /api/agents/:id/run and the
// run-agent Command call this — keeps the row insert + engine kickoff in
// one place so they can't drift.

import { db } from "../db/client.js";
import { runs } from "../db/schema.js";
import { ensureConfigAgentShadow, findById as findAgentById } from "../agents/store.js";
import { startRun } from "./engine.js";
import type { RunningTask } from "../types/index.js";

export type DispatchAgentRunResult =
  | { ok: true; task: RunningTask }
  | { ok: false; error: "agent_not_found" };

export async function dispatchAgentRun(
  agentId: string,
  inputs: unknown,
  modelOverride: string | null
): Promise<DispatchAgentRunResult> {
  const agent = await findAgentById(agentId);
  if (!agent) return { ok: false, error: "agent_not_found" };

  const model = modelOverride ?? agent.model ?? null;

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
    inputsJson: JSON.stringify(inputs ?? {}),
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

  const handle = startRun(agent.id, id, inputs ?? {}, { model });
  handle.promise.catch(() => {
    /* errors already persisted/published */
  });

  return { ok: true, task };
}
