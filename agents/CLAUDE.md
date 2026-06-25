# Agents — author guide

An "agent" is an executable that the openshuki backend launches as a child process when the user clicks "Run agent" in the UI. Agents communicate with the backend over **stdout JSON Lines** — one event per line. The runner translates those events into our run-event bus, persists them, and streams to the frontend.

This is the doc to read when adding or modifying an agent. For the wire-level protocol, see [../docs/protocol.md](../docs/protocol.md). For full step-by-step walkthroughs, see [../docs/agent-python.md](../docs/agent-python.md) or [../docs/agent-typescript.md](../docs/agent-typescript.md).

## Layout

```
agent_util.py        Python helpers — emit/node_start/node_end/token/.../artifact/done.
agent_util.ts        TS helpers — same surface, camelCased.
package.json         Shared TS deps (@langchain/langgraph, tsx, typescript).
tsconfig.json        Shared tsconfig — `tsc --noEmit` checks every agent together.
requirements.txt     Shared Python deps (langgraph, langchain-core) — installed into every Python agent's venv.
weather/             Demo: 2-node Python LangGraph (fetch → format).
  .venv/             Per-agent virtualenv (created by `pnpm agents:install`; gitignored).
traffic/             Demo: 2-node TS LangGraph (lookup → summarize).
```

## Python agents get their own venv

Each Python agent runs in its **own** virtualenv at `agents/<name>/.venv`, so one agent's dependencies can never collide with another's. `pnpm agents:install` (run from the repo root) walks every agent directory containing a `main.py`, creates the venv if it's missing, and installs the shared `agents/requirements.txt` plus the agent's own `agents/<name>/requirements.txt` (if present) into it.

The config wires this up via the `{VENV_PYTHON}` template token: a Python agent sets `"command": "{VENV_PYTHON}"`, which the subprocess runner expands to `<cwd>/.venv/bin/python` (or `…\Scripts\python.exe` on Windows) — `<cwd>` being the agent's working directory. So **a Python agent's `exec.cwd` must point at its own directory** (e.g. `"{AGENTS_DIR}/weather"`), which is also where its `.venv` lives. TypeScript agents need no venv and keep `"command": "npx"`.

Pick a language per agent — Python or TypeScript both work. Use whichever fits the libraries you need.

## How an agent is wired up

1. **Code** lives in a subdirectory of `agents/` (one per agent).
2. **Config** registers the agent as built-in in `backend/config/agents.json`. Backend restart picks up the change.
3. **Form** auto-generates from the `inputs` array in the config — no UI code.
4. **Run dispatch** is generic: the backend spawns `command` with `args` (templated from form values), captures stdout/stderr, and surfaces every event to the frontend.

To register an agent, append an entry under `"agents"` in `backend/config/agents.json`:

```json
{
  "id": "weather",
  "name": "Weather forecast",
  "description": "Mock multi-day weather forecast for a city.",
  "model": null,
  "inputs": [
    { "name": "location", "label": "City",  "type": "string", "required": true },
    { "name": "days",     "label": "Days",  "type": "number", "default": 3 }
  ],
  "exec": {
    "kind": "subprocess",
    "command": "python",
    "args": ["-u", "{AGENTS_DIR}/weather/main.py",
             "--location", "{location}", "--days", "{days}"],
    "cwd": "{AGENTS_DIR}/weather",
    "protocol": "jsonl"
  }
}
```

Templating in `args`, `cwd`, and `env` values:

| Token | Resolves to |
|---|---|
| `{AGENTS_DIR}` | absolute path to this `agents/` directory |
| `{<inputName>}` | string-cast value from the form (input-spec `default` if missing) |
| `${VAR_NAME}` (in `env` block only) | `process.env[VAR_NAME] ?? ""` |

Use `python -u` for Python agents — the `-u` flag disables stdout buffering so events appear in the UI in real time. For TS, prefer `npx tsx agents/<agent>/main.ts` (the runner handles Windows `.cmd` resolution automatically).

## The protocol — quick reference

