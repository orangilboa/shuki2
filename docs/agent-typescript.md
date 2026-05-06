# Building an agent in TypeScript

A walkthrough for adding a new TypeScript agent to openshuki, complete with `@langchain/langgraph` integration. Read [agents/CLAUDE.md](../agents/CLAUDE.md) and [docs/protocol.md](protocol.md) first if you want the abstract picture; this doc is the recipe.

## Where to put the code

```
agents/
  package.json         # shared TS deps (@langchain/langgraph, tsx, typescript)
  tsconfig.json        # shared tsconfig — `tsc --noEmit` checks every agent
  agent_util.ts        # JSONL emit helpers (you'll import from here)
  <your-agent>/
    main.ts            # entrypoint — argv parsing + LangGraph
    (other modules)
```

All TS agents share `agents/package.json`. Don't add per-agent `package.json` unless your agent needs deps the others don't — and then prefer adding to the shared one.

## Skeleton

```ts
/**
 * <agent name> — <one-line description>
 *
 * Run as: npx tsx main.ts --foo … --bar …
 *
 * Arguments come from the openshuki agent form; the runner templates them
 * in from `exec.args` in the agent config (backend/config/agents.json).
 */
import { parseArgs } from "node:util";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import {
  artifact,
  custom,
  done,
  emitError,
  nodeEnd,
  nodeStart,
  token,
  toolCall,
  toolResult,
} from "../agent_util.js";

const State = Annotation.Root({
  query: Annotation<string>,
  raw: Annotation<{ title: string }[]>,
  summary: Annotation<string>,
});

async function fetchNode(state: typeof State.State) {
  nodeStart("fetch", { query: state.query });
  token("calling api…", "fetch");
  toolCall("api.search", { q: state.query }, "fetch");
  // … real work …
  const raw = [{ title: "result 1" }, { title: "result 2" }];
  toolResult("api.search", true, { count: raw.length }, "fetch");
  custom({ kind: "fetch.raw", rows: raw }, "fetch");
  nodeEnd("fetch", { progress: 0.5 });
  return { raw };
}

async function formatNode(state: typeof State.State) {
  nodeStart("format", { rows: state.raw?.length ?? 0 });
  const lines = [`Results for ${state.query}:`];
  for (const r of state.raw ?? []) lines.push(`- ${r.title}`);
  const summary = lines.join("\n");
  for (const l of lines) token(l, "format");

  artifact("results.md", "md", `# Results\n\n${summary}`, { node: "format" });

  nodeEnd("format", { progress: 1 });
  return { summary };
}

function buildGraph() {
  return new StateGraph(State)
    .addNode("fetch", fetchNode)
    .addNode("format", formatNode)
    .addEdge(START, "fetch")
    .addEdge("fetch", "format")
    .addEdge("format", END)
    .compile();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { query: { type: "string" } },
    strict: false,
  });
  const query = typeof values.query === "string" ? values.query : "";
  if (!query) {
    emitError("--query is required");
    done(false);
    process.exit(1);
  }

  try {
    const graph = buildGraph();
    const result = await graph.invoke({ query });
    done(true, { summary: result.summary ?? "" });
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitError(msg);
    done(false, { error: msg });
    process.exit(1);
  }
}

void main();
```

See `agents/traffic/main.ts` for a working example.

## Key API notes

- **`Annotation.Root({...})`** declares the state schema. Each field is `Annotation<T>` (a function call), not just a type. Returns from nodes are merged into state.
- **`StateGraph(<state>).addNode(...).addEdge(...).compile()`** is the JS API mirror of the Python one. Method-chained.
- **Imports are `from "../agent_util.js"`**. Note the `.js` extension — TypeScript NodeNext module resolution requires it on relative imports, even though the source file is `.ts`. `tsx` handles the actual extension swap at runtime.

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
    "command": "npx",
    "args": ["tsx",
             "{AGENTS_DIR}/<your-agent>/main.ts",
             "--query", "{query}"],
    "cwd": "{AGENTS_DIR}",
    "protocol": "jsonl"
  }
}
```

