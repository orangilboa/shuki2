# Plan: Agent onboarding + Outlook meeting-planner agent

Two coupled deliverables:

- **Part A — Agent onboarding/config (new platform primitive).** Persistent, re-runnable, optional per-agent configuration. An agent *declares* an onboarding spec; the user fills it in a dedicated view; the saved config is injected into every run; and the agent can *learn over time* by emitting a new `config_patch` event that merges back into the stored config (surfacing in the onboarding UI next time).
- **Part B — `meeting-planner` agent.** Consumes the onboarding config. Talks to a **mock Outlook COM** layer shaped like the desktop `Outlook.Application` object model (the eventual real target), scans calendars, classifies conflicts using the user's override rules, asks for clearance on ambiguous cases (and learns from the answers), proposes slots, sends invites, and monitors responses.

---

## Part A — Agent onboarding/config

### A1. Data model — new `agent_config` table
One row per agent holding a free-form JSON config blob (the agent defines its own shape).

- `backend/src/db/schema.ts`: add `agentConfig` pgTable — `agentId text PK references agents.id onDelete cascade`, `configJson text notNull default '{}'`, `createdAt`, `updatedAt` (unix-ms bigint, mirroring existing tables). Export `AgentConfigRow`/`NewAgentConfigRow`.
- `backend/src/db/migrate.ts`: add idempotent `CREATE TABLE IF NOT EXISTS agent_config (...)` matching the Drizzle def.

> Config is *user data keyed by agent*, not a two-source catalog — so no config-file half. The **spec** (what to ask) is declarative and lives on the agent definition (A3); the **answers** live in this table.

### A2. Backend store — `backend/src/agents/config-store.ts`
- `getConfig(agentId): Promise<Record<string, unknown>>` — parse `configJson`, default `{}`.
- `setConfig(agentId, obj): Promise<...>` — upsert (`onConflictDoUpdate` on `agentId`), bump `updatedAt`. Calls `ensureConfigAgentShadow(agentId)` first so the FK resolves for built-in agents (same trick runs already use).
- `mergeConfigPatch(agentId, patch): Promise<...>` — shallow-merge scalars; for array fields, union (dedupe) appended values. This is the "learn over time" primitive used by `config_patch`.
- `resetConfig(agentId)` — delete the row.

### A3. Onboarding spec on the agent definition
Agents optionally declare what to collect. Extend the existing input-spec machinery rather than inventing a parallel one.

- `backend/src/types/index.ts`: add `OnboardingField` = `AgentInput` shape **plus** a `"string_list"` field type and an optional `section?: string` grouping label. Add `onboarding?: OnboardingField[]` to the `Agent` type.
- `backend/src/agents/spec.ts`: add `parseOnboardingJson` / `validateOnboarding` (lenient read-path + throwing write-path, mirroring `parseInputsJson`/`validateAgentInputs`). `string_list` defaults to `[]`.
- `backend/src/agents/config.ts`: parse the optional `onboarding` array from `agents.json` entries.
- `backend/src/agents/store.ts`: thread `onboarding` through `rowToAgent` / config-agent mapping (config agents only for now; user-agent onboarding authoring is out of scope — document it).
- Mirror the type additions in `frontend/src/types/index.ts`.

### A4. Runtime injection — saved config reaches the subprocess
Thread the config into the run as an env var the agent reads (keeps the agent self-contained; no HTTP-back-to-backend).

- `backend/src/runs/runners/subprocess.ts`: add `agentConfigJson?: string` to `RunSubprocessArgs`; inject it into the spawned env as `OPENSHUKI_AGENT_CONFIG` (alongside the existing `...process.env, ...expandedEnv`).
- `backend/src/runs/engine.ts`: in `startRun`, before calling `runSubprocess`, load `getConfig(agentId)` and pass `agentConfigJson: JSON.stringify(config)`.

### A5. Learn-over-time — new `config_patch` run event
Agent → backend event that merges into stored config mid-run.

