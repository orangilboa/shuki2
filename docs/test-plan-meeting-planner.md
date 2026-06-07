# Test plan — Agent onboarding + meeting-planner

Covers the two deliverables on `feature/agent-onboarding-meeting-planner`:

- **Agent onboarding/config** — persistent, optional, re-runnable per-agent configuration; injected into runs; grown over time via `config_patch`.
- **`meeting-planner` agent** — scans Outlook (mock COM), classifies conflicts against the saved override rules, asks for clearance on ambiguous cases, learns from the answers, proposes a slot, sends the invite, monitors responses.

Two parts: a **human (manual) plan** (§1–§3) and an **e2e plan** (§4) describing the automated suite under `backend/test/e2e/`.

---

## 0. Setup

- Postgres reachable at `DB_URL` (default `postgresql://openshuki:openshuki@localhost:5432/openshuki`).
- `pnpm install` at the repo root.
- Python + `langgraph` importable on PATH (the meeting-planner is a Python subprocess agent). Verify: `python -c "import langgraph"`.
- `pnpm dev` (backend :4000, frontend :5173) for the UI tests.

The `meeting-planner` agent and its onboarding spec ship in `backend/config/agents.json`. Its calendar data is a deterministic mock (`agents/meeting-planner/outlook_com.py`) seeded per attendee name, shaped like the real desktop Outlook COM object model.

---

## 1. Human test plan — onboarding (UI + API)

### 1A. Onboarding UI

| # | Test | Expected |
|---|---|---|
| 1.1 | Left panel → Agents → **Meeting planner** | AgentView renders the run form (People, Urgency, Subject, Duration) plus a **"⚙ Configure / Onboarding"** button (shown only because this agent declares an `onboarding` spec). |
| 1.2 | Click **Configure / Onboarding** | OnboardingView opens, grouped into sections "Working hours" (workday start/end, default duration) and "Override rules" (Always overridable / Never override). Lists render as chip editors. |
| 1.3 | In "Always overridable", type `Team Lunch` + Enter, then `Gym` + Enter | Two chips appear. The `×` on a chip removes it. Duplicate adds are ignored. |
| 1.4 | Set workday start `08:30`, default duration `45`, add a couple of override keywords, click **Save** | "Saved." appears. Navigate away and back → values persisted. |
| 1.5 | Reload the page, reopen Configure | Saved values are still there (read from `agent_config`). |
| 1.6 | Click **Reset** | Fields return to spec defaults; "Reset to defaults." appears; the `agent_config` row is deleted. |
| 1.7 | Click **← Back to agent** | Returns to the run form for the same agent. |
| 1.8 | Open an agent with no onboarding spec (e.g. **Weather**) | No Configure button is shown. |

### 1B. Onboarding API (curl)

| # | Test | Expected |
|---|---|---|
| 1.9 | `GET /api/agents/meeting-planner/onboarding` | `{ spec: [...5 fields...], config: {...} }`. `alwaysOverride`/`neverOverride` have `type:"string_list"`; fields carry `section`. |
| 1.10 | `PUT /api/agents/meeting-planner/config` with `{config:{workdayStart:"08:00", defaultDurationMin:45, alwaysOverride:["Team Lunch"]}}` | 200; returns the saved object. `GET` reflects it. |
| 1.11 | `PUT …/config` with `defaultDurationMin:"60"` (string) and an unknown key | 200; `defaultDurationMin` coerced to number `60`; unknown key dropped; list non-strings filtered. |
| 1.12 | `PUT /api/agents/weather/config` | 400 `{error:"agent_has_no_onboarding"}`. |
| 1.13 | `GET /api/agents/does-not-exist/onboarding` | 404 `{error:"not_found"}`. |
| 1.14 | `DELETE /api/agents/meeting-planner/config` | 204; subsequent `GET` shows `config:{}`. |

## 2. Human test plan — meeting-planner run

Run the agent from the UI (People = `Alice,Bob`, Urgency = `7d`, Subject = `Sync`, Duration = `30`).

| # | Test | Expected |
|---|---|---|
| 2.1 | Submit the run | RunView streams `load_config → scan → classify` with progress; the right panel shows live progress. `scan` emits `tool_call/tool_result` for `outlook.GetSharedDefaultFolder`. |
| 2.2 | The `classify` step | A `custom` event with `{kind:"classification", counts:{overridable, hard, ambiguous}}` appears. |
| 2.3 | `clarify` asks about an ambiguous meeting | An inline question appears (e.g. "You have 'Board Meeting' meetings clashing. Can these be overridden?") with quick-select choices: Override once / Always override / Never override / Keep busy. The right panel badges the run as needing input. |
| 2.4 | Answer one prompt **Always override** | The run resumes. A `🧠 learned a rule` line shows on the run's last-event line; a `config_patch` is recorded. Reopen Configure → the subject now appears in "Always overridable". |
| 2.5 | Answer **Never override** on another | Subject persisted into "Never override"; that meeting is treated as a hard conflict. |
| 2.6 | `propose` step | Up to 3 candidate slots inside your configured workday hours, none overlapping a *hard* conflict. A `custom` `{kind:"proposed_slots"}` event lists them. |
| 2.7 | `confirm` asks you to pick a time | Choices are the proposed slots. Pick one. |
| 2.8 | `send` step | `tool_call outlook.AppointmentItem.Send` with the chosen time + recipients; `tool_result` with the recipient count. |
| 2.9 | `monitor` step | Progress advances over a few seconds as responses arrive; a `custom` `{kind:"responses"}` event lists per-attendee status (Accepted/Declined/Tentative). |
| 2.10 | Run completes | Status `succeeded`. Artifacts tab shows **meeting-plan.md**: chosen time, attendees, invite-response table, "Conflicts overridden" and "Hard conflicts respected" tables. |
| 2.11 | Run **again** with the same people | Meetings you marked "Always/Never override" last time are no longer asked about — the agent applied the learned rules (config injection). |
| 2.12 | Set Urgency `asap` and a tight workday window so no slot fits | `propose` reports "no free slot found"; the artifact says no suitable slot was found; run still `succeeded`. |

