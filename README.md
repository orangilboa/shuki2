# openshuki

Personal-assistant scaffold: chat with LLMs, run agents, watch them work live.

## Layout

- **`backend/`** — Node + Express + Drizzle + better-sqlite3 (TypeScript). API at `:4000`. Persists conversations, agent runs, run events, artifacts, and LLM endpoints.
- **`frontend/`** — Vite + React + Zustand on `:5173`. Three-panel UI (left: chats / scheduled / agents, center: dynamic, right: live running tasks). Vite proxies `/api` → backend.
- **`agents/`** — Subprocess agents that the backend launches. Demo agents are 2-node LangGraph flows (Python and TypeScript). Communicate over stdout JSONL.
- **`docs/`** — References and how-tos: streaming protocol, database, connecting LLMs, switching to Postgres, authoring agents.

## Run

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env       # fill in any LLM API keys you want
npm run dev                # http://localhost:4000

# 2. Frontend (new terminal)
cd frontend
npm install
npm run dev                # http://localhost:5173

# 3. Agents (one-time, only if you'll run the demo agents)
cd agents
npm install                # @langchain/langgraph for TS agents
pip install -r requirements.txt   # langgraph for Python agents
```

The backend runs an additive schema migration on every boot — no manual migration step.

## Highlights

- **OpenAI-compatible LLM endpoints**: built-in providers via `backend/config/endpoints.json` + user-added via the Settings UI. Aggregated `/v1/models` proxy with caching. Model picker grouped by endpoint, used in chats and agent runs.
- **Subprocess agent protocol**: agents emit `{ type, node?, payload? }` JSON lines on stdout. The runner translates them into a typed event bus, persists to SQLite, and streams to the frontend via SSE. Replay-friendly — late subscribers catch up automatically.
- **Artifacts**: agents can emit markdown / text / images / audio / video. The backend persists, the UI gallery + renderer displays. No special UI code per agent.
- **Live run view**: dedicated tab in the central panel for any agent run, with an event log and an artifacts gallery. Right panel shows live progress for everything currently running.

## Documentation

The agent-facing entry is [CLAUDE.md](CLAUDE.md). It links to:

- Per-area guides: [`backend/CLAUDE.md`](backend/CLAUDE.md), [`frontend/CLAUDE.md`](frontend/CLAUDE.md), [`agents/CLAUDE.md`](agents/CLAUDE.md).
- References: [`docs/protocol.md`](docs/protocol.md), [`docs/db.md`](docs/db.md).
- How-tos: [`docs/connect-llms.md`](docs/connect-llms.md), [`docs/postgres.md`](docs/postgres.md), [`docs/agent-python.md`](docs/agent-python.md), [`docs/agent-typescript.md`](docs/agent-typescript.md).
