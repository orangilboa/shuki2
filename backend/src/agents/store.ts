// CRUD for user-added agents + merge logic for the config-file built-ins.
//
// Mirrors src/endpoints/store.ts. Conflict policy: same `id` in both sources →
// config wins.

import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { runs as runsTable, agents as agentsTable, type Agent as AgentRow } from "../db/schema.js";
import type { Agent, AgentExec, AgentInput } from "../types/index.js";
import { getConfigAgents } from "./config.js";
import { execToJson, inputsToJson, parseExecJson, parseInputsJson } from "./spec.js";

function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    model: r.model ?? null,
    inputs: parseInputsJson(r.inputsJson),
    exec: parseExecJson(r.execJson),
    source: "user"
  };
}

function byName(a: Agent, b: Agent): number {
  return a.name.localeCompare(b.name);
}

export async function listAll(): Promise<Agent[]> {
  const config = getConfigAgents().slice().sort(byName);
  const userRows = await db
    .select()
    .from(agentsTable)
    .orderBy(asc(agentsTable.name));
  const seen = new Set(config.map((a) => a.id));
  const user = userRows
    .map(rowToAgent)
    .filter((a) => !seen.has(a.id))
    .sort(byName);
  return [...config, ...user];
}

export async function findById(id: string): Promise<Agent | null> {
  const cfg = getConfigAgents().find((a) => a.id === id);
  if (cfg) return cfg;
  const rows = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  const row = rows[0];
  if (!row) return null;
  return rowToAgent(row);
}

export type CreateUserAgentInput = {
  name: string;
  description?: string;
  model?: string | null;
  inputs?: AgentInput[];
  exec?: AgentExec;
};

export async function createUserAgent(input: CreateUserAgentInput): Promise<Agent> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(agentsTable).values({
    id,
    name: input.name,
    description: input.description ?? "",
    inputsJson: inputsToJson(input.inputs ?? []),
    execJson: execToJson(input.exec ?? { kind: "mock" }),
    model: input.model ?? null,
    createdAt: now
  });
  const rows = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  const row = rows[0];
  if (!row) throw new Error("[agents/store] insert vanished");
  return rowToAgent(row);
}

export type PatchUserAgentInput = {
  name?: string;
  description?: string;
  // string => set; null => clear; undefined => leave alone
  model?: string | null;
  inputs?: AgentInput[];
  exec?: AgentExec;
};

export async function updateUserAgent(
  id: string,
  patch: PatchUserAgentInput
): Promise<Agent | null> {
  const existingRows = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, id));
  if (existingRows.length === 0) return null;

  const next: Partial<AgentRow> = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.inputs !== undefined) next.inputsJson = inputsToJson(patch.inputs);
  if (patch.exec !== undefined) next.execJson = execToJson(patch.exec);

  if (Object.keys(next).length > 0) {
    await db.update(agentsTable).set(next).where(eq(agentsTable.id, id));
  }
  const afterRows = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, id));
  const after = afterRows[0];
  if (!after) return null;
  return rowToAgent(after);
}

export async function deleteUserAgent(id: string): Promise<boolean> {
  const existingRows = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, id));
  if (existingRows.length === 0) return false;
  // The `runs.agent_id` FK has no ON DELETE clause in the schema. Delete the
  // dependent runs first; their `run_events` cascade away automatically.
  await db.delete(runsTable).where(eq(runsTable.agentId, id));
  await db.delete(agentsTable).where(eq(agentsTable.id, id));
  return true;
}

export function isConfigAgent(id: string): boolean {
  return getConfigAgents().some((a) => a.id === id);
}

/**
 * Ensure the `agents` DB row exists for a config-file agent so that the
 * `runs.agent_id` FK is satisfied when a run is launched. Idempotent.
 *
 * The shadow row is a minimal stand-in (id + name); the authoritative source
 * remains `config/agents.json`. We don't keep the shadow in sync on edits to
 * the config file because the API never serves the shadow — it always serves
 * the merged listing where config wins.
 */
export async function ensureConfigAgentShadow(id: string): Promise<void> {
  const cfg = getConfigAgents().find((a) => a.id === id);
  if (!cfg) return;
  // Use Postgres ON CONFLICT for atomic idempotency — avoids a race where two
  // concurrent runs both see "no row" and both try to insert.
  await db
    .insert(agentsTable)
    .values({
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      inputsJson: inputsToJson(cfg.inputs),
      execJson: execToJson(cfg.exec),
      model: cfg.model,
      createdAt: Date.now()
    })
    .onConflictDoNothing({ target: agentsTable.id });
}
