// Domain logic for agent ↔ user interactions.
//
// Lifecycle:
//   - createInteraction(): insert row with status='pending'.
//   - respondToInteraction(): mark answered, deliver to live agent over stdin.
//   - cancelPendingForRun(): on process exit, flip pending rows to 'cancelled'.
//
// The actual stdin write lives in the runner, which registers a writer
// callback here when it spawns the child. The runner deregisters on process
// exit so writes don't go to a closed pipe.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  agentInteractions,
  type AgentInteractionRow
} from "../../db/schema.js";
import type {
  AgentInteraction,
  AgentInteractionStatus,
  UserResponseEventPayload
} from "../../types/index.js";

export type InteractionWriter = (payload: UserResponseEventPayload) => boolean;

// runId -> writer that delivers a user_response into the live agent process.
const writers = new Map<string, InteractionWriter>();

export function registerWriter(runId: string, writer: InteractionWriter): void {
  writers.set(runId, writer);
}

export function unregisterWriter(runId: string): void {
  writers.delete(runId);
}

function rowToInteraction(r: AgentInteractionRow): AgentInteraction {
  let choices: string[] | null = null;
  if (r.choicesJson) {
    try {
      const parsed = JSON.parse(r.choicesJson);
      if (
        Array.isArray(parsed) &&
        parsed.every((x) => typeof x === "string")
      ) {
        choices = parsed as string[];
      }
    } catch {
      // ignore — bad data, treat as no choices
    }
  }
  return {
    id: r.id,
    runId: r.runId,
    prompt: r.prompt,
    choices,
    status: r.status as AgentInteractionStatus,
    answer: r.answer,
    createdAt: new Date(r.createdAt).toISOString(),
    answeredAt: r.answeredAt ? new Date(r.answeredAt).toISOString() : null
  };
}

export type CreateInteractionArgs = {
  // The agent supplies the id so it can match the response on its side.
  // We trust whatever uuid-shaped string it provides.
  id: string;
  runId: string;
  prompt: string;
  choices?: string[] | null;
};

export async function createInteraction(
  args: CreateInteractionArgs
): Promise<AgentInteraction> {
  const choicesJson =
    args.choices && args.choices.length > 0
      ? JSON.stringify(args.choices)
      : null;
  await db.insert(agentInteractions).values({
    id: args.id,
    runId: args.runId,
    prompt: args.prompt,
    choicesJson,
    status: "pending",
    answer: null
  });
  const rows = await db
    .select()
    .from(agentInteractions)
    .where(eq(agentInteractions.id, args.id));
  const row = rows[0];
  if (!row) throw new Error("interaction insert returned no row");
  return rowToInteraction(row);
}

export async function findById(
  id: string
): Promise<AgentInteraction | null> {
  const rows = await db
    .select()
    .from(agentInteractions)
    .where(eq(agentInteractions.id, id));
  const row = rows[0];
  return row ? rowToInteraction(row) : null;
}

export async function listByRun(
  runId: string,
  opts: { status?: AgentInteractionStatus } = {}
): Promise<AgentInteraction[]> {
  const where = opts.status
    ? and(
        eq(agentInteractions.runId, runId),
        eq(agentInteractions.status, opts.status)
      )
    : eq(agentInteractions.runId, runId);
  const rows = await db
    .select()
    .from(agentInteractions)
    .where(where)
    .orderBy(asc(agentInteractions.createdAt));
  return rows.map(rowToInteraction);
}

export async function listAllPending(): Promise<AgentInteraction[]> {
  const rows = await db
    .select()
    .from(agentInteractions)
    .where(eq(agentInteractions.status, "pending"))
    .orderBy(desc(agentInteractions.createdAt));
  return rows.map(rowToInteraction);
}

export type RespondResult =
  | { kind: "ok"; interaction: AgentInteraction; delivered: boolean }
  | { kind: "not_found" }
  | { kind: "not_pending"; status: AgentInteractionStatus };

export async function respondToInteraction(
  runId: string,
  interactionId: string,
  answer: string
): Promise<RespondResult> {
  const rows = await db
    .select()
    .from(agentInteractions)
    .where(
      and(
        eq(agentInteractions.id, interactionId),
        eq(agentInteractions.runId, runId)
      )
    );
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  if (row.status !== "pending") {
    return {
      kind: "not_pending",
      status: row.status as AgentInteractionStatus
    };
  }

  await db
    .update(agentInteractions)
    .set({
      status: "answered",
      answer,
      answeredAt: Date.now()
    })
    .where(eq(agentInteractions.id, interactionId));

  const updated = await findById(interactionId);
  if (!updated) return { kind: "not_found" };

  // Try to deliver to the live agent. The route layer treats this as
  // best-effort: if the writer is missing or fails, the row is still marked
  // answered so the UI updates, but the agent will not receive the answer.
  const writer = writers.get(runId);
  let delivered = false;
  if (writer) {
    try {
      delivered = writer({ interactionId, answer });
    } catch {
      delivered = false;
    }
  }

  return { kind: "ok", interaction: updated, delivered };
}

export async function cancelPendingForRun(runId: string): Promise<number> {
  // Capture which rows we're about to flip so we can return a count without
  // a second query (Postgres `update().returning()` would also work, but we
  // keep the surface narrow).
  const pending = await db
    .select({ id: agentInteractions.id })
    .from(agentInteractions)
    .where(
      and(
        eq(agentInteractions.runId, runId),
        eq(agentInteractions.status, "pending")
      )
    );
  if (pending.length === 0) return 0;
  await db
    .update(agentInteractions)
    .set({ status: "cancelled", answeredAt: Date.now() })
    .where(
      inArray(
        agentInteractions.id,
        pending.map((r) => r.id)
      )
    );
  return pending.length;
}