- `backend/src/runs/events.ts`: add `"config_patch"` to `RunEventType`.
- `frontend/src/types/index.ts`: mirror it.
- `backend/src/runs/runners/subprocess.ts`: add `"config_patch"` to `KNOWN_EVENT_TYPES`; special-case it in the stdout handler — serialize through a small promise queue (like artifacts/interactions) that calls `mergeConfigPatch(args.agentId, payload)`, then `publishEvent("config_patch", ...)` so it's visible in the run log. Payload shape: `{ set?: Record<string,unknown>, append?: Record<string, string[]> }`.
- `agents/agent_util.ts` + `agents/agent_util.py`: add a `configPatch(...)` / `config_patch(...)` helper emitting the JSONL line.
- `docs/protocol.md`: document the event + payload.
- `frontend/src/components/RightPanel.tsx`: add a `config_patch` arm to `eventLine()` (e.g. "learned a rule").

### A6. API — `backend/src/routes/agents.ts`
Add to the existing agents router:
- `GET /api/agents/:id/onboarding` → `{ spec: OnboardingField[], config: Record<string,unknown> }` (spec from the agent def, config from the store). 404 if agent missing.
- `PUT /api/agents/:id/config` → validate body against the spec, `setConfig`, return saved config.
- `DELETE /api/agents/:id/config` → `resetConfig`, 204.

No new router file needed — these hang off the agent resource. (Domain logic stays in `config-store.ts`, per the no-logic-in-routes rule.)

### A7. Frontend wiring
- `frontend/src/api/client.ts`: add `getOnboarding(id)`, `saveAgentConfig(id, config)`, `resetAgentConfig(id)`.
- `frontend/src/types/index.ts`: extend `CenterView` with `{ kind: "onboarding"; agentId: string }`.
- `frontend/src/components/CenterPanel.tsx`: add the switch arm.
- `frontend/src/components/views/OnboardingView.tsx` (new): renders a form from the onboarding spec, grouped by `section`. Field renderers: string/number/boolean reuse AgentView's controls; `string_list` = add/remove chips (tag-style list editor). Loads current config on mount, Save (PUT) + Reset (DELETE). Reuses existing form classes (`.form`, `.field`, `.btn`); `string_list` gets a small amount of CSS in `styles.css` using existing tokens.
- `frontend/src/components/views/AgentView.tsx`: add a **"Configure / Onboarding"** button (shown only when `agent.onboarding?.length`) that does `setCenterView({ kind: "onboarding", agentId })`. Optional, re-runnable — exactly the requirement.
- `frontend/src/store/useStore.ts`: add `loadOnboarding`/`saveAgentConfig`/`resetAgentConfig` actions following the existing async-action + refresh convention.

---

## Part B — `meeting-planner` agent

Language: **Python** (`agents/meeting-planner/`). Rationale: the eventual real target is Outlook desktop COM via `pywin32`, the standard for Windows Outlook automation — so the mock is shaped to be a drop-in swap. LangGraph graph, JSONL protocol, same helpers as the demos.

### B1. Mock Outlook COM layer — `agents/meeting-planner/outlook_com.py`
A self-contained mock mirroring the COM object model so swapping to real `win32com.client.Dispatch("Outlook.Application")` later is mechanical:

- `Application` → `GetNamespace("MAPI")` → `GetDefaultFolder(olFolderCalendar)` → `.Items` of `AppointmentItem`-like objects (`Subject`, `Start`, `End`, `Categories`, `BusyStatus`, `MeetingStatus`, `Recipients`).
- `CreateItem(olAppointmentItem)` → set `.MeetingStatus = olMeeting`, add `.Recipients`, `.Send()`.
- Recipient response polling: `Recipients[i].MeetingResponseStatus` (`olResponseAccepted/Declined/Tentative/None`).
- Mock seeds a deterministic-but-varied calendar (seeded by attendee name, like `traffic`) with a realistic mix incl. low-signal items ("Employee Holiday", "Team Lunch", "Town Hall") that are override candidates, plus hard meetings. Simulated invite responses arrive over a few seconds so `monitor` shows live progress.

