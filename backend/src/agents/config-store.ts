// Persistent per-agent onboarding configuration.
//
// One JSON blob per agent (the agent declares its own shape via the
// `onboarding` spec). Unlike endpoints/agents this is NOT a two-source
// catalog — there is no config-file half; the *spec* is declarative on the
// agent definition, the *answers* live here.
//
// Three write paths feed this table:
//   - the onboarding UI (PUT /api/agents/:id/config) -> setConfig
//   - the run engine reads it (getConfig) and injects it into the subprocess
//   - the agent grows it mid-run via `config_patch` events -> mergeConfigPatch

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentConfig } from "../db/schema.js";
import { ensureConfigAgentShadow, isConfigAgent } from "./store.js";

export type AgentConfigObject = Record<string, unknown>;

// Shape an agent emits in a `config_patch` event. `set` shallow-overwrites
// scalar keys; `append` unions string values into array-valued keys (the
// "learn over time" primitive — e.g. append a subject to `alwaysOverride`).
export type ConfigPatch = {
  set?: Record<string, unknown>;
  append?: Record<string, string[]>;
};

function parse(json: string | null | undefined): AgentConfigObject {
  if (!json) return {};
  try {
    const raw = JSON.parse(json);
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as AgentConfigObject)
      : {};
  } catch {
    return {};
  }
}

export async function getConfig(agentId: string): Promise<AgentConfigObject> {
  const rows = await db
    .select()
    .from(agentConfig)
    .where(eq(agentConfig.agentId, agentId));
  return parse(rows[0]?.configJson);
}

// Upsert the full config object. Ensures the shadow agents row exists first so
// the `agent_config.agent_id` FK resolves for built-in (config) agents.
export async function setConfig(
  agentId: string,
  obj: AgentConfigObject
): Promise<AgentConfigObject> {
  if (isConfigAgent(agentId)) await ensureConfigAgentShadow(agentId);
  const now = Date.now();
  const configJson = JSON.stringify(obj ?? {});
  await db
    .insert(agentConfig)
    .values({ agentId, configJson, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: agentConfig.agentId,
      set: { configJson, updatedAt: now }
    });
  return parse(configJson);
}

// Merge a `config_patch` into the stored config. `set` overwrites; `append`
// unions (dedupes) string values into the existing array at that key.
export async function mergeConfigPatch(
  agentId: string,
  patch: ConfigPatch
): Promise<AgentConfigObject> {
  const current = await getConfig(agentId);
  const next: AgentConfigObject = { ...current };

  if (patch.set && typeof patch.set === "object") {
    for (const [k, v] of Object.entries(patch.set)) next[k] = v;
  }
  if (patch.append && typeof patch.append === "object") {
    for (const [k, values] of Object.entries(patch.append)) {
      if (!Array.isArray(values)) continue;
      const existing = Array.isArray(next[k]) ? (next[k] as unknown[]) : [];
      const merged = [...existing.map((x) => String(x))];
      for (const v of values) {
        const s = String(v);
        if (!merged.includes(s)) merged.push(s);
      }
      next[k] = merged;
    }
  }
  return setConfig(agentId, next);
}

export async function resetConfig(agentId: string): Promise<void> {
  await db.delete(agentConfig).where(eq(agentConfig.agentId, agentId));
}