Field-by-field is identical to the Python agent config (see [agent-python.md](agent-python.md#registering-the-agent)). The notable bits for TS:

- **`command: "npx"`** — uses npm's binary resolver. The runner already handles Windows `.cmd` shim resolution, so this works on every platform.
- **`args[0]: "tsx"`** — runs the TS file directly via `tsx`. No precompile step.
- **`cwd: "{AGENTS_DIR}"`** — sets the cwd to the shared `agents/` so `npx` resolves `tsx` from `agents/node_modules/.bin/tsx`. If you use a different cwd you'll need to install `tsx` there too.

If you want to skip `npx` (saves ~1s of startup time), use the resolved bin directly:

```jsonc
"command": "node",
"args": ["{AGENTS_DIR}/node_modules/tsx/dist/cli.mjs",
         "{AGENTS_DIR}/<your-agent>/main.ts",
         "--query", "{query}"],
"cwd": "{AGENTS_DIR}"
```

This bypasses `npx` resolution and the Windows `.cmd` shell shim. Faster, but tied to tsx's internal layout.

## Templating cheatsheet

Same as Python:

- `{AGENTS_DIR}` → absolute path to `agents/`.
- `{<inputName>}` → string-cast value from the form (with input-spec `default` fallback).
- `${VAR_NAME}` (in `exec.env` only) → `process.env[VAR_NAME] ?? ""`.

## Calling an LLM

If your agent needs to call an LLM, use `@langchain/openai` (already implicit via `@langchain/langgraph`'s peer deps; install if not present):

```bash
pnpm --filter agents add @langchain/openai
```

Pass the model from the picker as a CLI arg (`--model "{model}"`) and the API key via `exec.env`:

```jsonc
"exec": {
  "kind": "subprocess",
  "command": "npx",
  "args": ["tsx", "{AGENTS_DIR}/<agent>/main.ts",
           "--query", "{query}", "--model", "{model}"],
  "cwd": "{AGENTS_DIR}",
  "env": {
    "OPENAI_API_KEY":     "${OPENAI_API_KEY}",
    "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}"
  },
  "protocol": "jsonl"
}
```

Then in your agent:

```ts
import { ChatOpenAI } from "@langchain/openai";

const [endpointId, modelId] = (values.model as string).split("::");
const config: Record<string, { baseURL: string; key: string | undefined }> = {
  openai:     { baseURL: "https://api.openai.com/v1",     key: process.env.OPENAI_API_KEY },
  openrouter: { baseURL: "https://openrouter.ai/api/v1",  key: process.env.OPENROUTER_API_KEY },
};
const cfg = config[endpointId];
const llm = new ChatOpenAI({
  model: modelId,
  configuration: { baseURL: cfg.baseURL },
  apiKey: cfg.key,
});
```

A future backend helper will resolve and forward base URL + key automatically. Until then, hard-code the lookup or template per-endpoint envs.

## Streaming progress correctly

- `nodeStart` / `nodeEnd` mark graph node boundaries. `progress` (0–1) on `nodeEnd` advances the right-panel bar.
- `token(text, node?)` is the right thing for incremental output (LLM stream chunks, log lines).
- Don't `console.log` outside `agent_util`. Anything that lands on stdout becomes a `token` event with the literal text — fine for casual logs but bypasses your structure.
- For diagnostics, use `console.error(...)`. The backend captures stderr as `token` events with `node: "_stderr"` — visible in the log but clearly separated.

## Producing artifacts

Inline (md/text):

```ts
artifact("summary.md", "md", "# Done\n…", { node: "format" });
```

File (any kind, required for binary):

```ts
import { writeFileSync } from "node:fs";
import { artifactFile } from "../agent_util.js";

writeFileSync("./chart.png", pngBytes);
artifactFile("chart.png", "image", "./chart.png", { node: "render" });
```

The runner copies the file into `backend/data/artifacts/<runId>/<sanitised-name>` and serves it via `GET /api/artifacts/<id>/content`.

## Dev loop

1. Type-check from the shared tsconfig:

   ```bash
   cd agents && npx tsc --noEmit
   ```

   Strict TS catches typos and bad imports.

2. Run standalone first to validate the JSONL output:

   ```bash
   cd agents
   npx tsx <your-agent>/main.ts --query "hello"
   ```

3. Add the entry in `backend/config/agents.json`. Restart the backend.

4. Pick the agent in the left panel of the UI. Run it. Watch the Logs tab for events and the Artifacts tab for any artifacts you emitted.

5. End-to-end via curl (same as Python):

   ```bash
   curl -X POST http://localhost:4000/api/agents/<your-agent>/run \
     -H 'content-type: application/json' \
     -d '{"inputs":{"query":"hello"}}'

   curl -N "http://localhost:4000/api/runs/<runId>/events"
   ```

## Common pitfalls

- **`.js` vs `.ts` import extensions**: NodeNext + ESM forces relative imports to use the runtime extension (`.js`), not the source extension (`.ts`). The TypeScript compiler resolves the `.js` to a sibling `.ts`. `tsx` handles this at runtime. Without the `.js`, you'll get an import error at run.
- **`@langchain/langgraph` API churn**: this library is pre-1.0 and does break shapes between minor versions. Pin in `agents/package.json` (`^0.2.0` today) and read the changelog before upgrading. The TS API differs from the Python one in subtle ways — `Annotation.Root({})` vs `TypedDict`, method-chained graph builder vs imperative `add_node`, etc.
- **`npx` startup latency**: ~1s per invocation. Acceptable for one-shot agents; switch to the direct `node tsx/dist/cli.mjs` invocation if it bothers you.
- **Type-only imports**: if you `import type {…}` from a runtime module, the import gets stripped at compile, no runtime cost. Use this freely for shared interfaces.
- **`process.exit(0)` after `done()`**: `done()` writes the final event but doesn't exit. Without an explicit `process.exit`, the Node event loop may keep the process alive (open timers, libuv handles). Always `process.exit` once you're done streaming.
- **`tsx` deprecation noise**: tsx prints a deprecation warning to stderr the first time you run it under Node 23+. The backend captures it as a `_stderr` token. Harmless.
