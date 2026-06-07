import type { Command, CommandContext, CommandResult, CommandSummary } from "./types.js";

type AnyCommand = Command<Record<string, unknown>, unknown>;

const registry = new Map<string, AnyCommand>();

export function register<TInput, TOutput>(cmd: Command<TInput, TOutput>): void {
  if (registry.has(cmd.id)) {
    throw new Error(`[commands/registry] command id already registered: ${cmd.id}`);
  }
  registry.set(cmd.id, cmd as unknown as AnyCommand);
}

export function get(id: string): AnyCommand | undefined {
  return registry.get(id);
}

export function list(): CommandSummary[] {
  return [...registry.values()]
    .map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      inputs: c.inputs
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function dispatch(
  id: string,
  input: Record<string, unknown>,
  ctx: CommandContext
): Promise<CommandResult<unknown>> {
  const cmd = registry.get(id);
  if (!cmd) return { ok: false, error: "unknown_command", status: 404 };
  try {
    return await cmd.handler(input, ctx);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 500
    };
  }
}

export function _resetRegistry(): void {
  registry.clear();
}
