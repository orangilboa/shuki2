// Aggregates GET /v1/models across every known endpoint, in parallel,
// with a per-endpoint timeout and a 60-second in-memory cache.

import type { EndpointModels, ModelInfo, ModelsResponse } from "../types/index.js";
import { listAllResolved, type ResolvedEndpoint } from "./store.js";

const CACHE_TTL_MS = 60_000;
const PER_ENDPOINT_TIMEOUT_MS = 5_000;

type CacheEntry = {
  expiresAt: number;
  payload: ModelsResponse;
};

let cache: CacheEntry | null = null;

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const tail = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${trimmed}${tail}`;
}

function parseModelsPayload(payload: unknown): ModelInfo[] {
  // Accept either { data: [...] } (OpenAI canonical) or a bare array
  // (some compatibles like older Ollama builds).
  let raw: unknown[];
  if (Array.isArray(payload)) {
    raw = payload;
  } else if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    raw = (payload as { data: unknown[] }).data;
  } else {
    return [];
  }
  const out: ModelInfo[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    if (typeof obj.id !== "string") continue;
    const ownedByRaw = obj.owned_by ?? obj.ownedBy;
    const ownedBy = typeof ownedByRaw === "string" ? ownedByRaw : undefined;
    const entry: ModelInfo = ownedBy ? { id: obj.id, ownedBy } : { id: obj.id };
    out.push(entry);
  }
  return out;
}

async function fetchOne(ep: ResolvedEndpoint): Promise<EndpointModels> {
  const fetchedAt = new Date().toISOString();
  const base: Omit<EndpointModels, "ok" | "error" | "models"> = {
    endpointId: ep.id,
    displayName: ep.displayName,
    source: ep.source,
    fetchedAt
  };

  if (!ep.hasKey) {
    return {
      ...base,
      ok: false,
      error: "missing_api_key",
      models: []
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_ENDPOINT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (ep.apiKey) headers["authorization"] = `Bearer ${ep.apiKey}`;
    const res = await fetch(joinUrl(ep.baseUrl, "/models"), {
      method: "GET",
      headers,
      signal: ctrl.signal
    });
    if (!res.ok) {
      return {
        ...base,
        ok: false,
        error: `http_${res.status}`,
        models: []
      };
    }
    const json = (await res.json()) as unknown;
    const models = parseModelsPayload(json);
    return {
      ...base,
      ok: true,
      error: null,
      models
    };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === "AbortError"
          ? "timeout"
          : err.message
        : String(err);
    return {
      ...base,
      ok: false,
      error: msg,
      models: []
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getAllModels(opts?: { refresh?: boolean }): Promise<ModelsResponse> {
  const now = Date.now();
  if (!opts?.refresh && cache && cache.expiresAt > now) {
    return cache.payload;
  }
  const all = await listAllResolved();
  const results = await Promise.all(all.map((ep) => fetchOne(ep)));
  cache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload: results
  };
  return results;
}

export function _resetModelsCache(): void {
  cache = null;
}
