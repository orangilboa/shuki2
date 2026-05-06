// Mock run engine. Emits a synthetic graph of node_start / node_end pairs with
// interspersed token / tool_call / tool_result / custom events, then `done`.
//
// FUTURE: replace the mock loop with `for await (const ev of graph.astream_events(...))`
// and translate LangChain event names to our RunEventType vocabulary. The bus.publish()
// contract stays the same — frontends won't change.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { runs } from "../db/schema.js";
import { findById as findAgentById } from "../agents/store.js";
import { publish } from "./bus.js";
import { runSubprocess } from "./runners/subprocess.js";

type EngineHandle = {
  abort: AbortController;
  promise: Promise<void>;
};

const active = new Map<string, EngineHandle>();

const NODES = ["discovery", "planner", "executor", "verifier", "summarizer"] as const;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal.addEventListener("abort", onAbort);
  });
}

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

export type StartRunOpts = {
  signal?: AbortSignal;
  /**
   * Resolved model for this run, format "<endpointId>::<modelId>". When
   * provided, takes precedence over the agent's configured default. Surfaced
   * on the `run_started` event payload so subscribers can display it.
   */
  model?: string | null;
};

/**
 * Convenience for nodes/agents to push their own structured updates through the
 * bus. This is the "stream my own messages from nodes" feature — anything you
 * publish here flows out through the SSE endpoints exactly like built-in events.
 *
 * @param runId  Run to attach the message to.
 * @param payload Arbitrary JSON-serializable object.
 * @param node   Optional node name (used for grouping in the UI).
 */
export function emitCustom(runId: string, payload: unknown, node?: string | null): void {
  publish(runId, { type: "custom", node: node ?? null, payload });
}

/**
 * Kick off a run. Fire-and-forget — caller should not await unless it needs
 * the terminal status. The returned promise resolves once the run is in a
 * terminal state (succeeded / failed).
 */
export function startRun(
  agentId: string,
  runId: string,
  inputs: unknown,
  opts: StartRunOpts = {}
): EngineHandle {
  const abort = new AbortController();
  // Forward any external signal into our internal controller.
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  const promise = (async () => {
    // Look up via the merged loader so config-file agents resolve too.
    const agent = findAgentById(agentId);
    const agentName = agent?.name ?? "(unknown)";
    // Per-invocation override wins; fall back to the agent's configured model.
    const model = opts.model ?? agent?.model ?? null;

    try {
      publish(runId, {
        type: "run_started",
        node: null,
        payload: { agentId, name: agentName, model, inputs }
      });

      // Route to subprocess runner when the agent is configured for it.
      if (agent && agent.exec.kind === "subprocess") {
        const inputsObj: Record<string, unknown> =
          inputs && typeof inputs === "object" && !Array.isArray(inputs)
            ? (inputs as Record<string, unknown>)
            : {};
        await runSubprocess({
          runId,
          agentId,
          agentName,
          exec: agent.exec,
          inputs: inputsObj,
          inputSpec: agent.inputs,
          model,
          signal: abort.signal
        });
        return;
      }

      const total = NODES.length;
      for (let i = 0; i < total; i++) {
        if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
        const node = NODES[i];

        publish(runId, { type: "node_start", node, payload: { index: i } });

        // A small burst of token events to look lifelike.
        await sleep(jitter(150, 350), abort.signal);
        publish(runId, {
          type: "token",
          node,
          payload: { text: `working on ${node}…` }
        });
        await sleep(jitter(100, 250), abort.signal);
        publish(runId, {
          type: "token",
          node,
          payload: { text: `…still ${node}` }
        });

        // One tool call/result pair.
        await sleep(jitter(100, 250), abort.signal);
        publish(runId, {
          type: "tool_call",
          node,
          payload: { name: `${node}.fetch`, args: { i } }
        });
        await sleep(jitter(100, 250), abort.signal);
        publish(runId, {
          type: "tool_result",
          node,
          payload: { name: `${node}.fetch`, ok: true, durationMs: jitter(20, 90) }
        });

        // A custom event — proves end-to-end pass-through.
        emitCustom(
          runId,
          { kind: `${node}.note`, message: `custom note from ${node}`, at: i },
          node
        );

        // Wrap up the node with a node_end carrying progress.
        await sleep(jitter(200, 500), abort.signal);
        const progress = (i + 1) / total;
        publish(runId, {
          type: "node_end",
          node,
          payload: { index: i, progress }
        });
        db.update(runs)
          .set({ progress, status: "running" })
          .where(eq(runs.id, runId))
          .run();
      }

      const finishedAt = Date.now();
      db.update(runs)
        .set({ status: "succeeded", progress: 1, finishedAt })
        .where(eq(runs.id, runId))
        .run();

      publish(runId, {
        type: "done",
        node: null,
        payload: { ok: true, finishedAt }
      });
    } catch (err) {
      const aborted =
        (err as { name?: string } | undefined)?.name === "AbortError" ||
        abort.signal.aborted;
      const finishedAt = Date.now();
      const errorText = aborted
        ? "aborted"
        : err instanceof Error
          ? err.message
          : String(err);

      db.update(runs)
        .set({ status: "failed", finishedAt, error: errorText })
        .where(eq(runs.id, runId))
        .run();

      publish(runId, {
        type: "error",
        node: null,
        payload: { message: errorText, aborted }
      });
      publish(runId, {
        type: "done",
        node: null,
        payload: { ok: false, finishedAt, error: errorText }
      });
    } finally {
      active.delete(runId);
    }
  })();

  const handle: EngineHandle = { abort, promise };
  active.set(runId, handle);
  return handle;
}

export function cancelRun(runId: string): boolean {
  const h = active.get(runId);
  if (!h) return false;
  h.abort.abort();
  return true;
}

export function isActive(runId: string): boolean {
  return active.has(runId);
}
