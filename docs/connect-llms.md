# Connecting openshuki to LLMs

openshuki talks to any **OpenAI-compatible** API — that's the only contract. Anything that exposes `GET /v1/models` and `POST /v1/chat/completions` works: the official OpenAI API, OpenRouter, Together, Groq, Fireworks, Anyscale, vLLM, LM Studio, llama.cpp, Ollama (`/v1` shim), Azure OpenAI, etc.

There are two ways to add an endpoint: a **built-in** (committed to source) and a **user endpoint** (added via the Settings UI, stored in the DB).

## TL;DR

1. Pick an OpenAI-compatible provider, get a base URL and an API key.
2. Either add an entry to `backend/config/endpoints.json` and put the key in `.env`, **or** add it via the Settings cogwheel in the UI.
3. The model dropdown next to "Send" / on the Agent form is automatically populated from `GET /v1/models` on every configured endpoint, grouped by endpoint display name.

## Built-in endpoints (config file)

`backend/config/endpoints.json` ships with three samples:

```json
{
  "endpoints": [
    {
      "id": "openai",
      "displayName": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    {
      "id": "openrouter",
      "displayName": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    {
      "id": "ollama-local",
      "displayName": "Ollama (local)",
      "baseUrl": "http://localhost:11434/v1",
      "apiKeyEnv": null
    }
  ]
}
```

Field-by-field:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable string, used in dropdown values (`<endpointId>::<modelId>`). Don't change after the fact — existing chats and runs reference it. |
| `displayName` | yes | What the UI shows. |
| `baseUrl` | yes | OpenAI-compatible base. Must include `/v1` if the provider uses one. Trailing slash optional. |
| `apiKeyEnv` | yes | Name of the env var that holds the key. Use `null` for keyless servers like local Ollama. |

The actual key lives in `backend/.env` (gitignored). Copy `backend/.env.example` and fill in the values:

```env
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

Restart the backend after editing the JSON or `.env`. The boot log won't show endpoint loading specifically, but `GET /api/endpoints` will reflect the new entry.

Built-in endpoints are **read-only via the API** — `PATCH` and `DELETE` return 403 `config_endpoints_are_read_only`. Edit the JSON and restart.

### Adding another built-in

Examples:

```jsonc
// Together AI
{ "id": "together", "displayName": "Together",
  "baseUrl": "https://api.together.xyz/v1",
  "apiKeyEnv": "TOGETHER_API_KEY" }

// Groq
{ "id": "groq", "displayName": "Groq",
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiKeyEnv": "GROQ_API_KEY" }

// Anthropic via the official OpenAI-compat shim (use carefully — partial coverage)
{ "id": "anthropic", "displayName": "Anthropic (shim)",
  "baseUrl": "https://api.anthropic.com/v1",
  "apiKeyEnv": "ANTHROPIC_API_KEY" }

// Local vLLM
{ "id": "vllm-dev", "displayName": "vLLM (dev box)",
  "baseUrl": "http://gpu-1.lan:8000/v1",
  "apiKeyEnv": null }
```

If the env var is unset, the endpoint still loads but `hasKey: false` and `/api/models` will report `error: "missing_api_key"` for it. The endpoint shows in the dropdown but its optgroup is disabled.

## User endpoints (Settings UI)

Cogwheel → "Custom endpoints" → **Add endpoint**. Fill display name, base URL, optional API key. Save → the entry lands in the `endpoints` DB table and appears alongside the built-ins.

Editing semantics:

- The API key is **write-only**. The UI shows `apiKeyMasked` (e.g. `sk-...wxyz`) — to change the key, click "Replace key" and type the new value; to remove it, click "Clear key".
- Display name and base URL are inline-editable.
- DELETE removes the row.

User endpoints can be edited and deleted; built-ins can't. There's no other distinction at runtime.

## How models reach the dropdown

`GET /api/models` does the heavy lifting:

1. Lists every configured endpoint where `hasKey: true` (env var set, or `apiKeyEnv: null`).
2. Calls each endpoint's `GET /v1/models` in parallel, with a 5s per-endpoint timeout.
3. Sends `Authorization: Bearer <key>` if a key exists.
4. Tolerates either `{ data: [{ id, ... }] }` (OpenAI standard) or a bare array (some compat servers).
5. Caches the whole result in memory for 60s. `?refresh=1` busts the cache.
6. Endpoints without keys, with timeouts, or with non-200 responses are still included with `ok: false, error: <reason>, models: []` — the UI shows them as disabled optgroups so users understand why nothing's pickable.

The model picker (`frontend/src/components/ModelPicker.tsx`) consumes this list, groups by endpoint, and round-trips `<endpointId>::<modelId>` strings.

## How models flow through the app

The picker stores `<endpointId>::<modelId>`. Where it goes:

- **Chats**: sent on `POST /api/conversations/:id/messages` as `{ content, model }`. Persisted on `conversations.model` (sticky last-used). Future agent code should split this on `::` to resolve the endpoint.
- **Agent runs**: sent on `POST /api/agents/:id/run` as `{ inputs, model }`. Falls back to `agent.model` (the agent's configured default) if not provided. Persisted on `runs.model`. The engine forwards it on the `run_started` event payload so subprocess agents can read it from the env or args.

Today the run engine doesn't actually call the LLM — that's the agent author's job (the demo agents generate mock data). When wiring an LLM call into an agent, read the model from the run start (or from a templated arg in `exec.args`) and resolve it to a base URL + API key by hitting the backend's endpoint store. A future helper will pre-resolve and pass `OPENSHUKI_BASE_URL` + `OPENSHUKI_API_KEY` env vars in the `exec.env` block — see the discussion in [agent-python.md](agent-python.md) and [agent-typescript.md](agent-typescript.md).

## Smoke testing a new endpoint

```bash
# 1. confirm the endpoint shows up
curl -s http://localhost:4000/api/endpoints | python -m json.tool

# 2. force a fresh model fetch
curl -s "http://localhost:4000/api/models?refresh=1" | python -m json.tool

# 3. check one specific endpoint
curl -s "http://localhost:4000/api/models?refresh=1" \
  | python -c "import sys, json; d=json.load(sys.stdin); \
               g=[x for x in d if x['endpointId']=='openrouter'][0]; \
               print('ok:', g['ok'], 'count:', len(g['models']))"
```

If `ok: false`, the `error` field is the message you need:

| Error | Fix |
|---|---|
| `missing_api_key` | env var unset; add to `backend/.env` and restart |
| `fetch failed` | base URL unreachable, DNS, firewall, or wrong scheme |
| `401 Unauthorized` | key invalid or expired |
| `404 Not Found` | base URL is wrong (most likely missing `/v1`) |

## Security notes

- Keys for **config endpoints** never touch the DB or the API response. They live in env only.
- Keys for **user endpoints** are stored plaintext in SQLite (`endpoints.api_key`). Fine for a local-dev scaffold; do NOT expose this DB to multiple users without encrypting at rest. There's a `// SECURITY:` comment on the schema noting this.
- The API never returns full keys; only `apiKeyMasked` (`<first-4>...<last-4>`).
- The model proxy doesn't expose the key client-side — the frontend only ever sees endpoint metadata, not credentials.
