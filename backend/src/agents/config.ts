// Loader for the read-only built-in agents in config/agents.json.
//
// Mirrors src/endpoints/config.ts: file is committed, no secrets, validated
// at load time. Cached after first read; `_resetConfigAgentsCache()` for tests.

import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../types/index.js";
import { parseExecJson, parseInputsJson, AgentSpecError, validateAgentExec, validateAgentInputs } from "./spec.js";

type RawFile = {
  agents?: unknown;
};

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Validate a single config-file agent entry. Throws on malformed shapes.
 * The returned Agent has `source: "config"`.
 */
function validateOne(raw: unknown): Agent {
  if (!raw || typeof raw !== "object") {
    throw new Error("[agents/config] each agent must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!isString(obj.id) || !obj.id) {
    throw new Error("[agents/config] agent.id must be a non-empty string");
  }
  if (!isString(obj.name) || !obj.name) {
    throw new Error(`[agents/config] agent ${obj.id}: name required`);
  }
  const description = isString(obj.description) ? obj.description : "";
  let model: string | null = null;
  if (obj.model === null || obj.model === undefined) {
    model = null;
  } else if (isString(obj.model)) {
    model = obj.model.length > 0 ? obj.model : null;
  } else {
    throw new Error(`[agents/config] agent ${obj.id}: model must be string|null`);
  }
  // Re-use the strict validators so config gets the same rules as the API.
  // They throw AgentSpecError; rewrap with file context for clarity.
  let inputs;
  let exec;
  try {
    inputs = validateAgentInputs(obj.inputs);
  } catch (err) {
    const msg = err instanceof AgentSpecError ? err.message : String(err);
    throw new Error(`[agents/config] agent ${obj.id}: ${msg}`);
  }
  try {
    exec = validateAgentExec(obj.exec);
  } catch (err) {
    const msg = err instanceof AgentSpecError ? err.message : String(err);
    throw new Error(`[agents/config] agent ${obj.id}: ${msg}`);
  }
  return {
    id: obj.id,
    name: obj.name,
    description,
    model,
    inputs,
    exec,
    source: "config"
  };
}

function validateFile(raw: unknown): Agent[] {
  if (!raw || typeof raw !== "object") {
    throw new Error("[agents/config] root must be an object");
  }
  const list = (raw as RawFile).agents;
  if (!Array.isArray(list)) {
    throw new Error("[agents/config] 'agents' must be an array");
  }
  const out: Agent[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const agent = validateOne(a);
    if (seen.has(agent.id)) {
      throw new Error(`[agents/config] duplicate agent id: ${agent.id}`);
    }
    seen.add(agent.id);
    out.push(agent);
  }
  return out;
}

let cache: Agent[] | null = null;

export function loadConfigAgents(): Agent[] {
  const filePath = path.resolve(process.cwd(), "config", "agents.json");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return validateFile(raw);
}

export function getConfigAgents(): Agent[] {
  if (cache === null) cache = loadConfigAgents();
  return cache;
}

export function _resetConfigAgentsCache(): void {
  cache = null;
}

// Re-export helpers so the store doesn't need to import from spec directly
// when it's just round-tripping DB rows.
export { parseInputsJson, parseExecJson };
