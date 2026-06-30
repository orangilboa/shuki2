# Building an agent in Python

A walkthrough for adding a new Python agent to openshuki, complete with LangGraph integration. Read [agents/CLAUDE.md](../agents/CLAUDE.md) and [docs/protocol.md](protocol.md) first if you want the abstract picture; this doc is the recipe.

## Where to put the code

```
agents/
  <your-agent>/
    main.py            # entrypoint — argparse + LangGraph
    pyproject.toml     # this agent's own deps ([project].dependencies)
    .venv/             # this agent's own virtualenv (created by `pnpm agents:install`; gitignored)
    (other modules)
```

Agents share `agents/agent_util.py` (UTF-8 stdout + JSONL helpers) — your `main.py` imports from there. `agent_util.py` is standard-library only, so it adds no dependencies.

**Each Python agent runs in its own venv** at `agents/<your-agent>/.venv`, and declares its **own** dependencies in `agents/<your-agent>/pyproject.toml`. `pnpm agents:install` (from the repo root) creates the venv with **uv** and installs those deps into it (`uv pip install <dir>`). uv shares identical package versions across agents via a global cache (clone/hardlink), so declaring `langgraph` in several agents stores it once — and uv is auto-installed by the `agents:install` command if you don't already have it. Declare exactly what your agent imports; an agent that only uses the standard library + `agent_util` declares an empty `dependencies` list. Use `agents/weather/pyproject.toml` as the template:

```toml
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "openshuki-agent-<your-agent>"
version = "0.1.0"
requires-python = ">=3.9"
dependencies = ["langgraph>=0.2.0"]   # whatever your main.py imports; [] if stdlib-only

# Metadata-only: install the deps above without trying to package the flat
# main.py script (which imports ../agent_util.py at runtime via sys.path).
[tool.setuptools]
py-modules = []
```

## Skeleton

```python
"""
<agent name> — <one-line description>

Runs as: python -u main.py --foo … --bar …

Arguments come from the openshuki agent form; the runner templates them in
from `exec.args` in the agent config (backend/config/agents.json).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import TypedDict

# Make agent_util importable from the parent agents/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_util import (  # noqa: E402
    artifact, custom, done, emit_error,
    node_end, node_start, token, tool_call, tool_result,
)
from langgraph.graph import StateGraph, START, END  # noqa: E402


class State(TypedDict, total=False):
    # Input fields (filled by main()).
    query: str
    # Intermediate state.
    raw: list[dict]
    # Output.
    summary: str


def fetch_node(state: State) -> State:
    node_start("fetch", {"query": state.get("query")})
    token("calling api…", node="fetch")
    tool_call("api.search", args={"q": state.get("query")}, node="fetch")
    # … real work …
    raw = [{"title": "result 1"}, {"title": "result 2"}]
    tool_result("api.search", ok=True, count=len(raw), node="fetch")
    custom({"kind": "fetch.raw", "rows": raw}, node="fetch")
    node_end("fetch", progress=0.5)
    return {**state, "raw": raw}


def format_node(state: State) -> State:
    node_start("format", {"rows": len(state.get("raw") or [])})
    lines = [f"Results for {state.get('query')}:"]
    for r in state.get("raw") or []:
        lines.append(f"- {r['title']}")
    summary = "\n".join(lines)
    for line in lines:
        token(line, node="format")

    artifact("results.md", "md", "# Results\n\n" + summary, node="format")
    node_end("format", progress=1.0)
    return {**state, "summary": summary}


def build_graph():
    g = StateGraph(State)
    g.add_node("fetch", fetch_node)
    g.add_node("format", format_node)
    g.add_edge(START, "fetch")
    g.add_edge("fetch", "format")
    g.add_edge("format", END)
    return g.compile()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--query", required=True)
    args = p.parse_args()

    try:
        graph = build_graph()
        result = graph.invoke({"query": args.query})
        done(ok=True, summary=result.get("summary", ""))
        return 0
    except Exception as e:  # noqa: BLE001
        emit_error(str(e))
        done(ok=False, error=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
```