Each line on stdout is one JSON object: `{ "type": <event-type>, "node": <string?>, "payload": <any> }`. Line-buffered: end every line with `\n` and flush. Anything that fails to parse becomes a `token` event. stderr is captured too and appears as `token` events with `node: "_stderr"`.

Vocabulary (use the `agent_util` helpers — don't hand-format):

| Event | When |
|---|---|
| `node_start` | Entering a graph node. Payload is whatever's useful for debugging. |
| `node_end` | Leaving a node. Include `progress` (0–1) on payload to advance the right-panel bar. |
| `token` | An incremental text fragment. Payload `{ text }`. |
| `tool_call` / `tool_result` | An LLM tool/function call inside the graph. Pair them. |
| `custom` | Anything structured you want surfaced verbatim. |
| `artifact` | A piece of output (md/text/image/audio/video) — see "Artifacts" below. |
| `ask_user` | Pause the run to request input from the user. Use the `ask_user` / `askUser` helper — see "Asking the user" below. Payload `{ interactionId, prompt, choices? }`. |
| `user_response` | Emitted by the **backend** (not by your agent) when the user answers. Payload `{ interactionId, answer }`. The matching JSONL line is also written to your stdin so the helper can resolve. |
| `error` | A fatal error message. The backend will set the run to failed. |
| `done` | Final event with `{ ok, ...summary }`. Optional — if you exit cleanly, the runner synthesises one. |
| `waiting_for_llm` / `done_waiting` | Wrap a blocking LLM call so the UI shows a live elapsed-seconds counter. Use the `llm_wait` / `withLlmWait` helper rather than emitting by hand — it pairs the events with a `waitId` and records the duration. |

Full payload shapes are in [../docs/protocol.md](../docs/protocol.md).

## Helpers

### Python (`agent_util.py`)

```python
from agent_util import (
    node_start, node_end, token, tool_call, tool_result,
    custom, artifact, artifact_file, emit_error, done,
    llm_wait,
)

node_start("fetch", {"location": "Tokyo"})
token("looking up Tokyo…", node="fetch")
with llm_wait("calling forecast model", node="fetch"):
    response = call_llm(...)  # UI shows a live elapsed-seconds counter
artifact("forecast.md", "md", "# Tokyo\n…")
node_end("fetch", progress=0.5)
done(ok=True, summary="Forecast ready")
```

The module forces `sys.stdout` to UTF-8 on import (Windows safety — the default cp1252 mangles `°`/`µ`/etc.). Don't `print()` to stdout outside the helpers — anything raw becomes a `token` event.

### TypeScript (`agent_util.ts`)

```ts
import {
  nodeStart, nodeEnd, token, toolCall, toolResult,
  custom, artifact, artifactFile, emitError, done,
  withLlmWait,
} from "../agent_util.js";

nodeStart("lookup", { origin, destination });
token(`hitting maps API…`, "lookup");
const result = await withLlmWait("calling traffic model", () => callLlm(...), { node: "lookup" });
artifact("traffic.md", "md", `# Traffic\n…`);
nodeEnd("lookup", { progress: 0.5 });
done(true, { summary: "ETA ~46 min" });
```

The TS helpers write directly to `process.stdout`. Same JSON-per-line contract.

## Artifacts

Anything you want preserved past the live run goes through `artifact` events. The runner persists them and exposes them under the run's "Artifacts" tab in the UI.

```python
# Inline (md or text only):
artifact("summary.md", "md", "# Done\n…", node="format")

# File on disk (any kind, required for binary):
artifact_file("chart.png", "image", "./chart.png", node="render")
# `path` may be absolute or relative to the agent's cwd.
```

The runner copies file-path artifacts into `backend/data/artifacts/<runId>/<sanitised-name>`, dedupes name collisions, defaults the mime by kind, and serves the content via `GET /api/artifacts/<id>/content`. Agents never touch the artifact directory directly.

Constraints:
- Inline `content` is allowed only for `md` and `text` kinds.
- `image` / `audio` / `video` require a `path` (the runner won't accept inline binary).
- `name` is sanitised to filesystem-safe characters; bad names fall back to `artifact-<seq>`.
- Don't pass both `content` and `path` in the same event; one or the other.

## Asking the user

An agent can pause and request input from the user mid-run. The helper emits an `ask_user` event, blocks until the backend writes a matching `user_response` JSONL line back on stdin, then returns the answer string. The question is also persisted in the `agent_interactions` table so the UI can list outstanding prompts and badge the right panel.

```python
# Python — sync (matches existing demo style)
from agent_util import ask_user
name = ask_user("What is your name?", node="greet")
choice = ask_user("Continue?", choices=["Yes", "No"], node="confirm")

# Python — asyncio variant (delegates to the same stdin reader)
from agent_util import ask_user_async
name = await ask_user_async("What is your name?", node="greet")
```

```ts
// TypeScript
import { askUser } from "../agent_util.js";
const name = await askUser("What is your name?", { node: "greet" });
const choice = await askUser("Continue?", { choices: ["Yes", "No"], node: "confirm" });
```

Notes:
- The helper generates an `interactionId` and embeds it in both the `ask_user` event and the expected `user_response` reply, so multiple concurrent questions resolve correctly regardless of the order the user answers them.
- `choices` is a hint for the UI (it may render quick-select buttons). The user can always type a free-form answer.
- If the run is cancelled or the process exits with a question still pending, the row's status is set to `cancelled` and your `ask_user` call may never return — make sure your top-level loop handles `KeyboardInterrupt` / unhandled rejections so the process can shut down cleanly.

## Adding a new agent — checklist

1. `mkdir agents/<name>` and write `main.py` or `main.ts`. Import helpers from the parent dir.
2. Run it standalone first — the JSONL output should already look right:
   ```bash
   python -u agents/<name>/main.py --... | head
   npx tsx agents/<name>/main.ts --...     # from inside agents/
   ```
3. Add an entry to `backend/config/agents.json` (id, name, inputs, exec block). For a Python agent, use `"command": "{VENV_PYTHON}"` and point `"cwd"` at the agent's own directory.
4. Run `pnpm agents:install` from the repo root to create the agent's `.venv` and install its deps.
5. Restart the backend (`tsx watch` will pick up the schema/migrate; agents.json is read once on boot).
6. Open the frontend; the new agent shows up in the left panel under "Agents" with an auto-generated form.
7. (Optional) Add deps: shared Python deps go in `agents/requirements.txt`; agent-specific Python deps go in `agents/<name>/requirements.txt`; TS deps go in `agents/package.json`. Re-run `pnpm agents:install` (Python) or `pnpm install` at the workspace root (TS).

## Constraints / tips

- **Always end your agent with a clean exit code** (0 on success, non-zero on failure). The runner writes `runs.status = "failed"` on non-zero exit if no `error`/`done` was emitted explicitly.
- **`done` is optional but recommended** when you have a final summary worth attaching. Pass it as `done(ok=True, summary="…")`.
- **Don't use stdout for anything but JSONL events**. If you call a library that prints to stdout, redirect to stderr (Python: `print(..., file=sys.stderr)` or `logging.basicConfig()`; Node: `console.error(...)`). stderr lines become `token` events tagged with `node: "_stderr"` — you'll see them in the log but they won't pollute the protocol.
- **Models**: the `model` selected in the UI is forwarded as `run_started.payload.model` (format `<endpointId>::<modelId>`) — your agent can inspect it and call the right LLM. The mapping from endpoint id to base URL + key is the backend's responsibility (see `backend/src/endpoints/`); for a future agent that calls an LLM directly, you'll want the backend to forward the resolved base URL + key as env vars in the `exec.env` block.
- **Don't write files outside your cwd or `data/artifacts/<runId>/`**. The runner doesn't enforce this, but stuff outside is unmanaged.
- **TypeScript agents run via `tsx`**, not pre-compiled. The shared `agents/tsconfig.json` is `noEmit: true` — used only for type-checking. If you need a compile step, do it in your agent's own subdirectory.
