/**
 * openshuki agent utilities (TypeScript).
 *
 * Agents running under openshuki's subprocess runner emit one JSON object per
 * line on stdout. Each object is a `{ type, node?, payload? }` event that the
 * backend translates 1:1 into the run-event bus, the SSE stream, and the
 * persistent `run_events` table.
 *
 * Use these helpers to avoid hand-formatting JSON. They write synchronously
 * line-by-line so the backend gets events live.
 *
 * Event types match the backend's RunEventType vocabulary:
 *   node_start | node_end | token | tool_call | tool_result
 *   custom     | error    | done
 *
 * Anything you write to stdout outside these helpers becomes a `token` event.
 */

export type EventType =
  | "node_start"
  | "node_end"
  | "token"
  | "tool_call"
  | "tool_result"
  | "custom"
  | "error"
  | "done"
  | "artifact"
  | "ask_user"
  | "user_response";

export type EventLine = {
  type: EventType;
  node?: string | null;
  payload?: unknown;
};

/** Emit a single event line to stdout. */
export function emit(line: EventLine): void {
  process.stdout.write(JSON.stringify(line) + "\n");
}

export function nodeStart(node: string, payload?: unknown): void {
  emit({ type: "node_start", node, payload });
}

/** `progress` is forwarded to the runs row so the right-panel bar moves. */
export function nodeEnd(
  node: string,
  payload?: { progress?: number; [k: string]: unknown }
): void {
  emit({ type: "node_end", node, payload });
}

export function token(text: string, node?: string): void {
  emit({ type: "token", node: node ?? null, payload: { text } });
}

export function toolCall(name: string, args?: unknown, node?: string): void {
  emit({ type: "tool_call", node: node ?? null, payload: { name, args } });
}

export function toolResult(
  name: string,
  ok: boolean,
  extra: Record<string, unknown> = {},
  node?: string
): void {
  emit({ type: "tool_result", node: node ?? null, payload: { name, ok, ...extra } });
}

/** Send an arbitrary structured event. Surfaces in the UI as 'custom'. */
export function custom(payload: unknown, node?: string): void {
  emit({ type: "custom", node: node ?? null, payload });
}

/** Report a fatal error. The backend will set the run to failed. */
export function emitError(message: string, extra: Record<string, unknown> = {}): void {
  emit({ type: "error", payload: { message, ...extra } });
}

/**
 * Final event. The backend will synthesize one if the process exits without
 * emitting it, but emitting it explicitly lets you attach a summary payload.
 */
export function done(ok = true, extra: Record<string, unknown> = {}): void {
  emit({ type: "done", payload: { ok, ...extra } });
}

// ---------- artifacts ------------------------------------------------------
//
// An artifact is a piece of output that should outlive the run's event log:
// a markdown summary, a generated image, an audio clip, etc. The backend
// persists artifacts in its `artifacts` table and serves them via
// /api/artifacts/<id>/content. The UI renders them under the run's
// "Artifacts" tab.

export type ArtifactKind = "md" | "text" | "image" | "audio" | "video";

/** Emit a text-shaped artifact (kind='md' or 'text') with inline content. */
export function artifact(
  name: string,
  kind: Extract<ArtifactKind, "md" | "text">,
  content: string,
  opts: { mime?: string; node?: string } = {}
): void {
  const payload: Record<string, unknown> = { name, kind, content };
  if (opts.mime) payload.mime = opts.mime;
  emit({ type: "artifact", node: opts.node ?? null, payload });
}

/**
 * Emit an artifact whose content lives in a file on disk. The backend will
 * copy the file into its managed artifacts directory. Use this for binary
 * kinds ('image' / 'audio' / 'video'); text kinds may also use file mode if
 * more convenient.
 *
 * `path` may be absolute or relative to the tool's working directory.
 */
export function artifactFile(
  name: string,
  kind: ArtifactKind,
  path: string,
  opts: { mime?: string; node?: string } = {}
): void {
  const payload: Record<string, unknown> = { name, kind, path };
  if (opts.mime) payload.mime = opts.mime;
  emit({ type: "artifact", node: opts.node ?? null, payload });
}

// ---------- ask_user (agent ↔ user Q&A) ---------------------------------
//
// Emits an `ask_user` event and returns a promise that resolves with the
// user's answer once the backend writes a `{ type: "user_response", payload:
// { interactionId, answer } }` JSONL line back on this process's stdin.
//
// A single shared stdin reader is initialised lazily on the first call and
// dispatches each response to the matching pending promise by interactionId,
// so multiple concurrent questions are fine.

import { randomUUID } from "node:crypto";

type Resolver = (answer: string) => void;
const pendingResolvers = new Map<string, Resolver>();
let stdinReaderInitialised = false;

function ensureStdinReader(): void {
  if (stdinReaderInitialised) return;
  stdinReaderInitialised = true;
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !obj ||
        typeof obj !== "object" ||
        (obj as { type?: unknown }).type !== "user_response"
      ) {
        continue;
      }
      const payload = (obj as { payload?: unknown }).payload;
      if (!payload || typeof payload !== "object") continue;
      const { interactionId, answer } = payload as {
        interactionId?: unknown;
        answer?: unknown;
      };
      if (typeof interactionId !== "string" || typeof answer !== "string") {
        continue;
      }
      const resolver = pendingResolvers.get(interactionId);
      if (resolver) {
        pendingResolvers.delete(interactionId);
        resolver(answer);
      }
    }
  });
  // We intentionally don't resume()/pause() — node 18+ keeps the readable
  // open for as long as the process is running, which is exactly what we
  // want for an agent that may issue multiple questions over its lifetime.
  // If stdin closes (parent process gone) the loop simply stops firing.
  process.stdin.on("error", () => {
    // best-effort: parent dropped us, nothing to do
  });
}

/**
 * Ask the user a question and await their answer. The agent run pauses (from
 * the user's perspective) until the answer comes back; the JS event loop
 * keeps running, so other async work can continue if you want it to.
 */
export async function askUser(
  prompt: string,
  opts: { choices?: string[]; node?: string } = {}
): Promise<string> {
  ensureStdinReader();
  const interactionId = randomUUID();
  const promise = new Promise<string>((resolve) => {
    pendingResolvers.set(interactionId, resolve);
  });
  const payload: Record<string, unknown> = { interactionId, prompt };
  if (opts.choices && opts.choices.length > 0) payload.choices = opts.choices;
  emit({ type: "ask_user", node: opts.node ?? null, payload });
  return promise;
}