Replace the body with the actual graph you want. Anything goes between `node_start` and `node_end`. See `agents/weather/main.py` for a working example.

## Registering the agent

Append to `backend/config/agents.json`:

```jsonc
{
  "id": "<your-agent>",
  "name": "<Display name>",
  "description": "<one-line UI hint>",
  "model": null,
  "inputs": [
    { "name": "query",
      "label": "Query",
      "type": "string",
      "required": true,
      "description": "What to search for." }
  ],
  "exec": {
    "kind": "subprocess",
    "command": "{VENV_PYTHON}",
    "args": ["-u", "{AGENTS_DIR}/<your-agent>/main.py",
             "--query", "{query}"],
    "cwd": "{AGENTS_DIR}/<your-agent>",
    "protocol": "jsonl"
  }
}
```

Field guide:

| Field | Notes |
|---|---|
| `id` | Stable string. Used in run history, dropdowns, and the URL of the in-process FK shadow. Don't rename. |
| `inputs[].type` | `string`, `number`, or `boolean`. The UI generates the right control. |
| `inputs[].required` | If true, the Run button stays disabled until the field is non-empty (or `true` for booleans). |
| `inputs[].default` | Optional. Pre-filled value; also used as the substitution if the user clears the field. |
| `exec.command` | Use `{VENV_PYTHON}` — the runner expands it to this agent's own venv interpreter (`<cwd>/.venv/bin/python`, or `…\Scripts\python.exe` on Windows). The `-u` flag in args 0 disables stdout buffering — leave it. |
| `exec.cwd` | Set to the agent's directory so relative paths in your code work **and** so `{VENV_PYTHON}` resolves to that agent's `.venv`. |
| `exec.protocol` | Always `jsonl` for agents that use `agent_util`. |

Restart the backend (`tsx watch` reloads on save, but config files are read at boot).

## Templating cheatsheet

- `{AGENTS_DIR}` → absolute path to `agents/`.
- `{VENV_PYTHON}` (in `command`/`args`) → this agent's venv interpreter, resolved from `exec.cwd`.
- `{<inputName>}` → string-cast value from the form (with input-spec `default` fallback).
- `${VAR_NAME}` (in `exec.env` only) → `process.env[VAR_NAME] ?? ""`.

To pass an API key from the backend's `.env` to your Python agent:

```jsonc
"exec": {
  "kind": "subprocess",
  "command": "{VENV_PYTHON}",
  "args": ["-u", "{AGENTS_DIR}/<agent>/main.py", "--query", "{query}"],
  "cwd": "{AGENTS_DIR}/<agent>",
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  },
  "protocol": "jsonl"
}
```

In `main.py`: `import os; key = os.environ["OPENAI_API_KEY"]`.

## Calling an LLM

If your agent needs to call an LLM, the model id is delivered as a string of the form `<endpointId>::<modelId>` — either via the `--model` CLI arg you template from `{model}` (you'd need a `model` input on your agent, with `default` set), OR from `run_started` if you decide to read the SSE stream yourself (don't — too much work).

The simplest pattern: have a `model` input on your agent form, template it as `--model "{model}"` in args, and parse on the Python side. For now you also need to know the base URL + key — set them as env vars in the `exec.env` block referencing the right `${…}` env:

```jsonc
"env": {
  "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}",
  "OPENAI_API_KEY":     "${OPENAI_API_KEY}"
}
```

Then in your agent:

```python
import os
from openai import OpenAI

# model arg looks like "openrouter::anthropic/claude-3.5-sonnet"
endpoint_id, _, model_id = args.model.partition("::")
base_urls = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}
api_keys = {
    "openai": os.environ.get("OPENAI_API_KEY"),
    "openrouter": os.environ.get("OPENROUTER_API_KEY"),
}
client = OpenAI(base_url=base_urls[endpoint_id], api_key=api_keys[endpoint_id])
resp = client.chat.completions.create(model=model_id, messages=[...])
```

