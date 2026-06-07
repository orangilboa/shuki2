// Validators / parsers for AgentInput[] and AgentExec.
//
// These are shared between the config-file loader, the DB store, and the
// CRUD API. They never throw at the parse layer; the API edge calls
// `validateAgentInputs` / `validateAgentExec` which DO throw with a typed
// error so the route can map to a 400 response.

import type {
  AgentExec,
  AgentInput,
  AgentInputType,
  OnboardingField,
  OnboardingFieldType
} from "../types/index.js";

export class AgentSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSpecError";
  }
}

const INPUT_TYPES: readonly AgentInputType[] = ["string", "number", "boolean"];

function isInputType(v: unknown): v is AgentInputType {
  return typeof v === "string" && (INPUT_TYPES as readonly string[]).includes(v);
}

function isStringNumberBool(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Parse a stored `inputs_json` string. Accepts both:
 *   - the new `AgentInput[]` shape, and
 *   - the legacy `string[]` shape (mapped to `{ name, type: "string" }`).
 * Anything malformed yields `[]` rather than throwing — this is the read path.
 */
export function parseInputsJson(json: string | null | undefined): AgentInput[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  // Legacy: array of plain strings.
  if (raw.every((x) => typeof x === "string")) {
    return (raw as string[]).map((name) => ({ name, type: "string" as const }));
  }

  const out: AgentInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) continue;
    const type: AgentInputType = isInputType(obj.type) ? obj.type : "string";
    const item: AgentInput = { name: obj.name, type };
    if (typeof obj.label === "string") item.label = obj.label;
    if (typeof obj.required === "boolean") item.required = obj.required;
    if (isStringNumberBool(obj.default)) item.default = obj.default;
    if (typeof obj.description === "string") item.description = obj.description;
    out.push(item);
  }
  return out;
}

/**
 * Parse a stored `exec_json` string. `null`/missing/malformed → `{ kind: "mock" }`.
 */
export function parseExecJson(json: string | null | undefined): AgentExec {
  if (!json) return { kind: "mock" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: "mock" };
  }
  if (!raw || typeof raw !== "object") return { kind: "mock" };
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "subprocess") {
    if (typeof obj.command !== "string" || obj.command.length === 0) return { kind: "mock" };
    if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) {
      return { kind: "mock" };
    }
    const protocol: "jsonl" | "raw" =
      obj.protocol === "raw" ? "raw" : "jsonl";
    const out: Extract<AgentExec, { kind: "subprocess" }> = {
      kind: "subprocess",
      command: obj.command,
      args: obj.args as string[],
      protocol
    };
    if (typeof obj.cwd === "string") out.cwd = obj.cwd;
    if (obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
      out.env = env;
    }
    return out;
  }
  return { kind: "mock" };
}

// ---------- write-path validators (throw AgentSpecError) -----------------

export function validateAgentInputs(raw: unknown): AgentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AgentSpecError("inputs must be an array");
  }
  // Accept legacy string[] on the write path too — convenient for callers.
  if (raw.length > 0 && raw.every((x) => typeof x === "string")) {
    return (raw as string[]).map((name) => ({ name, type: "string" as const }));
  }
  const out: AgentInput[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new AgentSpecError("each input must be an object");
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      throw new AgentSpecError("input.name must be a non-empty string");
    }
    if (seen.has(obj.name)) {
      throw new AgentSpecError(`duplicate input name: ${obj.name}`);
    }
    seen.add(obj.name);
    if (!isInputType(obj.type)) {
      throw new AgentSpecError(
        `input ${obj.name}: type must be one of ${INPUT_TYPES.join("|")}`
      );
    }
    const item: AgentInput = { name: obj.name, type: obj.type };
    if (obj.label !== undefined) {
      if (typeof obj.label !== "string") {
        throw new AgentSpecError(`input ${obj.name}: label must be string`);
      }
      item.label = obj.label;
    }
    if (obj.required !== undefined) {
      if (typeof obj.required !== "boolean") {
        throw new AgentSpecError(`input ${obj.name}: required must be boolean`);
      }
      item.required = obj.required;
    }
    if (obj.default !== undefined) {
      if (!isStringNumberBool(obj.default)) {
        throw new AgentSpecError(
          `input ${obj.name}: default must be string|number|boolean`
        );
      }
      item.default = obj.default;
    }
    if (obj.description !== undefined) {
      if (typeof obj.description !== "string") {
        throw new AgentSpecError(`input ${obj.name}: description must be string`);
      }
      item.description = obj.description;
    }
    out.push(item);
  }
  return out;
}

