# Frontend — agent guide

Vite + React 18 + TypeScript + Zustand. No router, no UI framework, no CSS framework. Native HTML controls everywhere.

## Layout

```
src/
  main.tsx                       Entry: ReactDOM.createRoot, imports styles.css.
  App.tsx                        Three-panel grid (header / body / footer). Bootstraps store loads.
  styles.css                     All styles. CSS custom properties for theming.
  types/index.ts                 Shared types — mirrors backend/src/types/index.ts plus UI-only shapes.
  api/client.ts                  Typed fetch wrappers. j<T>() throws Error with backend's `error` message on non-2xx.
  store/useStore.ts              Single Zustand slice. Holds all state + async actions.
  components/
    Header.tsx                   Brand + cogwheel button (toggles Settings view).
    Footer.tsx
    LeftPanel.tsx                Collapsible. Hosts ChatList / ScheduledList / AgentsList by tab.
    RightPanel.tsx               Collapsible. Live "running tasks" list driven by SSE firehose.
    CenterPanel.tsx              Dispatches CenterView discriminated union to the right view.
    ModelPicker.tsx              <select> with <optgroup> per LLM endpoint. Reads from store.
    Tabs.tsx                     Reusable pill-tab bar (used in RunView).
    ArtifactsTab.tsx             Gallery + select-to-render flow.
    ArtifactRenderer.tsx         Per-kind rendering: md (marked+dompurify) / text / image / audio / video.
    panels/
      ChatList.tsx               Conversations list.
      ScheduledList.tsx          Scheduled tasks list.
      AgentsList.tsx             Agents list (left panel; the one in the center is AgentView).
    views/
      NewChatView.tsx            Compose-and-send. ModelPicker next to Send.
      ConversationView.tsx       Message thread + composer + ModelPicker (sticky from conv.model).
      AgentView.tsx              Form generated from agent.inputs spec + ModelPicker, then runs the agent.
      ScheduledView.tsx          Scheduled task detail.
      RunView.tsx                Logs|Artifacts tabs over an active or historical run.
      SettingsView.tsx           Endpoints + Models + Agents sections (built-in vs custom split).
```

## State (Zustand)

Single slice in `store/useStore.ts`. Conventions:

- All API-derived data is keyed in objects: `conversationCache`, `events: Record<runId, …>`, `artifactsByRun`, etc. Avoid arrays-of-current-thing where lookups by id matter.
- Async actions live next to the state they mutate. They `await api.<x>()`, then `set(...)`. Errors generally propagate to the caller (`SettingsView` displays them inline).
- Mutating actions (create/update/delete) refresh the relevant list themselves after success — see `createAgent`, `createEndpoint`. Components don't need to follow up with `loadX()`.
- The SSE firehose is opened once via `connectFirehose()` (on right-panel mount). `ingestEvent` updates `running` (progress/status), `events` (per-run buffer), and `artifactsByRun` (synthesised from `artifact` events to avoid an extra GET).

## Center view dispatch

`CenterView` is a discriminated union in `types/index.ts`:

```ts
type CenterView =
  | { kind: "new-chat" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "scheduled"; taskId: string }
  | { kind: "run"; runId: string }
  | { kind: "settings" };
```

Setting `centerView` is the single mechanism to swap the central panel. Left-panel clicks call `setCenterView({...})`; the cogwheel sets `{ kind: "settings" }`. **Do not** introduce React Router or per-view URLs without discussing — the app is single-window today.

To add a new view: extend `CenterView`, add a switch arm in `CenterPanel.tsx`, write the component under `components/views/`. If the view needs data, add a store action and call it on mount.

## API client

`api/client.ts` exports a flat `api` object. Every method calls `j<T>(fetch(...))`:

- 2xx → parsed JSON of type `T`.
- Non-2xx → `Error` whose `.message` is the backend's `{ error }` string when present (otherwise `<status> <statusText>`). Components display `err.message` directly.
- DELETE returns `void` via `jVoid()`.

When adding a new endpoint, **don't fetch from components**. Add a method here.

## Style tokens

All themable values live as CSS custom properties on `:root` in `styles.css`. Use them; don't hardcode hex. Layout dimensions for the shell:

```
--header-h: 100px;
--footer-h: 30px;
```

Don't change these without thinking — the app uses `100vh` minus header/footer everywhere via `grid-template-rows`.

Common class patterns: `.panel`, `.panel-header`, `.panel-body`, `.panel-title`; `.section`, `.section-header`, `.section-title`; `.list`, `.list-item[.clickable][.active]`; `.btn[.primary][.ghost]`, `.link-btn`; `.field`, `.field-label`, `.form`, `.form-actions`; `.muted`, `.error-text`, `.empty`. Composer: `.composer`, `.composer-row`, `.composer-actions`. Run UI: `.tabs-bar`, `.tab-pill`, `.gallery-grid`, `.artifact-card`, `.artifact-renderer`, `.markdown-body`.

## Streaming and live UI

The right panel's "live" indicator and progress bars are updated by `ingestEvent` reading the global `/api/events` SSE firehose. RunView additionally subscribes per-run for replay (so historical events show even if the firehose was down).

When you add a new event type that should appear in the right-panel's last-event line: extend the `eventLine()` switch in `RightPanel.tsx`. For artifact-driven UI: artifact events arrive on the firehose with full metadata in `payload`, and `ingestEvent` synthesises an `ArtifactSummary` and pushes into `artifactsByRun` — no extra fetch needed.

### Agent ↔ user questions

Agents can pause and ask the user a question. The wire events are `ask_user` (from agent) and `user_response` (from backend after the user submits). `ingestEvent` synthesises a pending `AgentInteraction` from each `ask_user` and clears it on `user_response`; `RunView` renders the inline answer form for any pending interaction in the run's event log, and `RightPanel` shows badges for runs with at least one pending question (plus a count badge on the collapse toggle when collapsed). Use `useStore.submitInteractionResponse(runId, interactionId, answer)` to send the user's reply.

## Constraints

- Strict TS, no `any` in props, store, or API surface.
- Two runtime deps beyond React/Zustand: `marked` and `dompurify` (markdown rendering). Don't add more without discussing.
- Don't introduce React Router, MobX, Redux, styled-components, Tailwind, or component libraries.
- All paths in `<a href>` and `<img src>`/`<source src>` for artifacts use the relative `/api/artifacts/:id/content` URL. Vite proxies `/api` to `:4000` in dev; production deploy will need the same proxy or same-origin serving.
