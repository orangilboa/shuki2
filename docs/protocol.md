# Run-event protocol

The contract between the openshuki backend and any agent, in-process runner, or future automation that produces events for the UI. This is the most important document to read when changing anything that touches streaming, agent authoring, or the right-panel/run-view UI.

## Why a protocol

Every UI-visible state change for a run is published through a single in-process bus and persisted to the `run_events` table. The frontend SSE stream is a thin pass-through. As a result:

- Anyone who can `bus.publish(runId, partial)` on the backend, or write JSONL on stdout from a subprocess agent, drives the UI without a per-feature backend change.
- A frontend that connects late can replay the run from the DB and seamlessly switch to live updates — both arrive as the same envelope shape.
- New event types are additive: define the type, add a payload shape here, document any UI-side handling. No schema migration.

## Envelope

Every event has the same outer shape:

```ts
type RunEventEnvelope<P = unknown> = {
  runId: string;
  seq: number;          // monotonic per run, assigned by the bus on publish
  ts: number;           // unix ms
  type: RunEventType;
  node: string | null;  // graph node name when applicable; null otherwise
  payload: P;
};
```

- `seq` is the canonical ordering. Use it to dedupe across replay-then-live and to match `artifacts.seq` (artifact rows reuse the bus seq from their event).
- `node` carries the source graph node. The mock engine uses `discovery|planner|executor|verifier|summarizer`; subprocess agents use whatever they want. `null` for `run_started`, `done`, `error`, and any non-graph event.
- `payload` is event-specific. See the table below.

The persisted form in `run_events` stores `payload_json` (text) plus the rest as columns; the SSE form serialises the envelope as JSON in the `data:` field of an `event: run_event` SSE message.

## Vocabulary

`RunEventType` is the union of these strings, defined in `backend/src/runs/events.ts` and mirrored in `frontend/src/types/index.ts`. **Adding a type means updating both, plus the runner's `KNOWN_EVENT_TYPES` set in `backend/src/runs/runners/subprocess.ts`.**

| `type` | Direction | Payload shape | Notes |
|---|---|---|---|
| `run_started` | engine → bus | `{ agentId, name, model, inputs }` | Always seq 1 for a run. Agents never emit this themselves. |
| `node_start` | agent/engine → bus | `<any>` (typically `{ index?, ...}`) | UI shows it in the log. No DB side-effect. |
| `node_end`   | agent/engine → bus | `{ progress?: number, ... }` | When `progress` is a number, the runner writes it to `runs.progress` and sets status to `running`. |
| `token` | agent/engine → bus | `{ text: string }` | Free-form streaming text. Used by agents for log lines and for `_stderr` capture. |
| `tool_call`   | agent/engine → bus | `{ name: string, args?: any }` | LLM function-call event inside the graph. Pair with `tool_result`. |
| `tool_result` | agent/engine → bus | `{ name: string, ok: boolean, ...}` | LLM function-call result. Optional fields like `durationMs` are passed through verbatim. |
| `custom`      | agent/engine → bus | `<any>` | Generic structured event. The UI shows it in the log; agents can use it for anything that doesn't fit another type. |
| `artifact`    | agent → runner → bus | `{ artifactId, name, kind, mime, bytes, hasInlineContent }` | Agent emits with `{ name, kind, content?|path?, mime? }`; the runner persists, then publishes the metadata-only payload above. See "Artifacts". |
| `error`       | agent/engine/runner → bus | `{ message: string, ... }` | Sets the run to failed at finalisation. May be followed by a `done`. |
| `done`        | agent/engine/runner → bus | `{ ok: boolean, ... }` | Optional from agents; the runner synthesises one if a process exits without it. After `done` the UI considers the run terminal. |
| `waiting_for_llm` | agent → bus | `{ waitId?: string, label?: string, model?: string }` | Signals a blocking LLM call. The FE renders a live elapsed-seconds counter until the matching `done_waiting` arrives. Pure UI signal — **no DB side effect**. Pair by `waitId` when present; otherwise the FE pairs by `node` (most-recent unpaired wait wins, LIFO). |
| `done_waiting`    | agent → bus | `{ waitId?: string, durationMs?: number, ok?: boolean }` | Closes the pair opened by `waiting_for_llm`. `durationMs` is the agent's ground-truth timing; the FE prefers it over wall-clock deltas once available. The bare event is dropped from the central log (the paired waiting row carries its information). |

