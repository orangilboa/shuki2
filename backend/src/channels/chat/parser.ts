// Parses an inbound chat message into a command dispatch (or nothing).
//
// Two tiers:
//   1. Slash syntax — deterministic. `/run weather location=NYC days=2`,
//      `/cancel <runId>`, `/list-agents`, `/respond <runId> <interactionId> answer text`.
//   2. LLM router (off by default) — out of scope for this PR; the hook is
//      a `useLlmRouter` flag on the adapter config that will be honoured
//      once the LLM-routing helper lands.

export type ParseResult =
  | { kind: "command"; commandId: string; input: Record<string, unknown> }
  | { kind: "noop" }
  | { kind: "error"; message: string };

const SLASH_ALIASES: Record<string, string> = {
  run: "run-agent",
  cancel: "cancel-run",
  "list-runs": "list-runs",
  "list-agents": "list-agents",
  respond: "respond-to-interaction"
};

// Parse `key=value` tokens (value may be a quoted string, e.g. `q="hello world"`)
// or positional args. Returns positional[] + named{}.
function tokenize(rest: string): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  // Regex: either `key=value` (with optional quoted value) or a bare token.
  const re = /(\S+?)=(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    if (m[1] !== undefined) {
      named[m[1]] = m[2] ?? m[3] ?? "";
    } else if (m[4] !== undefined) {
      positional.push(m[4]);
    } else if (m[5] !== undefined) {
      positional.push(m[5]);
    }
  }
  return { positional, named };
}

export function parseChatMessage(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/")) {
    return { kind: "noop" };
  }
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const verb = (head ?? "").toLowerCase();
  const remainder = trimmed.slice(1 + (head?.length ?? 0)).trim();
  const commandId = SLASH_ALIASES[verb];
  if (!commandId) {
    return { kind: "error", message: `unknown command: /${verb}` };
  }
  const { positional, named } = tokenize(remainder);

  // Per-command argument shape.
  switch (commandId) {
    case "run-agent": {
      if (positional.length === 0 && !named.agentId) {
        return { kind: "error", message: "usage: /run <agentId> [key=value ...]" };
      }
      const agentId = (named.agentId ?? positional.shift()) as string;
      // Treat remaining named pairs as agent inputs. Number-ish coerce.
      const inputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(named)) {
        if (k === "agentId" || k === "model") continue;
        inputs[k] = coerce(v);
      }
      return {
        kind: "command",
        commandId,
        input: {
          agentId,
          inputs,
          model: named.model
        }
      };
    }
    case "cancel-run": {
      const runId = (named.runId ?? positional[0]) as string | undefined;
      if (!runId) return { kind: "error", message: "usage: /cancel <runId>" };
      return { kind: "command", commandId, input: { runId } };
    }
    case "list-runs": {
      const limit = named.limit ? Number(named.limit) : 10;
      return { kind: "command", commandId, input: { limit, status: named.status } };
    }
    case "list-agents":
      return { kind: "command", commandId, input: {} };
    case "respond-to-interaction": {
      // /respond <runId> <interactionId> <answer text…>
      // Use positional for the two ids, slurp the rest as the answer.
      const runId = positional[0];
      const interactionId = positional[1];
      const answer = positional.slice(2).join(" ").trim();
      if (!runId || !interactionId || !answer) {
        return {
          kind: "error",
          message: "usage: /respond <runId> <interactionId> <answer>"
        };
      }
      return {
        kind: "command",
        commandId,
        input: { runId, interactionId, answer }
      };
    }
    default:
      return { kind: "error", message: `unknown command: /${verb}` };
  }
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// Help text the formatter can include in error replies.
export function helpText(): string {
  return [
    "Commands:",
    "  /run <agentId> [key=value …] [model=...]   — start an agent",
    "  /cancel <runId>                            — stop an active run",
    "  /list-runs [status=running] [limit=10]     — list recent runs",
    "  /list-agents                               — list agents",
    "  /respond <runId> <interactionId> <answer>  — answer an ask_user"
  ].join("\n");
}
