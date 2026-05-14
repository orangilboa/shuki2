# LangGraph Platform OSS — setup

This doc covers the migration of openshuki's run engine to LangGraph Platform OSS.
This is **Phase A** infrastructure: the platform is registered and runnable but
the openshuki backend doesn't talk to it yet (Phase C wires the runner).

## Files

- `langgraph.json` (repo root) — registers each agent graph with the LangGraph CLI.
  References the existing `build_graph` / `buildGraph` factory functions; no agent
  refactor needed for Phase A.
- `docker-compose.langgraph.yml` (repo root) — self-hosted Lite stack: `langgraph-api`,
  `langgraph-postgres`, `langgraph-redis`. The `langgraph-api` image is built from
  this repo via `langgraph build`.
- `backend/.env.example` — adds `LANGGRAPH_URL` and `LANGGRAPH_API_KEY` for the
  upcoming runner.

## Run locally (no Docker — fastest path)

```bash
pip install --user "langgraph-cli[inmem]"
langgraph dev
```

Studio opens at <https://smith.langchain.com/studio/?baseUrl=http://localhost:2024>.
Both `weather` and `traffic` should be listed as assistants. Use the input panel
to invoke them and inspect graph traces.

## Run with Docker (closer to production)

```bash
# 1. Build a custom image that bakes the graphs in.
langgraph build -t openshuki-langgraph

# 2. Bring up the stack.
docker compose -f docker-compose.langgraph.yml up -d

# 3. Verify.
curl http://localhost:2024/ok
curl http://localhost:2024/assistants/search -X POST \
  -H 'content-type: application/json' -d '{}'
```

The Postgres in this compose file is **separate** from openshuki's Postgres
(different host port `5433` to avoid collision). Run state for LangGraph itself
(threads, checkpoints) lives there; openshuki's `runs` / `run_events` /
`artifacts` continue to live in the openshuki DB.

## Multi-runtime note

`langgraph.json` lists both Python and TS graphs. The CLI routes each by file
extension; `langgraph dev` runs Python in-process and TS via a Node companion.
The docker image bakes both runtimes when both `python_version` and
`node_version` are set.

If you only need one runtime, drop the unused field and the corresponding
graph entry — the CLI then skips installing the other toolchain.

## Phase A scope

- [x] `langgraph.json` written.
- [x] `docker-compose.langgraph.yml` written.
- [x] `backend/.env.example` documents `LANGGRAPH_URL`.
- [x] `agents/traffic/main.ts` guards `void main()` so the module can be imported
      without auto-running the CLI shim (otherwise `langgraph dev` would crash on
      missing `--origin`/`--destination`).

## Not yet (later phases)

- **Phase B** — refactor `weather/main.py` and `traffic/main.ts` to emit events via
  `get_stream_writer()` instead of stdout JSONL. Keep `main()` as a CLI shim so the
  legacy subprocess runner still works during the cutover.
- **Phase C** — `backend/src/runs/runners/langgraph.ts`: a thin SDK adapter that
  streams from the platform and republishes to the existing event bus. New
  `exec.kind: "langgraph"` variant in agent metadata.
- **Phase D** — flip built-in agents in `backend/config/agents.json` from
  `subprocess` to `langgraph`.
