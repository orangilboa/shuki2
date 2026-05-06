// CRUD for user-added endpoints + merge logic that combines them with the
// read-only config-file endpoints into a single sorted summary list.

import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { endpoints as endpointsTable, type Endpoint } from "../db/schema.js";
import type { EndpointSummary } from "../types/index.js";
import { getConfigEndpoints, type ConfigEndpoint } from "./config.js";

export type ResolvedEndpoint = {
  id: string;
  displayName: string;
  baseUrl: string;
  source: "config" | "user";
  hasKey: boolean;
  apiKey: string | null;
};

export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length < 12) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function configToSummary(c: ConfigEndpoint): EndpointSummary {
  return {
    id: c.id,
    displayName: c.displayName,
    baseUrl: c.baseUrl,
    source: "config",
    hasKey: c.hasKey,
    apiKeyMasked: maskApiKey(c.apiKey)
  };
}

function userToSummary(r: Endpoint): EndpointSummary {
  return {
    id: r.id,
    displayName: r.displayName,
    baseUrl: r.baseUrl,
    source: "user",
    hasKey: Boolean(r.apiKey),
    apiKeyMasked: maskApiKey(r.apiKey)
  };
}

function configToResolved(c: ConfigEndpoint): ResolvedEndpoint {
  return {
    id: c.id,
    displayName: c.displayName,
    baseUrl: c.baseUrl,
    source: "config",
    hasKey: c.hasKey,
    apiKey: c.apiKey
  };
}

function userToResolved(r: Endpoint): ResolvedEndpoint {
  return {
    id: r.id,
    displayName: r.displayName,
    baseUrl: r.baseUrl,
    source: "user",
    hasKey: Boolean(r.apiKey),
    apiKey: r.apiKey ?? null
  };
}

function byDisplayName<T extends { displayName: string }>(a: T, b: T): number {
  return a.displayName.localeCompare(b.displayName);
}

export function listAll(): EndpointSummary[] {
  const config = getConfigEndpoints().map(configToSummary).sort(byDisplayName);
  const userRows = db
    .select()
    .from(endpointsTable)
    .orderBy(asc(endpointsTable.displayName))
    .all();
  const user = userRows.map(userToSummary).sort(byDisplayName);
  return [...config, ...user];
}

export function listAllResolved(): ResolvedEndpoint[] {
  const config = getConfigEndpoints().map(configToResolved).sort(byDisplayName);
  const userRows = db
    .select()
    .from(endpointsTable)
    .orderBy(asc(endpointsTable.displayName))
    .all();
  const user = userRows.map(userToResolved).sort(byDisplayName);
  return [...config, ...user];
}

export function findById(id: string): {
  source: "config" | "user";
  config?: ConfigEndpoint;
  user?: Endpoint;
} | null {
  const cfg = getConfigEndpoints().find((c) => c.id === id);
  if (cfg) return { source: "config", config: cfg };
  const row = db.select().from(endpointsTable).where(eq(endpointsTable.id, id)).get();
  if (row) return { source: "user", user: row };
  return null;
}

export type CreateUserEndpointInput = {
  displayName: string;
  baseUrl: string;
  apiKey?: string | null;
};

export function createUserEndpoint(input: CreateUserEndpointInput): EndpointSummary {
  const id = crypto.randomUUID();
  const now = Date.now();
  // SECURITY: api_key persisted plaintext for local scaffold.
  // Encrypt at rest before shipping multi-user.
  db.insert(endpointsTable)
    .values({
      id,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run();
  const row = db
    .select()
    .from(endpointsTable)
    .where(eq(endpointsTable.id, id))
    .get();
  if (!row) throw new Error("[endpoints/store] insert vanished");
  return userToSummary(row);
}

export type PatchUserEndpointInput = {
  displayName?: string;
  baseUrl?: string;
  // string => replace; null => clear; undefined => leave alone
  apiKey?: string | null;
};

export function updateUserEndpoint(
  id: string,
  patch: PatchUserEndpointInput
): EndpointSummary | null {
  const existing = db
    .select()
    .from(endpointsTable)
    .where(eq(endpointsTable.id, id))
    .get();
  if (!existing) return null;

  const next: Partial<Endpoint> = { updatedAt: Date.now() };
  if (patch.displayName !== undefined) next.displayName = patch.displayName;
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
  if (patch.apiKey !== undefined) next.apiKey = patch.apiKey;

  db.update(endpointsTable).set(next).where(eq(endpointsTable.id, id)).run();
  const after = db
    .select()
    .from(endpointsTable)
    .where(eq(endpointsTable.id, id))
    .get();
  if (!after) return null;
  return userToSummary(after);
}

export function deleteUserEndpoint(id: string): boolean {
  const existing = db
    .select()
    .from(endpointsTable)
    .where(eq(endpointsTable.id, id))
    .get();
  if (!existing) return false;
  db.delete(endpointsTable).where(eq(endpointsTable.id, id)).run();
  return true;
}
