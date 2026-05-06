// Loader for the read-only built-in endpoints in config/endpoints.json.
//
// The JSON references API keys by env-var name (apiKeyEnv). We resolve those
// at load time. The file itself is committed and contains no secrets.

import fs from "node:fs";
import path from "node:path";

export type ConfigEndpointFile = {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string | null;
};

export type ConfigEndpoint = {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  apiKey: string | null; // resolved from process.env at load time
  hasKey: boolean;
};

type RawFile = {
  endpoints?: unknown;
};

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function validate(raw: unknown): ConfigEndpointFile[] {
  if (!raw || typeof raw !== "object") {
    throw new Error("[endpoints/config] root must be an object");
  }
  const endpoints = (raw as RawFile).endpoints;
  if (!Array.isArray(endpoints)) {
    throw new Error("[endpoints/config] 'endpoints' must be an array");
  }
  const out: ConfigEndpointFile[] = [];
  const seenIds = new Set<string>();
  for (const e of endpoints) {
    if (!e || typeof e !== "object") {
      throw new Error("[endpoints/config] each endpoint must be an object");
    }
    const obj = e as Record<string, unknown>;
    if (!isString(obj.id) || !obj.id) {
      throw new Error("[endpoints/config] endpoint.id must be a non-empty string");
    }
    if (seenIds.has(obj.id)) {
      throw new Error(`[endpoints/config] duplicate endpoint id: ${obj.id}`);
    }
    seenIds.add(obj.id);
    if (!isString(obj.displayName) || !obj.displayName) {
      throw new Error(`[endpoints/config] endpoint ${obj.id}: displayName required`);
    }
    if (!isString(obj.baseUrl) || !/^https?:\/\//.test(obj.baseUrl)) {
      throw new Error(`[endpoints/config] endpoint ${obj.id}: baseUrl must be http(s) URL`);
    }
    let apiKeyEnv: string | null;
    if (obj.apiKeyEnv === null || obj.apiKeyEnv === undefined) {
      apiKeyEnv = null;
    } else if (isString(obj.apiKeyEnv)) {
      apiKeyEnv = obj.apiKeyEnv;
    } else {
      throw new Error(
        `[endpoints/config] endpoint ${obj.id}: apiKeyEnv must be string or null`
      );
    }
    out.push({
      id: obj.id,
      displayName: obj.displayName,
      baseUrl: obj.baseUrl,
      apiKeyEnv
    });
  }
  return out;
}

let cache: ConfigEndpoint[] | null = null;

export function loadConfigEndpoints(): ConfigEndpoint[] {
  const filePath = path.resolve(process.cwd(), "config", "endpoints.json");
  if (!fs.existsSync(filePath)) {
    // Acceptable: ship without a config file. Just no built-ins.
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  const file = validate(raw);
  return file.map((e) => {
    const apiKey = e.apiKeyEnv ? process.env[e.apiKeyEnv] ?? null : null;
    // hasKey semantics:
    //   apiKeyEnv === null  -> no key needed (e.g. local Ollama) -> true
    //   apiKeyEnv set + env present + non-empty -> true
    //   otherwise -> false
    const hasKey = e.apiKeyEnv === null ? true : Boolean(apiKey && apiKey.length > 0);
    return {
      id: e.id,
      displayName: e.displayName,
      baseUrl: e.baseUrl,
      apiKeyEnv: e.apiKeyEnv,
      apiKey: apiKey && apiKey.length > 0 ? apiKey : null,
      hasKey
    };
  });
}

export function getConfigEndpoints(): ConfigEndpoint[] {
  if (cache === null) cache = loadConfigEndpoints();
  return cache;
}

// Test/dev helper if anyone wants to force a reload.
export function _resetConfigEndpointsCache(): void {
  cache = null;
}
