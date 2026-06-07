// CRUD for user-added channels + merge logic combining them with read-only
// config-file channels into a single sorted list. Mirrors the
// endpoints/store.ts and agents/store.ts patterns.

import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  channels as channelsTable,
  type ChannelRow,
  type NewChannelRow
} from "../db/schema.js";
import type {
  ChannelDirection,
  ChannelFilter,
  ChannelInboundPolicy,
  ChannelSummary
} from "../types/index.js";
import { getConfigChannels, type ConfigChannel } from "./config.js";
import { getKind } from "./registry.js";
import type { ResolvedChannel } from "./types.js";

function rowToResolved(row: ChannelRow): ResolvedChannel {
  let filter: ChannelFilter;
  let inbound: ChannelInboundPolicy;
  let adapterConfig: Record<string, unknown>;
  try {
    filter = JSON.parse(row.filterJson) as ChannelFilter;
  } catch {
    filter = { eventCategories: [] };
  }
  try {
    inbound = JSON.parse(row.inboundJson) as ChannelInboundPolicy;
  } catch {
    inbound = { allowCommands: false, allowedCommandIds: [] };
  }
  try {
    const v = JSON.parse(row.adapterConfigJson) as unknown;
    adapterConfig = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    adapterConfig = {};
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    direction: row.direction as ChannelDirection,
    enabled: row.enabled === "true",
    filter,
    inbound,
    adapterConfig,
    source: "user",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function configToResolved(c: ConfigChannel): ResolvedChannel {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    direction: c.direction,
    enabled: c.enabled,
    filter: c.filter,
    inbound: c.inbound,
    adapterConfig: c.adapterConfig,
    source: "config",
    createdAt: 0,
    updatedAt: 0
  };
}

function resolvedToSummary(r: ResolvedChannel): ChannelSummary {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    direction: r.direction,
    enabled: r.enabled,
    filter: r.filter,
    inbound: r.inbound,
    adapterConfig: r.adapterConfig,
    source: r.source,
    createdAt: r.createdAt > 0 ? new Date(r.createdAt).toISOString() : new Date(0).toISOString(),
    updatedAt: r.updatedAt > 0 ? new Date(r.updatedAt).toISOString() : new Date(0).toISOString()
  };
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

export async function listAllResolved(): Promise<ResolvedChannel[]> {
  const configIds = new Set<string>();
  const config = getConfigChannels()
    .map((c) => {
      configIds.add(c.id);
      return configToResolved(c);
    })
    .sort(byName);
  const rows = await db
    .select()
    .from(channelsTable)
    .orderBy(asc(channelsTable.name));
  // Same-id conflict: config wins.
  const user = rows
    .filter((r) => !configIds.has(r.id))
    .map(rowToResolved)
    .sort(byName);
  return [...config, ...user];
}

export async function listAll(): Promise<ChannelSummary[]> {
  return (await listAllResolved()).map(resolvedToSummary);
}

export async function findById(id: string): Promise<ResolvedChannel | null> {
  const cfg = getConfigChannels().find((c) => c.id === id);
  if (cfg) return configToResolved(cfg);
  const rows = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.id, id));
  const row = rows[0];
  if (!row) return null;
  return rowToResolved(row);
}

export function isConfigChannel(id: string): boolean {
  return getConfigChannels().some((c) => c.id === id);
}

export type CreateChannelInput = {
  name: string;
  kind: string;
  direction: ChannelDirection;
  enabled?: boolean;
  filter: ChannelFilter;
  inbound: ChannelInboundPolicy;
  adapterConfig?: Record<string, unknown>;
};

function runValidate(channel: ResolvedChannel): void {
  const desc = getKind(channel.kind);
  // Permit unknown kinds at store time so channel rows can be prepared before
  // their adapter is registered (eg. config rows for kinds shipped in a
  // later PR). The runtime warns and skips channels whose kind isn't
  // available at boot. Known-kind adapters may still impose validation.
  if (!desc) return;
  if (desc.validate) desc.validate(channel);
}

export async function createUserChannel(
  input: CreateChannelInput
): Promise<ChannelSummary> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const resolved: ResolvedChannel = {
    id,
    name: input.name,
    kind: input.kind,
    direction: input.direction,
    enabled: input.enabled ?? false,
    filter: input.filter,
    inbound: input.inbound,
    adapterConfig: input.adapterConfig ?? {},
    source: "user",
    createdAt: now,
    updatedAt: now
  };
  runValidate(resolved);
  const insert: NewChannelRow = {
    id,
    name: resolved.name,
    kind: resolved.kind,
    direction: resolved.direction,
    enabled: resolved.enabled ? "true" : "false",
    filterJson: JSON.stringify(resolved.filter),
    inboundJson: JSON.stringify(resolved.inbound),
    adapterConfigJson: JSON.stringify(resolved.adapterConfig),
    createdAt: now,
    updatedAt: now
  };
  await db.insert(channelsTable).values(insert);
  return resolvedToSummary(resolved);
}

export type PatchChannelInput = Partial<CreateChannelInput>;

export async function updateUserChannel(
  id: string,
  patch: PatchChannelInput
): Promise<ChannelSummary | null> {
  const existing = await findById(id);
  if (!existing || existing.source === "config") return null;
  const merged: ResolvedChannel = {
    ...existing,
    name: patch.name ?? existing.name,
    kind: patch.kind ?? existing.kind,
    direction: patch.direction ?? existing.direction,
    enabled: patch.enabled ?? existing.enabled,
    filter: patch.filter ?? existing.filter,
    inbound: patch.inbound ?? existing.inbound,
    adapterConfig: patch.adapterConfig ?? existing.adapterConfig,
    updatedAt: Date.now()
  };
  runValidate(merged);
  await db
    .update(channelsTable)
    .set({
      name: merged.name,
      kind: merged.kind,
      direction: merged.direction,
      enabled: merged.enabled ? "true" : "false",
      filterJson: JSON.stringify(merged.filter),
      inboundJson: JSON.stringify(merged.inbound),
      adapterConfigJson: JSON.stringify(merged.adapterConfig),
      updatedAt: merged.updatedAt
    })
    .where(eq(channelsTable.id, id));
  return resolvedToSummary(merged);
}

export async function setEnabled(id: string, enabled: boolean): Promise<ChannelSummary | null> {
  const existing = await findById(id);
  if (!existing) return null;
  if (existing.source === "config") {
    // Built-in channels can be enabled/disabled, but other config can't change.
    // We mirror this by storing a shadow row for state if needed — for the
    // current scope, built-in `enabled` is fixed in JSON, so reject the toggle.
    throw new Error("config_channels_are_read_only");
  }
  return updateUserChannel(id, { enabled });
}

export async function deleteUserChannel(id: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.id, id));
  if (existing.length === 0) return false;
  await db.delete(channelsTable).where(eq(channelsTable.id, id));
  return true;
}