## 3. Negative / edge cases

| # | Scenario | Expected |
|---|---|---|
| N.1 | Run with empty People | 400 at dispatch / agent emits `error` "at least one person is required"; run `failed`. |
| N.2 | More than 4 distinct ambiguous subjects | The agent asks about the first 4 (logged: "asking about the first 4…"); the rest are treated as hard conflicts for that run (not silently overridden). |
| N.3 | Cancel ([Stop]) the run while a clarify question is pending | Run flips to `failed`; pending interaction → `cancelled`; no `config_patch` persisted for unanswered prompts. |
| N.4 | `neverOverride` contains a normally-free meeting (e.g. "Team Lunch") | That meeting becomes a **hard** conflict even though its BusyStatus is Free — proves saved config overrides the default heuristic. |
| N.5 | Onboarding never configured (fresh `agent_config`) | Agent runs with built-in defaults (`OPENSHUKI_AGENT_CONFIG` = `{}`); everything Busy/unknown is ambiguous and asked. |

---

## 4. E2E plan (automated)

Location: `backend/test/e2e/`. Runner: Node's built-in `node:test` via `tsx` (no new dependency). The harness boots the **real** backend in-process on an ephemeral port (`start(0)` from `server.ts`) against `DB_URL`, and drives it over HTTP with `fetch`. The meeting-planner tests spawn the **real** Python subprocess agent and the mock Outlook COM layer — nothing is stubbed. Each layer is exercised end-to-end: routes → dispatch → run engine → subprocess runner → bus → Postgres → SSE/interactions → config persistence.

### Running

```bash
# Prereqs: Postgres up; python + langgraph on PATH.
pnpm --filter openshuki-backend test:e2e            # both suites
pnpm --filter openshuki-backend test:e2e:onboarding # API-only (fast)
pnpm --filter openshuki-backend test:e2e:planner    # full-stack agent run
pnpm --filter openshuki-backend typecheck:test      # type-check src + tests
```

If `python`/`langgraph` is missing, the meeting-planner suite **skips** (it doesn't fail). Postgres is a hard prerequisite, as for the app itself. The suites reset the `meeting-planner` agent's config in their teardown so they don't leave learned rules on a shared DB.

### Coverage

**`onboarding.e2e.test.ts`** (6 tests, no agent run):

| Test | Asserts |
|---|---|
| GET onboarding returns spec + config | Spec exposes the declared fields; `alwaysOverride` is `string_list`; fields carry `section`; `config` is an object. |
| PUT persists, GET reflects | Saved config round-trips through `agent_config`. |
| PUT coerces + ignores unknowns | String→number coercion; non-string list entries dropped; unknown keys not persisted; missing keys defaulted. |
| DELETE resets | `config` becomes `{}` after reset (204). |
| PUT on agent without spec | 400 `agent_has_no_onboarding` (uses `weather`). |
| Unknown agent | 404 for GET onboarding and PUT config. |

**`meeting-planner.e2e.test.ts`** (2 tests, full stack, real Python subprocess):

| Test | Asserts |
|---|---|
| Saved override rule is injected and reclassifies a conflict | Runs a **baseline** (no config), derives a real overridable subject from its artifact (deterministic mock calendar), then sets `neverOverride:[subject]` and re-runs. The subject flips from the "Conflicts overridden" table to "Hard conflicts respected" — proving the saved config was injected into the run and changed classification. Drives `ask_user` via the interactions API; asserts run `succeeded` and `meeting-plan.md` is produced. |
| "Always override" is learned and persisted via `config_patch` | Runs with empty config, answers every clearance prompt **Always override**, then asserts `GET …/onboarding` shows a non-empty `alwaysOverride` whose entries each correspond to a clearance prompt the agent asked — proving the `config_patch` → `mergeConfigPatch` learning loop persists across the full stack. |

### What's deliberately NOT automated here

- **Frontend UI** (OnboardingView, AgentView button, chip editor) — covered by the manual plan §1A/§2. No browser-driver in the repo.
- **Real Outlook COM** — the agent uses the mock; the real `win32com` swap is out of scope until the desktop target exists.
- **Unbounded response monitoring** — the agent's `monitor` step is bounded (simulated responses over a few seconds); long-horizon monitoring is a future scheduled-task concern.
- **SSE event-shape assertions** — the e2e drives via the interactions/artifacts REST surface rather than parsing the SSE stream; event vocabulary is exercised indirectly (progress, interactions, artifact all flow through the bus).