A future helper will resolve base URL + key from the backend automatically and pass them in env vars (`OPENSHUKI_BASE_URL` / `OPENSHUKI_API_KEY`). For now, hard-code the lookup or pass per-agent envs.

## Streaming progress correctly

- `node_start` / `node_end` mark graph node boundaries. `progress` (0–1) on `node_end` advances the right-panel bar.
- `token(text, node=...)` is the right thing for incremental output (LLM stream chunks, log lines).
- Don't `print()` to stdout outside `agent_util` helpers. Anything raw becomes a `token` event with the literal text — usually fine but it bypasses your structure.
- For diagnostics, write to stderr (`print(..., file=sys.stderr)`). The backend captures stderr as `token` events with `node: "_stderr"` — visible in the log but clearly separated.

## Producing artifacts

For markdown / text reports:

```python
artifact("summary.md", "md", "# Done\n…", node="format")
```

For binary outputs (charts, audio, generated images):

```python
# Write the file under your agent's cwd, then point the artifact at it.
import matplotlib.pyplot as plt
plt.figure(); plt.plot([1, 2, 3]); plt.savefig("chart.png")
artifact_file("chart.png", "image", "./chart.png", node="render")
```

The runner copies the file into `backend/data/artifacts/<runId>/<sanitised-name>` and serves it via `GET /api/artifacts/<id>/content`. You don't need to clean up — collisions get auto-suffixed and the file is owned by the run lifecycle going forward.

## Dev loop

1. Run standalone first to validate the JSONL output:

   ```bash
   cd agents
   python -u <your-agent>/main.py --query "hello"
   ```

   Expect to see `{"type":"node_start",...}` lines. Pipe through `python -m json.tool` if you want pretty-printing per-line:

   ```bash
   python -u <your-agent>/main.py --query "hello" \
     | while read -r line; do echo "$line" | python -m json.tool -; done
   ```

2. Add the entry in `backend/config/agents.json`, then run `pnpm agents:install` to create the agent's venv and install its deps. Restart the backend.

3. Pick the agent in the left panel of the UI. Run it. Watch the Logs tab for events and the Artifacts tab for any artifacts you emitted.

4. End-to-end via curl:

   ```bash
   curl -X POST http://localhost:4000/api/agents/<your-agent>/run \
     -H 'content-type: application/json' \
     -d '{"inputs":{"query":"hello"}}'
   # → { "id": "<runId>", ... }

   curl -N "http://localhost:4000/api/runs/<runId>/events"
   curl  "http://localhost:4000/api/runs/<runId>/artifacts"
   ```

## Common pitfalls

- **Buffered stdout**: forgetting `python -u` (or `sys.stdout.flush()`) means the UI shows nothing until the process exits. The `agent_util.emit()` already calls `flush()` after every line, but `python -u` is belt-and-braces — keep it in `args`.
- **Encoding on Windows**: `agent_util` reconfigures stdout to UTF-8 on import. Don't write to a different encoding (e.g. open files in non-utf8 mode and pipe their contents). Stick to UTF-8.
- **LangGraph's pending-deprecation warning**: `langgraph.checkpoint.serde.jsonplus` triggers a `LangChainPendingDeprecationWarning` on import. It surfaces as a `_stderr` token event the first time. Harmless. Suppress with `warnings.filterwarnings("ignore", category=DeprecationWarning)` if it bothers you.
- **Crashing on import**: a syntax error in your agent fails the spawn before any event is emitted. The runner sees a non-zero exit, synthesises an `error` + `done`, and the UI shows the run as failed. The actual traceback comes through stderr — check the run's log tab.
- **State mutation between nodes**: LangGraph's `StateGraph` merges return values into state. Return only the keys you want to update; everything else carries over. With `TypedDict, total=False`, missing keys are just `None`/absent.
- **Long-running graphs**: there's no per-node timeout in the runner today. If your agent hangs, the user can hit "Cancel" in the right panel — the runner sends SIGTERM, then SIGKILL after 1s.
