// Subprocess runner: spawns a child process, line-buffers stdout/stderr,
// translates JSONL events into bus.publish calls, and updates the runs row.
//
// Templating rules:
//   - In `args` strings, `cwd`, and `env` values:
//       {AGENTS_DIR}     -> repo-root/agents
//       {<inputName>}    -> string-cast value from `inputs` (default fallback)
//   - In `env` values only:
//       ${VAR_NAME}      -> process.env[VAR_NAME] ?? "" (no error on missing)
//
// Event vocabulary mapping mirrors RunEventType. Unknown JSONL `type` fields
// become `custom` events with the original parsed object as payload.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { runs } from "../../db/schema.js";
import type { AgentExec, AgentInput } from "../../types/index.js";
import { flush, publish } from "../bus.js";
import { persistArtifact, type RawArtifactPayload } from "../artifacts.js";
import type { RunEventType } from "../events.js";
import {
  cancelPendingForRun,
  createInteraction,
  registerWriter,
  unregisterWriter
} from "../interactions/store.js";
import type { Readable, Writable } from "node:stream";

const KNOWN_EVENT_TYPES: ReadonlySet<RunEventType> = new Set<RunEventType>([
  "run_started",
  "node_start",
  "node_end",
  "token",
  "tool_call",
  "tool_result",
  "custom",
  "error",
  "done",
  "artifact",
  "ask_user",
  "user_response",
  "waiting_for_llm",
  "done_waiting"
]);

export type RunSubprocessArgs = {
  runId: string;
  agentId: string;
  agentName: string;
  exec: Extract<AgentExec, { kind: "subprocess" }>;
  inputs: Record<string, unknown>;
  inputSpec?: AgentInput[];
  model: string | null;
  signal: AbortSignal;
};

/**
 * Resolve the absolute path of the repo's `agents/` directory.
 *
 * Assumption: backend runs with cwd=`backend/` (true for `pnpm dev`,
 * `npm start`, `tsx src/server.ts`). We resolve `..` from cwd. Falls back to
 * `<cwd>/agents` if `..` doesn't exist (e.g. running from repo root for tests).
 */
function resolveAgentsDir(): string {
  const fromCwdParent = path.resolve(process.cwd(), "..", "agents");
  return fromCwdParent;
}

function expandTemplate(
  template: string,
  inputs: Record<string, unknown>,
  spec: AgentInput[],
  agentsDir: string
): string {
  // Process {VAR} placeholders. {AGENTS_DIR} is special; everything else is
  // an input name.
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    if (key === "AGENTS_DIR") return agentsDir;
    if (Object.prototype.hasOwnProperty.call(inputs, key)) {
      const v = inputs[key];
      if (v === null || v === undefined) {
        const def = spec.find((s) => s.name === key)?.default;
        return def === undefined ? "" : String(def);
      }
      return String(v);
    }
    const def = spec.find((s) => s.name === key)?.default;
    if (def !== undefined) return String(def);
    return "";
  });
}

function expandEnvValue(
  template: string,
  inputs: Record<string, unknown>,
  spec: AgentInput[],
  agentsDir: string
): string {
  // First the `${VAR}` env interpolation, then the `{...}` template.
  const envInterpolated = template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_m, name: string) => process.env[name] ?? ""
  );
  return expandTemplate(envInterpolated, inputs, spec, agentsDir);
}

type LineSink = (line: string) => void;

function pumpLines(stream: Readable, sink: LineSink): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.length > 0) sink(line);
    }
  });
  stream.on("end", () => {
    const tail = buf.replace(/\r$/, "");
    if (tail.length > 0) sink(tail);
    buf = "";
  });
}

