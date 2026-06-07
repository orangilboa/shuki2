# openshuki — consolidated test plan

Tests are tagged with the PR that introduced or owns the surface under test:

- **#4** Stop a running task ([feature/stop-run](https://github.com/orangilboa/shuki2/pull/4))
- **#5** Channels foundation ([feature/channels-foundation](https://github.com/orangilboa/shuki2/pull/5))
- **#6** Command catalog + REST surface ([feature/command-catalog](https://github.com/orangilboa/shuki2/pull/6))
- **#7** Chat channel adapter ([feature/chat-channel](https://github.com/orangilboa/shuki2/pull/7))
- **#8** Tray mode (Electron) ([feature/tray-mode](https://github.com/orangilboa/shuki2/pull/8))
- **#9** Windows notifications channel ([feature/notifications-channel](https://github.com/orangilboa/shuki2/pull/9))

Manual unless marked `(automatable)`. Run tests with the matching PR's branch checked out, or against `main` once everything is merged.

> **Feature-specific plans:** [test-plan-meeting-planner.md](test-plan-meeting-planner.md) covers agent onboarding + the meeting-planner agent, and includes the first **automated e2e suite** (`backend/test/e2e/`, run via `pnpm --filter openshuki-backend test:e2e`).

---

## 0. Setup (do this once)

- Postgres reachable at `DB_URL` (default `postgresql://openshuki:openshuki@localhost:5432/openshuki`)
- `pnpm install` from repo root
- For #5–#7, #9: `pnpm dev` (backend on :4000, frontend on :5173)
- For #8, #9: `pnpm dev:desktop` (frontend Vite + Electron)
- Have these agents available — they're in `backend/config/agents.json`:
  - `ask-demo` — fastest interactive agent (multiple `ask_user` calls)
  - `quick-note` — single `ask_user` + artifact emit
  - `weather` — long-ish mock subprocess with progress
  - any `mock` exec.kind agent for "long-running" scenarios