export function validateAgentExec(raw: unknown): AgentExec {
  if (raw === undefined || raw === null) return { kind: "mock" };
  if (typeof raw !== "object") {
    throw new AgentSpecError("exec must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "mock") return { kind: "mock" };
  if (obj.kind !== "subprocess") {
    throw new AgentSpecError("exec.kind must be 'mock' | 'subprocess'");
  }
  if (typeof obj.command !== "string" || obj.command.length === 0) {
    throw new AgentSpecError("exec.command must be a non-empty string");
  }
  if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) {
    throw new AgentSpecError("exec.args must be string[]");
  }
  if (obj.protocol !== "jsonl" && obj.protocol !== "raw") {
    throw new AgentSpecError("exec.protocol must be 'jsonl' | 'raw'");
  }
  const out: Extract<AgentExec, { kind: "subprocess" }> = {
    kind: "subprocess",
    command: obj.command,
    args: obj.args as string[],
    protocol: obj.protocol
  };
  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") {
      throw new AgentSpecError("exec.cwd must be string");
    }
    out.cwd = obj.cwd;
  }
  if (obj.env !== undefined) {
    if (!obj.env || typeof obj.env !== "object" || Array.isArray(obj.env)) {
      throw new AgentSpecError("exec.env must be an object");
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new AgentSpecError(`exec.env.${k} must be string`);
      }
      env[k] = v;
    }
    out.env = env;
  }
  return out;
}

// ---------- onboarding spec ----------------------------------------------

const ONBOARDING_TYPES: readonly OnboardingFieldType[] = [
  "string",
  "number",
  "boolean",
  "string_list"
];

function isOnboardingType(v: unknown): v is OnboardingFieldType {
  return (
    typeof v === "string" &&
    (ONBOARDING_TYPES as readonly string[]).includes(v)
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Lenient read-path parser. Malformed entries are skipped; never throws. */
export function parseOnboardingJson(
  json: string | null | undefined
): OnboardingField[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  return normalizeOnboarding(raw, false);
}

/** Throwing write-path validator (config loader + future CRUD). */
export function validateOnboarding(raw: unknown): OnboardingField[] {
  return normalizeOnboarding(raw, true);
}

function normalizeOnboarding(raw: unknown, strict: boolean): OnboardingField[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    if (strict) throw new AgentSpecError("onboarding must be an array");
    return [];
  }
  const out: OnboardingField[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      if (strict) throw new AgentSpecError("each onboarding field must be an object");
      continue;
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      if (strict) throw new AgentSpecError("onboarding field.name must be a non-empty string");
      continue;
    }
    if (seen.has(obj.name)) {
      if (strict) throw new AgentSpecError(`duplicate onboarding field: ${obj.name}`);
      continue;
    }
    if (!isOnboardingType(obj.type)) {
      if (strict) {
        throw new AgentSpecError(
          `onboarding ${obj.name}: type must be one of ${ONBOARDING_TYPES.join("|")}`
        );
      }
      continue;
    }
    seen.add(obj.name);
    const item: OnboardingField = { name: obj.name, type: obj.type };
    if (typeof obj.label === "string") item.label = obj.label;
    if (typeof obj.description === "string") item.description = obj.description;
    if (typeof obj.section === "string") item.section = obj.section;
    if (obj.default !== undefined) {
      if (obj.type === "string_list") {
        if (isStringArray(obj.default)) item.default = obj.default;
        else if (strict) throw new AgentSpecError(`onboarding ${obj.name}: default must be string[]`);
      } else if (isStringNumberBool(obj.default)) {
        item.default = obj.default;
      } else if (strict) {
        throw new AgentSpecError(`onboarding ${obj.name}: default must be string|number|boolean`);
      }
    }
    out.push(item);
  }
  return out;
}

export function onboardingToJson(fields: OnboardingField[]): string {
  return JSON.stringify(fields);
}

export function execToJson(exec: AgentExec): string {
  return JSON.stringify(exec);
}

export function inputsToJson(inputs: AgentInput[]): string {
  return JSON.stringify(inputs);
}
