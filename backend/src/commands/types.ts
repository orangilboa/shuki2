// A Command is the canonical "verb" openshuki can be asked to perform.
// REST callers (POST /api/commands/:id) and channel adapters both invoke
// commands through the same registry, so behaviour can't drift between
// surfaces.

import type { AgentInput } from "../types/index.js";

export type CommandSource = "user" | "channel" | "internal";

export type CommandContext = {
  source: CommandSource;
  // Free-form metadata an adapter may attach (e.g. channelId, externalUserId).
  meta?: Record<string, unknown>;
};

export type CommandResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: string; status?: number };

export interface Command<TInput = Record<string, unknown>, TOutput = unknown> {
  id: string;
  title: string;
  description: string;
  // Same input spec as agents — `string|number|boolean` fields rendered the
  // same way by the same form code on the frontend.
  inputs: AgentInput[];
  handler: (input: TInput, ctx: CommandContext) => Promise<CommandResult<TOutput>>;
}

export type CommandSummary = {
  id: string;
  title: string;
  description: string;
  inputs: AgentInput[];
};