For tests that need an HTTP echo target (chat channel #7, headless smoke checks), this Python one-liner suffices:

```bash
python -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    inbox = [{'id':'1','text':'/list-agents'}]
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'messages':H.inbox,'nextCursor':'1'}).encode()); H.inbox=[]
    def do_POST(self):
        n = int(self.headers.get('Content-Length','0')); print('REPLY:', self.rfile.read(n).decode())
        self.send_response(200); self.end_headers()
http.server.HTTPServer(('127.0.0.1',8787), H).serve_forever()"
```

---

## 1. Per-PR functional tests

### **#4** Stop a running task

| # | Test | Expected |
|---|---|---|
| 4.1 | Start `ask-demo` → wait for `ask_user` → click **Stop** in RunView header | Button shows "Stopping…", then the run disappears from RightPanel and RunView shows `failed`. The per-run SSE stream carries a `done` event with `aborted: true`. `runs.status = 'failed'`, `runs.error = 'aborted'` in DB. |
| 4.2 | Start a long mock run → hover a row in RightPanel → click the mini ■ Stop control | Same flip to `failed`; the row's click-to-open behaviour is not triggered (`stopPropagation` works). |
| 4.3 | Click Stop twice within 100ms | Second click is a no-op (button disabled mid-flight). Backend log shows exactly one `cancelRun` invocation. |
| 4.4 | Cancel via REST while the run is active: `curl -X POST /api/runs/<id>/cancel` | Response `{ok:true, mode:"signal"}`. UI flips to `failed`. |
| 4.5 | Cancel via REST after the run already finished | Response `{ok:true, mode:"noop"}`. No status change. |
| 4.6 | Cancel a `queued` run that isn't active in this process (rare — requires restart between insert and cancel) | Response `{ok:true, mode:"direct"}`. `runs.status = 'failed'`. |

### **#5** Channels foundation

| # | Test | Expected |
|---|---|---|
| 5.1 | `curl GET /api/channels` on fresh DB | Returns built-in entries from `backend/config/channels.json` only (with `source:"config"`). |
| 5.2 | `curl POST /api/channels` with `{name, kind:"chat.http-poll", direction:"in_out", filter:{eventCategories:["run.lifecycle"]}, inbound:{allowCommands:false, allowedCommandIds:[]}, adapterConfig:{pollUrl, sendUrl}}` | 200 with the new row tagged `source:"user"`. |
| 5.3 | `POST /api/channels` with an unknown `kind` | 200 (stored). Backend logs warn at startup that no adapter is registered; channel never starts. |
| 5.4 | `PATCH /api/channels/<config-id>` | 403 `config_channels_are_read_only`. |
| 5.5 | `DELETE /api/channels/<config-id>` | 403 `config_channels_are_read_only`. |
| 5.6 | `POST /api/channels/<id>/enable` then `/disable` | Each flips `channels.enabled`. Runtime starts/stops the adapter (visible in backend logs). |
| 5.7 | Run any agent with an enabled channel whose filter is `eventCategories:["run.errors"]` | After the run, `SELECT direction, kind, payload_json FROM channel_messages WHERE channel_id=…` shows only `error` events (none of `node_end`, `token`, etc.). |
| 5.8 | Run an agent with `agentIds:["weather"]` filter, while running `ask-demo` | No outbound rows for the `ask-demo` run; only `weather`-tagged events flow. |
| 5.9 | Settings → Channels UI: create, toggle, delete | All three reflect the REST state after refresh. |
| 5.10 | Kill the backend mid-run with SIGTERM | `stopAll()` runs cleanly (logs `[channels/runtime] started/stopped` lines balanced); no orphaned listeners. |

### **#6** Command catalog + REST surface

| # | Test | Expected |
|---|---|---|
| 6.1 | `curl GET /api/commands` | Returns 5 commands: `run-agent`, `cancel-run`, `list-runs`, `list-agents`, `respond-to-interaction`, each with `{id, title, description, inputs}`. |
| 6.2 | `curl GET /api/commands/run-agent` | Returns the single command's spec. |
| 6.3 | `curl -X POST /api/commands/run-agent -d '{"agentId":"weather","inputs":{"location":"NYC","days":1}}'` | 200, returns `{runId, task}`. Run appears in `GET /api/running`. |
| 6.4 | `POST /api/commands/cancel-run -d '{"runId":"<active>"}'` | 200 `{ok:true, mode:"signal"}`. Run flips to `failed`. |
| 6.5 | `POST /api/commands/respond-to-interaction -d '{runId, interactionId, answer:"yes"}'` while an `ask_user` is pending | 200 `{delivered:true}`. A `user_response` event appears on the per-run SSE stream. |
| 6.6 | `POST /api/commands/run-agent -d '{}'` (missing agentId) | 400 `{error:"agentId required"}`. |
| 6.7 | `POST /api/commands/unknown-id -d '{}'` | 404 `{error:"unknown_command"}`. |
| 6.8 | Run an agent via `POST /api/agents/:id/run` AND via `POST /api/commands/run-agent` with identical inputs | Both produce equivalent `runs` rows and identical event sequences (same agent + inputs → same execution). Confirms `dispatchAgentRun` parity. |
| 6.9 | `POST /api/commands/respond-to-interaction` for a non-pending interaction | 409 `{error:"not_pending:answered"}` or `:cancelled`. |

### **#7** Chat channel adapter

Prereqs: stub HTTP server from §0 running at `127.0.0.1:8787`.

| # | Test | Expected |
|---|---|---|
| 7.1 | Create channel `chat.http-poll`, `pollUrl=http://127.0.0.1:8787/poll`, `sendUrl=http://127.0.0.1:8787/send`, `inbound.allowCommands:true, allowedCommandIds:["*"]`, enable | Backend logs `[channels/runtime] started`. Within `pollIntervalMs` (default 2s) a POST hits stub with reply text (agents listing for the stub's `/list-agents` seed). |
| 7.2 | Stub returns `/run weather location=NYC days=2` on next poll | A run is dispatched; reply `▶ started run <id>` POSTed back. On `done`, summary reply POSTed. |
| 7.3 | Stub returns `/cancel <runId>` for an active run | Run aborts; reply `⏹ cancel sent (signal)` POSTed. |
| 7.4 | Stub returns `/respond <runId> <interactionId> hello` for a pending `ask_user` | Interaction resolved; reply `✓ answered (delivered)` POSTed. |
| 7.5 | Stub returns `/list-runs status=running limit=5` | Reply contains up to 5 lines, each `· <shortId> <status> <pct>% — <name>`. |
| 7.6 | Stub returns `/bogus` | Reply contains parser error + help text. |
| 7.7 | Stub returns plain text (no slash) | No-op. No dispatch, no reply. |
| 7.8 | Set `inbound.allowCommands:false` then return `/list-agents` | Reply: `commands are disabled for this channel…`. Outbound events still flow. |
| 7.9 | Set `inbound.allowedCommandIds:["list-agents"]` then return `/run weather` | Reply: `command not permitted on this channel: run-agent`. |
| 7.10 | Argument parsing: `/run weather location="Tel Aviv" days=2 cold=true` | `location="Tel Aviv"`, `days=2` (number), `cold=true` (boolean) — all visible in the dispatched `inputs`. |
| 7.11 | Disable the channel mid-poll | Poll loop stops within one interval. Subsequent stub polls receive no traffic. |
| 7.12 | Run any agent → outbound `run.lifecycle` events filtered through chat → reply formatter | Stub receives `▶ run … started` and `✓ run … done` (style=compact, no `token` spam). |

### **#8** Tray mode (Electron)

| # | Test | Expected |
|---|---|---|
| 8.1 | `pnpm dev:desktop` | Vite starts on :5173, Electron window opens with the three-panel UI. |
| 8.2 | Close the window via title-bar X | Window hides. Tray icon visible in system tray. `tasklist` / `Get-Process` shows backend (`pnpm dev` child) still running. `curl localhost:4000/api/health` still returns `{ok:true}`. |
| 8.3 | Double-click tray icon | Window restores and focuses. |
| 8.4 | Tray menu → **Show window** / **Hide window** | Toggles visibility. Menu label updates. |
| 8.5 | Tray menu → **Open in browser** | System browser opens the current URL (Vite dev URL). |
| 8.6 | Tray menu → **Quit** | Window closes, tray icon disappears, backend subprocess exits within ~1s (no orphan). |
| 8.7 | Launch a second `pnpm dev:desktop` while the first is running | Second instance exits immediately (single-instance lock). First window raises and focuses. |
| 8.8 | Kill backend port 4000 occupant before launch; start without backend reachable | Modal dialog: "openshuki backend failed to start"; app exits cleanly. |
| 8.9 | Close window, run an agent via REST against :4000 | Run executes normally despite no visible UI (backend keeps running in tray mode). |

### **#9** Windows notifications channel

Prereqs: `pnpm dev:desktop` (tray mode active). In Settings → Channels, enable `notifications-default`.

| # | Test | Expected |
|---|---|---|
| 9.1 | Run `quick-note` (or any agent that calls `ask_user`) | Native Windows toast appears titled "openshuki — needs input" with the prompt as body. AppUserModelID `com.openshuki.tray` is set so attribution reads "openshuki" (not "Electron"). |
| 9.2 | Click the toast | If hidden, window restores and focuses. Center view switches to the relevant `RunView` (verified via the `openshuki:open-run` custom event handler in `App.tsx`). |
| 9.3 | Run a mock agent to completion | Toast on `done` titled "openshuki — run finished". |
| 9.4 | Force a run failure (e.g. subprocess exits non-zero) | Toast on `error` titled "openshuki — run error" with the error message. |
| 9.5 | With `adapterConfig.maxPerMinute:1`, dispatch 5 runs in rapid succession | Exactly one toast shown. `channel_messages` has the first delivered notification plus 4+ rows with `payload->>coalesced = 'true'`. |
| 9.6 | Set `adapterConfig.soundEnabled:false`, trigger a notification | Toast silent. |
| 9.7 | Kill the Electron host, leave backend running (e.g. PATCH the channel enabled while headless) | Adapter logs warning: `no Electron host detected (OPENSHUKI_NOTIFY_PORT unset); notifications will only be logged`. `channel_messages` still gets rows with `deliveredVia:"log-only"`. No crash. |
| 9.8 | Try `POST /api/channels` for kind `notifications.windows` with `direction:"in_out"` | 400 `{error:"notifications.windows channels must have direction=out_only"}`. |
| 9.9 | Try `POST /api/channels` for kind `notifications.windows` with `inbound.allowCommands:true` | 400 `{error:"notifications.windows channels cannot accept commands"}`. |
| 9.10 | Filter set to only `run.errors` | Only error-type runs trigger toasts; `done` does not. |

---

## 2. Cross-cutting integration tests

These exercise the seam between multiple PRs. Run after the full stack is on `main`.

| # | Test | PRs touched | Expected |
|---|---|---|---|
| X.1 | Start a run from the chat channel (`/run …`), then hit Stop in the UI | #4, #6, #7 | Stop button works against the run that was started via chat. Chat receives no additional `aborted` text on its own (chat only replies to its dispatched commands), but the firehose-filtered events still appear if the channel includes them. |
| X.2 | Start a run from the chat channel, then `/cancel <runId>` from the same chat | #6, #7 | Same final state as X.1, but the cancel was driven by the chat. Both `▶ started run` and `⏹ cancel sent` replies appear on the stub. |
| X.3 | Tray mode + notifications + chat: enable both `notifications-default` and the chat channel. From chat: `/run quick-note`. | #5, #6, #7, #8, #9 | (a) Stub gets `▶ started run`. (b) Toast fires on `ask_user`. (c) Click toast → window focuses → RunView for the right run. (d) Answer the question. (e) Toast fires on `done`. (f) Stub gets `✓ run … done`. |
| X.4 | Tray mode + Stop button via toast click | #4, #8, #9 | Run via REST. Toast on `ask_user`. Click toast → focus RunView → click Stop. Outcome matches 4.1. |
| X.5 | REST vs chat parity | #6, #7 | `POST /api/commands/run-agent {agentId, inputs}` and `/run <agentId> key=value …` from chat produce identical `runs` rows (same `agent_id`, same `inputs_json`, same final `status`). |
| X.6 | Two enabled channels share the firehose | #5, #7, #9 | One chat channel + the notifications channel both enabled. A single run produces both: chat replies AND a Windows toast. No event is dropped or duplicated within either channel. |
| X.7 | Backend restart with persisted channels | #5 | Stop backend; restart. `startEnabled()` re-starts each previously enabled channel. Run an agent → outbound rows still appear. |
| X.8 | Headless backend (no Electron) with notifications channel enabled | #5, #9 | `channel_messages` still accumulates `deliveredVia:"log-only"` rows; nothing crashes; no orphaned sockets. |

---

## 3. Negative / edge cases worth running

| # | Scenario | PRs | Expected |
|---|---|---|---|
| N.1 | Channel adapter throws inside `pollMessages` | #5 | Runtime logs `[channels/runtime] poll failed` but the loop continues on the next tick. Channel stays enabled. |
| N.2 | Channel adapter `send()` throws on a firehose event | #5 | Single-event error logged; subsequent events still delivered. |
| N.3 | Notifications: backend POST to `:OPENSHUKI_NOTIFY_PORT` after Electron quit | #9 | Adapter catches the connection-refused, logs, no crash. |
| N.4 | Chat: stub returns malformed JSON or 500 | #7 | Runtime catches; no row in `channel_messages` for that poll; next poll proceeds. |
| N.5 | Stop a run while a subprocess artifact is mid-write | #4 | SIGTERM → SIGKILL after 1s grace; `done` event has `aborted:true`; any partially-written artifact is either persisted complete or absent (no half-row). |
| N.6 | Channel filter has `excludeTypes:["token"]` only (no `eventCategories`) | #5 | Empty `eventCategories` → no events allowed at all (the filter table is restrictive by category). `excludeTypes` only narrows what `eventCategories` already lets in. |
| N.7 | Tray app on display 1, then disconnect monitor → reconnect | #8 | Window remains restorable from tray; doesn't get stuck off-screen. |
| N.8 | Same-channel-id collision: a user PATCHes a row, then someone adds the same id to `config/channels.json` and restarts | #5 | Config wins on conflict — `findById` returns the config entry, `listAll` filters out the duplicate user row. |

---

## 4. What's deliberately NOT covered

- Unit tests / automated suite. The repo has no test runner today; everything above is manual or a one-line `curl`.
- Performance / load. Firehose under thousands of events/sec, rate-limiter under burst → not tested.
- Packaged Electron build (`pnpm build:desktop` then run the nsis installer). Plan #8 explicitly flagged the `extraResources` layout as placeholder.
- Cross-platform: notifications channel (#9) is Windows-only by design. macOS and Linux tray icons should work via the same Electron `Tray` API but aren't exercised here.
- LLM-routed chat parsing (PR #7 left it as a `useLlmRouter` flag with no implementation).
