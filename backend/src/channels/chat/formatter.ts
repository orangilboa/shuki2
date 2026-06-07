// One place to tune chat ergonomics. Both the chat adapter and the
// notifications adapter (PR #6) use this so summaries stay consistent.

import type { RunEventEnvelope } from "../../runs/events.js";

const SHORT_ID_LEN = 8;
const shortId = (s: string): string => s.slice(0, SHORT_ID_LEN);

export type SummaryStyle = "compact" | "verbose";

export function summarizeEvent(
  ev: RunEventEnvelope,
  style: SummaryStyle = "compact"
): string | null {
  switch (ev.type) {
    case "run_started": {
      const p = ev.payload as { name?: string; model?: string } | null;
      return `▶ run ${shortId(ev.runId)} started: ${p?.name ?? "(agent)"}${
        p?.model ? ` · ${p.model}` : ""
      }`;
    }
    case "done": {
      const p = ev.payload as { ok?: boolean; aborted?: boolean } | null;
      if (p?.aborted) return `⏹ run ${shortId(ev.runId)} aborted`;
      return p?.ok === false
        ? `✗ run ${shortId(ev.runId)} failed`
        : `✓ run ${shortId(ev.runId)} done`;
    }
    case "error": {
      const p = ev.payload as { message?: string } | null;
      return `✗ run ${shortId(ev.runId)} error: ${p?.message ?? "(no message)"}`;
    }
    case "ask_user": {
      const p = ev.payload as { prompt?: string; interactionId?: string } | null;
      const prompt = (p?.prompt ?? "").slice(0, 200);
      return `❓ run ${shortId(ev.runId)} asks: ${prompt}\n  reply with: /respond ${shortId(
        ev.runId
      )} ${p?.interactionId ?? "<id>"} <answer>`;
    }
    case "user_response":
      return null; // suppressed; the agent's next event provides signal.
    case "artifact": {
      if (style === "compact") return null;
      const p = ev.payload as { name?: string; kind?: string } | null;
      return `📎 run ${shortId(ev.runId)} produced ${p?.kind ?? "artifact"}: ${
        p?.name ?? "(unnamed)"
      }`;
    }
    case "node_end": {
      if (style === "compact") return null;
      const p = ev.payload as { progress?: number } | null;
      return `· run ${shortId(ev.runId)} progress ${Math.round((p?.progress ?? 0) * 100)}%`;
    }
    case "token":
      return null; // never spam tokens to chat
    default:
      return style === "verbose" ? `· run ${shortId(ev.runId)} ${ev.type}` : null;
  }
}

// Format a command result for the chat. Each command type knows its shape;
// we render whatever's most useful given that shape.
export function formatCommandResult(
  commandId: string,
  output: unknown
): string {
  if (commandId === "run-agent") {
    const o = output as { runId?: string } | null;
    return `▶ started run ${shortId(o?.runId ?? "")}`;
  }
  if (commandId === "cancel-run") {
    const o = output as { mode?: string } | null;
    return `⏹ cancel sent (${o?.mode ?? "ok"})`;
  }
  if (commandId === "list-runs") {
    const o = output as Array<{ id: string; name: string; status: string; progress: number }>;
    if (!o || o.length === 0) return "(no runs)";
    return o
      .slice(0, 10)
      .map(
        (r) =>
          `· ${shortId(r.id)} ${r.status.padEnd(9)} ${Math.round(
            r.progress * 100
          )}% — ${r.name}`
      )
      .join("\n");
  }
  if (commandId === "list-agents") {
    const o = output as Array<{ id: string; name: string }>;
    if (!o || o.length === 0) return "(no agents)";
    return o.map((a) => `· ${a.id} — ${a.name}`).join("\n");
  }
  if (commandId === "respond-to-interaction") {
    const o = output as { delivered?: boolean } | null;
    return o?.delivered ? "✓ answered (delivered)" : "✓ answered (queued)";
  }
  return JSON.stringify(output);
}
