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

export function listAll(): Agent[] {
  const config = getConfigAgents().slice().sort(byName);
  const userRows = db
    .select()
    .from(agentsTable)
    .orderBy(asc(agentsTable.name))
    .all();
  const seen = new Set(config.map((a) => a.id));
  const user = userRows
    .map(rowToAgent)
    .filter((a) => !seen.has(a.id))
    .sort(byName);
  return [...config, ...user];
}

export function findById(id: string): Agent | null {
  const cfg = getConfigAgents().find((a) => a.id === id);
  if (cfg) return cfg;
  const row = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
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

export function createUserAgent(input: CreateUserAgentInput): Agent {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.insert(agentsTable)
    .values({
      id,
      name: input.name,
      description: input.description ?? "",
      inputsJson: inputsToJson(input.inputs ?? []),
      execJson: execToJson(input.exec ?? { kind: "mock" }),
      model: input.model ?? null,
      createdAt: now
    })
    .run();
  const row = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
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

export function updateUserAgent(id: string, patch: PatchUserAgentInput): Agent | null {
  const existing = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
  if (!existing) return null;

  const next: Partial<AgentRow> = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.inputs !== undefined) next.inputsJson = inputsToJson(patch.inputs);
  if (patch.exec !== undefined) next.execJson = execToJson(patch.exec);

  if (Object.keys(next).length > 0) {
    db.update(agentsTable).set(next).where(eq(agentsTable.id, id)).run();
  }
  const after = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
  if (!after) return null;
  return rowToAgent(after);
}

export function deleteUserAgent(id: string): boolean {
  const existing = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
  if (!existing) return false;
  // The `runs.agent_id` FK has no ON DELETE clause in the schema. Delete the
  // dependent runs first; their `run_events` cascade away automatically.
  db.delete(runsTable).where(eq(runsTable.agentId, id)).run();
  db.delete(agentsTable).where(eq(agentsTable.id, id)).run();
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
export function ensureConfigAgentShadow(id: string): void {
  const cfg = getConfigAgents().find((a) => a.id === id);
  if (!cfg) return;
  const existing = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
  if (existing) return;
  db.insert(agentsTable)
    .values({
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      inputsJson: inputsToJson(cfg.inputs),
      execJson: execToJson(cfg.exec),
      model: cfg.model,
      createdAt: Date.now()
    })
    .run();
}
