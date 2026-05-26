// Five high-impact verbs registered at boot. Each command is a thin wrapper
// over an existing store/dispatch function — never duplicate domain logic
// here.

import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { runs, agents } from "../db/schema.js";
import { dispatchAgentRun } from "../runs/dispatch.js";
import { cancelRun as engineCancelRun, isActive } from "../runs/engine.js";
import { listAll as listAllAgents } from "../agents/store.js";
import { respondToInteraction as respondToInteractionStore } from "../runs/interactions/store.js";
import { publish } from "../runs/bus.js";
import type { Agent, RunningTask } from "../types/index.js";
import { register } from "./registry.js";
import type { CommandResult } from "./types.js";

type RunAgentInput = {
  agentId: string;
  inputs?: Record<string, unknown>;
  model?: string | null;
};

type RunAgentOutput = { runId: string; task: RunningTask };

type CancelRunInput = { runId: string };

type CancelRunOutput = { ok: true; mode: "signal" | "direct" | "noop" };

type ListRunsInput = { status?: string; limit?: number };

type ListRunsOutput = RunningTask[];

type ListAgentsOutput = Agent[];

type RespondToInteractionInput = {
  runId: string;
  interactionId: string;
  answer: string;
};

type RespondToInteractionOutput = { delivered: boolean };

export function registerBuiltinCommands(): void {
  register<RunAgentInput, RunAgentOutput>({
    id: "run-agent",
    title: "Run an agent",
    description: "Start a new run of the given agent with the provided inputs.",
    inputs: [
      { name: "agentId", type: "string", required: true },
      { name: "inputs", type: "string", required: false, description: "JSON object of input values" },
      { name: "model", type: "string", required: false }
    ],
    handler: async (input): Promise<CommandResult<RunAgentOutput>> => {
      if (typeof input.agentId !== "string" || input.agentId.length === 0) {
        return { ok: false, error: "agentId required", status: 400 };
      }
      const inputs =
        input.inputs && typeof input.inputs === "object" ? input.inputs : {};
      const model =
        typeof input.model === "string" && input.model.length > 0
          ? input.model
          : null;
      const result = await dispatchAgentRun(input.agentId, inputs, model);
      if (!result.ok) {
        return { ok: false, error: result.error, status: 404 };
      }
      return { ok: true, output: { runId: result.task.id, task: result.task } };
    }
  });

  register<CancelRunInput, CancelRunOutput>({
    id: "cancel-run",
    title: "Cancel a run",
    description: "Stop an active run (SIGTERM, then SIGKILL after 1s).",
    inputs: [{ name: "runId", type: "string", required: true }],
    handler: async (input): Promise<CommandResult<CancelRunOutput>> => {
      if (typeof input.runId !== "string" || input.runId.length === 0) {
        return { ok: false, error: "runId required", status: 400 };
      }
      const rows = await db.select().from(runs).where(eq(runs.id, input.runId));
      const row = rows[0];
      if (!row) return { ok: false, error: "not_found", status: 404 };

      if (isActive(input.runId)) {
        engineCancelRun(input.runId);
        return { ok: true, output: { ok: true, mode: "signal" } };
      }
      if (row.status === "queued" || row.status === "running") {
        await db
          .update(runs)
          .set({ status: "failed", finishedAt: Date.now(), error: "aborted" })
          .where(eq(runs.id, input.runId));
        return { ok: true, output: { ok: true, mode: "direct" } };
      }
      return { ok: true, output: { ok: true, mode: "noop" } };
    }
  });

  register<ListRunsInput, ListRunsOutput>({
    id: "list-runs",
    title: "List runs",
    description: "Returns recent runs, optionally filtered by status.",
    inputs: [
      { name: "status", type: "string", required: false },
      { name: "limit", type: "number", required: false, default: 50 }
    ],
    handler: async (input): Promise<CommandResult<ListRunsOutput>> => {
      const limit = Math.min(500, Math.max(1, Number(input.limit ?? 50)));
      const status = typeof input.status === "string" ? input.status : null;
      let q = db
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
        .orderBy(desc(runs.startedAt))
        .limit(limit)
        .$dynamic();
      if (
        status === "queued" ||
        status === "running" ||
        status === "succeeded" ||
        status === "failed"
      ) {
        q = q.where(eq(runs.status, status));
      }
      const rows = await q;
      const out: RunningTask[] = rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        name: r.name || r.agentName || "(unknown)",
        status: r.status,
        progress: r.progress,
        startedAt: new Date(r.startedAt).toISOString()
      }));
      return { ok: true, output: out };
    }
  });

  register<Record<string, never>, ListAgentsOutput>({
    id: "list-agents",
    title: "List agents",
    description: "Returns every known agent (config + user).",
    inputs: [],
    handler: async (): Promise<CommandResult<ListAgentsOutput>> => {
      return { ok: true, output: await listAllAgents() };
    }
  });

  register<RespondToInteractionInput, RespondToInteractionOutput>({
    id: "respond-to-interaction",
    title: "Respond to an agent question",
    description:
      "Submit a user answer for an ask_user prompt; delivered to the agent's stdin.",
    inputs: [
      { name: "runId", type: "string", required: true },
      { name: "interactionId", type: "string", required: true },
      { name: "answer", type: "string", required: true }
    ],
    handler: async (
      input
    ): Promise<CommandResult<RespondToInteractionOutput>> => {
      if (
        typeof input.runId !== "string" ||
        typeof input.interactionId !== "string" ||
        typeof input.answer !== "string"
      ) {
        return { ok: false, error: "invalid_input", status: 400 };
      }
      const result = await respondToInteractionStore(
        input.runId,
        input.interactionId,
        input.answer
      );
      if (result.kind === "not_found") {
        return { ok: false, error: "not_found", status: 404 };
      }
      if (result.kind === "not_pending") {
        return {
          ok: false,
          error: `not_pending:${result.status}`,
          status: 409
        };
      }
      // Mirror the route's bus publication so the user_response event flows
      // out to subscribers (the UI, channels) the same way as via REST.
      publish(input.runId, {
        type: "user_response",
        payload: { interactionId: input.interactionId, answer: input.answer }
      });
      return { ok: true, output: { delivered: result.delivered } };
    }
  });
}