## Subprocess agents — the JSONL surface

Subprocess agents speak the protocol over stdout. Each line is one JSON object matching `{ type, node?, payload? }` with the `type` and `payload` shapes above. Rules:

- One event per line, terminated with `\n`.
- Flush after every write so the UI sees events live (`python -u`, or `process.stdout.write` in Node).
- A line that fails to parse, or parses without a string `type`, becomes a `token` event with `payload: { text: <line> }`. **Don't write raw text to stdout** unless you want it as a token.
- stderr is line-buffered too and emitted as `token` with `node: "_stderr"`. Use stderr for diagnostic noise from libraries you don't control.
- Unknown `type` strings become `custom` events with the original parsed object as payload.
- `protocol: "raw"` agents skip JSONL parsing entirely — every stdout line becomes a `token`.

The helpers in `agents/agent_util.py` and `agents/agent_util.ts` cover every type. Use them rather than hand-formatting JSON.

## Artifacts (the only event with side effects)

When a subprocess agent emits

```json
{"type":"artifact","node":"format",
 "payload":{"name":"report.md","kind":"md","content":"# …"}}
```

the runner intercepts the event before publishing. It validates, sanitises the name, defaults the mime, persists into the `artifacts` table (using the bus-assigned seq), and *then* publishes a different payload to subscribers:

```json
{"type":"artifact",
 "payload":{"artifactId":"<uuid>","name":"report.md","kind":"md",
            "mime":"text/markdown","bytes":155,"hasInlineContent":true}}
```

So the published payload never contains the inline `content` or the original `path` — frontends fetch content via `GET /api/artifacts/:id/content`.

Agent-side rules:

- `content` (string) is allowed for `kind in ["md", "text"]` only. Backend rejects inline binary.
- `path` (string) is allowed for any kind, must be the path of an existing regular file. Relative paths resolve against the agent's `cwd`. The runner copies into `backend/data/artifacts/<runId>/<sanitised-name>` (collisions get `.1`, `.2`, …).
- Don't pass both `content` and `path`. Don't pass neither.
- `mime` is optional. Defaults: `md → text/markdown`, `text → text/plain`, `image → image/png`, `audio → audio/mpeg`, `video → video/mp4`. Override when you know better (e.g. `image/svg+xml`).

Artifact persistence is queued per run, so artifact events stay ordered and the runner won't emit `done` until all pending artifacts have flushed.

## Lifecycle, ordering, replay

- `run_started` is always seq 1; the engine publishes it before delegating to a runner.
- For subprocess agents, after `run_started` the runner publishes whatever the agent emits, in the order received.
- A run terminates when `done` is published (or the process exits — the runner synthesises `done` then). The bus continues to accept publishes after that, but the UI treats the run as terminal.
- Replay: `GET /api/runs/:id/events` reads `run_events` ordered by `seq` first, then live-tails. Subscribers dedupe by `seq` to handle the race window.

## Adding a new event type

1. Add the string to `RunEventType` in `backend/src/runs/events.ts`.
2. Add the same string to `RunEventType` in `frontend/src/types/index.ts`.
3. If subprocess agents should be allowed to emit it, add to `KNOWN_EVENT_TYPES` in `backend/src/runs/runners/subprocess.ts`. Otherwise it'll be coerced into a `custom`.
4. Add a row to the table in this doc with the payload shape and any side effect.
5. If the UI should react (status/progress/etc.), update `ingestEvent` in `frontend/src/store/useStore.ts` and any view-level handler (`RunView`, `RightPanel`).
6. If agents should have a helper, add to `agents/agent_util.py` and `agents/agent_util.ts`. Keep names parallel.

Side-effect events (`artifact` is the only one today) need a special branch in the subprocess runner — see how `runs/artifacts.ts` is wired into `runners/subprocess.ts` for the pattern.

## SSE wire format

Each event sent on `/api/runs/:id/events` and `/api/events` is:

```
event: run_event
data: <JSON envelope>
\n
```

The firehose route prepends a `: connected <ts>\n\n` comment so EventSource opens immediately, and both routes send a `: heartbeat <ts>\n\n` every 15s to keep proxies from killing the connection. Frontends listen with `addEventListener("run_event", …)` — don't use the default `message` event.