export async function runSubprocess(args: RunSubprocessArgs): Promise<void> {
  const { runId, exec, inputs, signal } = args;
  const inputSpec = args.inputSpec ?? [];
  const agentsDir = resolveAgentsDir();

  // ---------- expand templates ----------
  const expandedArgs = exec.args.map((a) =>
    expandTemplate(a, inputs, inputSpec, agentsDir)
  );
  const expandedCwd =
    exec.cwd !== undefined
      ? expandTemplate(exec.cwd, inputs, inputSpec, agentsDir)
      : undefined;

  const expandedEnv: Record<string, string> = {};
  if (exec.env) {
    for (const [k, v] of Object.entries(exec.env)) {
      expandedEnv[k] = expandEnvValue(v, inputs, inputSpec, agentsDir);
    }
  }

  // ---------- state ----------
  let doneEmitted = false;
  let errorEmitted = false;
  let finalized = false;
  // Lightweight monotonic counter used solely as a fallback name suffix
  // (e.g. "artifact-3") when an agent emits an artifact without a usable name.
  // The authoritative `seq` is assigned by bus.publish.
  let artifactCount = 0;
  // Serialize artifact persistence so emit-order is preserved on the bus,
  // and so we can flush all in-flight work before publishing the terminal
  // `done` event below.
  let artifactQueue: Promise<void> = Promise.resolve();
  // Same idea for interactions: persisting the row before publishing the
  // event keeps DB and event-log ordering aligned for late subscribers.
  let interactionQueue: Promise<void> = Promise.resolve();

  async function finalize(opts: {
    ok: boolean;
    code: number | null;
    errorText?: string;
  }): Promise<void> {
    if (finalized) return;
    finalized = true;
    const finishedAt = Date.now();
    await db
      .update(runs)
      .set({
        status: opts.ok ? "succeeded" : "failed",
        finishedAt,
        ...(opts.errorText ? { error: opts.errorText } : {})
      })
      .where(eq(runs.id, runId));
  }

  function publishEvent(type: RunEventType, node: string | null, payload: unknown): void {
    if (type === "done") doneEmitted = true;
    if (type === "error") errorEmitted = true;
    publish(runId, { type, node, payload });
  }

  // ---------- spawn ----------
  // On Windows we must use shell:true so Node can resolve `.cmd`/`.bat`
  // shims (npx, tsx-via-npm, etc.). With shell:true, arguments must be
  // hand-quoted to survive cmd.exe parsing.
  const onWindows = process.platform === "win32";
  const useShell = onWindows;
  const quoteForWinShell = (a: string): string => {
    if (a.length === 0) return '""';
    if (!/[\s"&|<>^()]/.test(a)) return a;
    return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  };
  const finalArgs = useShell ? expandedArgs.map(quoteForWinShell) : expandedArgs;
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = spawn(exec.command, finalArgs, {
      cwd: expandedCwd,
      env: { ...process.env, ...expandedEnv },
      // stdin is `pipe` so the backend can deliver answers to ask_user prompts
      // back into the agent process as JSONL on its stdin.
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    publishEvent("error", null, { message: `spawn failed: ${msg}` });
    publishEvent("done", null, { ok: false, error: msg });
    await finalize({ ok: false, code: null, errorText: msg });
    return;
  }

  // ---------- interaction writer ----------
  // Register a writer the routes layer can call to deliver a user_response
  // back into this process. Returns true if the JSON line was successfully
  // queued onto stdin; false if the pipe was already closed/destroyed.
  registerWriter(runId, ({ interactionId, answer }) => {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      const line = JSON.stringify({
        type: "user_response",
        payload: { interactionId, answer }
      });
      return stdin.write(line + "\n");
    } catch {
      return false;
    }
  });

  // Don't crash the backend if the agent process dies between us asking and
  // it reading — node fires 'error' on the stdin pipe in that case.
  if (child.stdin) {
    child.stdin.on("error", () => {
      // best-effort delivery; we don't surface this to the run event log
    });
  }

  // ---------- stdout ----------
  pumpLines(child.stdout, (line) => {
    if (exec.protocol === "jsonl") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        publishEvent("token", null, { text: line });
        return;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        const obj = parsed as {
          type: string;
          node?: unknown;
          payload?: unknown;
        };
        const node = typeof obj.node === "string" ? obj.node : null;
        const payload = obj.payload ?? {};
        if (KNOWN_EVENT_TYPES.has(obj.type as RunEventType)) {
          const evType = obj.type as RunEventType;
          if (evType === "ask_user") {
            // Persist the question to agent_interactions, then publish.
            // Use the agent-supplied interactionId if present so the agent's
            // internal stdin reader can match the response by id.
            const rawPayload =
              payload && typeof payload === "object"
                ? (payload as {
                    interactionId?: unknown;
                    prompt?: unknown;
                    choices?: unknown;
                  })
                : {};
            const interactionId =
              typeof rawPayload.interactionId === "string" &&
              rawPayload.interactionId.length > 0
                ? rawPayload.interactionId
                : randomUUID();
            const prompt =
              typeof rawPayload.prompt === "string" ? rawPayload.prompt : "";
            const choices =
              Array.isArray(rawPayload.choices) &&
              rawPayload.choices.every((c) => typeof c === "string")
                ? (rawPayload.choices as string[])
                : null;
            const normalisedPayload = {
              interactionId,
              prompt,
              ...(choices ? { choices } : {})
            };
            interactionQueue = interactionQueue.then(async () => {
              try {
                await createInteraction({
                  id: interactionId,
                  runId,
                  prompt,
                  choices
                });
              } catch (err) {
                const reason =
                  err instanceof Error ? err.message : String(err);
                publishEvent("token", null, {
                  text: `[interaction persist failed: ${reason}]`
                });
              }
            });
            publishEvent(evType, node, normalisedPayload);
            return;
          }
          if (evType === "artifact") {
            // Artifact events take a separate path: persist to disk/DB and
            // republish via the bus (which assigns the seq used in the row).
            // Serialize so emit-order is preserved across artifacts.
            artifactCount += 1;
            const fallbackSeq = artifactCount;
            const rawPayload =
              payload && typeof payload === "object"
                ? (payload as RawArtifactPayload)
                : ({} as RawArtifactPayload);
            artifactQueue = artifactQueue.then(async () => {
              try {
                await persistArtifact({
                  runId,
                  cwd: expandedCwd,
                  payload: rawPayload,
                  fallbackSeq
                });
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                publishEvent("token", null, {
                  text: `[artifact rejected: ${reason}]`
                });
              }
            });
            return;
          }
          publishEvent(evType, node, payload);
          // Side-effect: progress updates from node_end → runs.progress.
          if (
            evType === "node_end" &&
            payload &&
            typeof payload === "object" &&
            typeof (payload as { progress?: unknown }).progress === "number"
          ) {
            const progress = (payload as { progress: number }).progress;
            // Fire-and-forget: progress updates are non-critical and we don't
            // want to block the line-reader. Errors are logged and swallowed.
            void db
              .update(runs)
              .set({ progress, status: "running" })
              .where(eq(runs.id, runId))
              .catch((err: unknown) => {
                console.error(
                  `[subprocess] progress update failed run=${runId}:`,
                  err instanceof Error ? err.message : err
                );
              });
          }
        } else {
          // Unknown type → bundle into `custom`.
          publishEvent("custom", node, parsed);
        }
      } else {
        // JSON, but not our envelope shape → treat as token-with-payload.
        publishEvent("token", null, { text: line });
      }
    } else {
      // raw protocol
      publishEvent("token", null, { text: line });
    }
  });

  // ---------- stderr ----------
  pumpLines(child.stderr, (line) => {
    publishEvent("token", "_stderr", { text: line });
  });

  // ---------- abort handling ----------
  let killTimer: NodeJS.Timeout | null = null;
  const onAbort = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // On Windows we spawn through cmd.exe (shell:true) so `.cmd` shims resolve.
    // `child.kill()` only signals the shell, orphaning the real agent process
    // (which keeps the stdout pipe open, so `close` never fires and the run is
    // stuck "running"). Kill the whole tree with taskkill /T instead.
    if (onWindows && child.pid !== undefined) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true
        });
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1000);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  // ---------- spawn errors (ENOENT etc.) ----------
  // `spawn` may emit 'error' asynchronously even though sync construction
  // succeeded. Handle that, then let `close` finish the lifecycle.
  let spawnErrText: string | null = null;
  child.on("error", (err: Error) => {
    spawnErrText = err.message;
    if (!errorEmitted) {
      publishEvent("error", null, { message: err.message });
    }
  });

  // ---------- exit ----------
  await new Promise<void>((resolve) => {
    child.on("close", async (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);

      // Flush any in-flight artifact persistence so the artifact events land
      // before the terminal `done` and are observable on replay/firehose.
      try {
        await artifactQueue;
      } catch {
        // persistArtifact swallows its own errors via the queue's catch path.
      }
      // Same for interaction persistence — we want the rows committed before
      // we cancel the still-pending ones below.
      try {
        await interactionQueue;
      } catch {
        // best-effort
      }

      // Stop accepting answer-deliveries for this run, then mark any
      // unanswered questions as cancelled so the UI can clear its badges.
      unregisterWriter(runId);
      try {
        await cancelPendingForRun(runId);
      } catch (err) {
        console.error(
          `[subprocess] cancelPendingForRun run=${runId}:`,
          err instanceof Error ? err.message : err
        );
      }

      const aborted = signal.aborted;
      const exitCode = code;

      if (aborted) {
        if (!errorEmitted) {
          publishEvent("error", null, { message: "aborted", aborted: true });
        }
        if (!doneEmitted) {
          publishEvent("done", null, { ok: false, error: "aborted", aborted: true });
        }
        await finalize({ ok: false, code: exitCode, errorText: "aborted" });
        // Wait for the bus to persist + fan out the terminal events before
        // resolving; otherwise the engine promise can settle before
        // subscribers have observed `done`.
        await flush(runId);
        resolve();
        return;
      }

      const ok = !spawnErrText && exitCode === 0;
      if (!ok && !errorEmitted) {
        const msg = spawnErrText ?? `exited with code ${exitCode}`;
        publishEvent("error", null, { message: msg, code: exitCode, signal: sig });
      }
      if (!doneEmitted) {
        publishEvent("done", null, {
          ok,
          code: exitCode,
          ...(sig ? { signal: sig } : {})
        });
      }
      await finalize({
        ok,
        code: exitCode,
        errorText: ok ? undefined : spawnErrText ?? `exited with code ${exitCode}`
      });
      await flush(runId);
      resolve();
    });
  });
}
