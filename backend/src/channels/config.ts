// Loader for built-in channels in config/channels.json. Format mirrors the
// API ChannelSummary shape minus runtime-only fields, so the same JSON can
// be hand-edited and validates identically to a stored row.

import fs from "node:fs";
import path from "node:path";
import type {
  ChannelDirection,
  ChannelEventCategory,
  ChannelFilter,
  ChannelInboundPolicy
} from "../types/index.js";

export type ConfigChannel = {
  id: string;
  name: string;
  kind: string;
  direction: ChannelDirection;
  enabled: boolean;
  filter: ChannelFilter;
  inbound: ChannelInboundPolicy;
  adapterConfig: Record<string, unknown>;
};

const DIRECTIONS = new Set<ChannelDirection>(["in_out", "out_only", "in_only"]);

const CATEGORIES = new Set<ChannelEventCategory>([
  "run.lifecycle",
  "run.progress",
  "run.logs",
  "run.tools",
  "run.artifacts",
  "run.interactions",
  "run.errors",
  "run.llm_wait"
]);

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseFilter(raw: unknown, id: string): ChannelFilter {
  if (!raw || typeof raw !== "object") {
    throw new Error(`[channels/config] channel ${id}: filter must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.eventCategories)) {
    throw new Error(
      `[channels/config] channel ${id}: filter.eventCategories must be an array`
    );
  }
  const cats: ChannelEventCategory[] = [];
  for (const c of obj.eventCategories) {
    if (!isStr(c) || !CATEGORIES.has(c as ChannelEventCategory)) {
      throw new Error(
        `[channels/config] channel ${id}: unknown event category '${String(c)}'`
      );
    }
    cats.push(c as ChannelEventCategory);
  }
  const out: ChannelFilter = { eventCategories: cats };
  if (obj.includeTypes !== undefined) {
    if (!isStrArr(obj.includeTypes)) {
      throw new Error(`[channels/config] channel ${id}: includeTypes must be string[]`);
    }
    out.includeTypes = obj.includeTypes;
  }
  if (obj.excludeTypes !== undefined) {
    if (!isStrArr(obj.excludeTypes)) {
      throw new Error(`[channels/config] channel ${id}: excludeTypes must be string[]`);
    }
    out.excludeTypes = obj.excludeTypes;
  }
  if (obj.agentIds !== undefined) {
    if (!isStrArr(obj.agentIds)) {
      throw new Error(`[channels/config] channel ${id}: agentIds must be string[]`);
    }
    out.agentIds = obj.agentIds;
  }
  return out;
}

function parseInbound(raw: unknown, id: string): ChannelInboundPolicy {
  if (!raw || typeof raw !== "object") {
    throw new Error(`[channels/config] channel ${id}: inbound must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.allowCommands !== "boolean") {
    throw new Error(`[channels/config] channel ${id}: inbound.allowCommands must be boolean`);
  }
  if (!isStrArr(obj.allowedCommandIds)) {
    throw new Error(
      `[channels/config] channel ${id}: inbound.allowedCommandIds must be string[]`
    );
  }
  return {
    allowCommands: obj.allowCommands,
    allowedCommandIds: obj.allowedCommandIds
  };
}

function validateOne(raw: unknown): ConfigChannel {
  if (!raw || typeof raw !== "object") {
    throw new Error("[channels/config] each channel must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!isStr(obj.id) || obj.id.length === 0) {
    throw new Error("[channels/config] channel.id required");
  }
  if (!isStr(obj.name) || obj.name.length === 0) {
    throw new Error(`[channels/config] channel ${obj.id}: name required`);
  }
  if (!isStr(obj.kind) || obj.kind.length === 0) {
    throw new Error(`[channels/config] channel ${obj.id}: kind required`);
  }
  if (!isStr(obj.direction) || !DIRECTIONS.has(obj.direction as ChannelDirection)) {
    throw new Error(`[channels/config] channel ${obj.id}: invalid direction`);
  }
  if (typeof obj.enabled !== "boolean") {
    throw new Error(`[channels/config] channel ${obj.id}: enabled must be boolean`);
  }
  const adapterConfig =
    obj.adapterConfig && typeof obj.adapterConfig === "object"
      ? (obj.adapterConfig as Record<string, unknown>)
      : {};
  return {
    id: obj.id,
    name: obj.name,
    kind: obj.kind,
    direction: obj.direction as ChannelDirection,
    enabled: obj.enabled,
    filter: parseFilter(obj.filter, obj.id),
    inbound: parseInbound(obj.inbound, obj.id),
    adapterConfig
  };
}

let cache: ConfigChannel[] | null = null;

export function loadConfigChannels(): ConfigChannel[] {
  const filePath = path.resolve(process.cwd(), "config", "channels.json");
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("[channels/config] root must be an array of channels");
  }
  const seen = new Set<string>();
  const out: ConfigChannel[] = [];
  for (const entry of raw) {
    const ch = validateOne(entry);
    if (seen.has(ch.id)) {
      throw new Error(`[channels/config] duplicate channel id: ${ch.id}`);
    }
    seen.add(ch.id);
    out.push(ch);
  }
  return out;
}

export function getConfigChannels(): ConfigChannel[] {
  if (cache === null) cache = loadConfigChannels();
  return cache;
}

export function _resetConfigChannelsCache(): void {
  cache = null;
}