### B2. Agent graph — `agents/meeting-planner/main.py`
Inputs (registered in `agents.json`): `people` (comma-separated, required), `urgency` (string; one of `asap|2d|7d|30d`, default `7d`, validated in-agent since input types are only string/number/boolean), `subject` (default "Meeting"), `duration_min` (number, default 30).

Reads `OPENSHUKI_AGENT_CONFIG` env (Part A) → `{ workdayStart, workdayEnd, defaultDurationMin, alwaysOverride: string[], neverOverride: string[] }`.

Nodes:
1. `load_config` — parse env config; compute the urgency time window.
2. `scan` — mock COM: pull the organiser's + each invitee's appointments within the window (`tool_call`/`tool_result` around the COM calls).
3. `classify` — for each conflicting appointment bucket it: **overridable** (subject/category matches `alwaysOverride`), **hard** (matches `neverOverride`, or `BusyStatus=Busy` with no match), **ambiguous** (everything else). Emit a `custom` event with the classification table.
4. `clarify` — for each ambiguous item, `ask_user("Can '<subject>' be overridden?", choices=["Override once","Always override","Never override","Keep busy"])`. On **Always/Never**, emit `config_patch` appending the subject/category to `alwaysOverride`/`neverOverride` — the learning loop.
5. `propose` — with effective free/busy resolved, compute candidate slots inside workday hours honoring urgency + duration; pick top N.
6. `confirm` — `ask_user` to approve a slot (choices = proposed times).
7. `send` — mock COM: create the meeting, add recipients, `Send()`; emit `tool_call`/`tool_result`.
8. `monitor` — poll mock responses for a bounded number of ticks, emitting `node_end` progress per tick; stop when all responded or ticks exhausted. (Real unbounded monitoring → future scheduled-task path; noted, not built.)
9. Emit a markdown **artifact** (`meeting-plan.md`): chosen slot, attendees, per-invitee response status, and which conflicts were overridden. `done(ok=True, summary=...)`.

### B3. Onboarding spec for the agent — in `backend/config/agents.json`
Add the `meeting-planner` entry with `exec` (python subprocess, like `weather`) **and** an `onboarding` array:
- section "Working hours": `workdayStart`, `workdayEnd` (string, e.g. "09:00"), `defaultDurationMin` (number, default 30).
- section "Override rules": `alwaysOverride` (`string_list`), `neverOverride` (`string_list`).

So the first-run experience: open the agent → "Configure" → set hours + seed a couple of override keywords (optional) → run. Over time the `clarify` step grows the lists automatically.

### B4. Deps
`agents/requirements.txt` already has `langgraph`/`langchain-core` — no new deps (mock COM is pure Python). No real `pywin32` until the swap.

---

## Verification
- `pnpm --filter backend exec tsc --noEmit` and `pnpm --filter frontend exec tsc --noEmit` (strict, no `any`).
- Boot backend (runs migrate → creates `agent_config`). Run the agent standalone first: `python -u agents/meeting-planner/main.py --people "Alice,Bob" --urgency 7d` and eyeball the JSONL.
- In the UI: Configure the agent (save config, reload, confirm persisted), run it, answer a clarify prompt with "Always override", re-open Configure → confirm the keyword was learned into `alwaysOverride`. Confirm the artifact renders and invite-response progress advances.

## Touched files (summary)
**Backend:** `db/schema.ts`, `db/migrate.ts`, `agents/config-store.ts` (new), `agents/spec.ts`, `agents/config.ts`, `agents/store.ts`, `types/index.ts`, `runs/events.ts`, `runs/engine.ts`, `runs/runners/subprocess.ts`, `routes/agents.ts`, `config/agents.json`.
**Agents:** `meeting-planner/main.py` (new), `meeting-planner/outlook_com.py` (new), `agent_util.py`, `agent_util.ts`.
**Frontend:** `types/index.ts`, `api/client.ts`, `store/useStore.ts`, `components/CenterPanel.tsx`, `components/RightPanel.tsx`, `components/views/OnboardingView.tsx` (new), `components/views/AgentView.tsx`, `styles.css`.
**Docs:** `docs/protocol.md` (new `config_patch` event).
