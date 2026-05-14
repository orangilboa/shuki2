/**
 * Traffic estimate — a 2-node LangGraph demo for openshuki (TypeScript).
 *
 * Pipeline: lookup → summarize. Reads `--origin` and `--destination` from the
 * command line (filled by the openshuki agent form), generates a mock traffic
 * report, and emits events via the JSONL protocol expected by the subprocess
 * runner.
 *
 * Run standalone:
 *   tsx main.ts --origin "Shibuya" --destination "Shinjuku"
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
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
  toolResult
} from "../agent_util.js";

type Segment = { name: string; minutes: number; level: "light" | "moderate" | "heavy" };

const TrafficState = Annotation.Root({
  origin: Annotation<string>,
  destination: Annotation<string>,
  segments: Annotation<Segment[]>,
  summary: Annotation<string>
});

const LEVELS = ["light", "moderate", "heavy"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function lookupNode(state: typeof TrafficState.State) {
  nodeStart("lookup", { origin: state.origin, destination: state.destination });
  token(`looking up traffic ${state.origin} → ${state.destination}…`, "lookup");
  toolCall("maps.route", { origin: state.origin, destination: state.destination }, "lookup");
  await sleep(400);

  const seedStr = `${state.origin}|${state.destination}`;
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const count = 3 + Math.floor(rand() * 3); // 3-5 segments
  const segments: Segment[] = Array.from({ length: count }, (_, i) => ({
    name: `Segment ${i + 1}`,
    minutes: 4 + Math.floor(rand() * 22),
    level: LEVELS[Math.floor(rand() * LEVELS.length)]
  }));

  toolResult("maps.route", true, { segments: segments.length }, "lookup");
  custom({ kind: "traffic.segments", segments }, "lookup");
  nodeEnd("lookup", { progress: 0.5 });

  return { segments };
}

async function summarizeNode(state: typeof TrafficState.State) {
  const segments: Segment[] = state.segments ?? [];
  nodeStart("summarize", { segments: segments.length });

  const lines = [`Traffic ${state.origin} → ${state.destination}:`];
  let total = 0;
  for (const s of segments) {
    lines.push(`  ${s.name}: ${s.minutes} min (${s.level})`);
    total += s.minutes;
  }
  lines.push(`  ETA: ~${total} min`);

  for (const l of lines) token(l, "summarize");

  const summary = lines.join("\n");

  // Emit a markdown artifact with a friendlier table-style report.
  const md = [
    `# Traffic — ${state.origin} → ${state.destination}`,
    "",
    "| Segment | Minutes | Level |",
    "| --- | --- | --- |",
    ...segments.map(s => `| ${s.name} | ${s.minutes} | ${s.level} |`),
    "",
    `**ETA: ~${total} min**`,
    ""
  ].join("\n");
  const slug = `${state.origin}-${state.destination}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  artifact(`traffic-${slug || "summary"}.md`, "md", md, { node: "summarize" });

  nodeEnd("summarize", { progress: 1 });
  return { summary };
}

function buildGraph() {
  return new StateGraph(TrafficState)
    .addNode("lookup", lookupNode)
    .addNode("summarize", summarizeNode)
    .addEdge(START, "lookup")
    .addEdge("lookup", "summarize")
    .addEdge("summarize", END)
    .compile();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      destination: { type: "string" }
    },
    strict: false
  });

  const origin = typeof values.origin === "string" ? values.origin : "";
  const destination = typeof values.destination === "string" ? values.destination : "";

  if (!origin || !destination) {
    emitError("origin and destination are required");
    done(false);
    process.exit(1);
  }

  try {
    const graph = buildGraph();
    const result = await graph.invoke({ origin, destination });
    done(true, { summary: result.summary ?? "" });
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError(message);
    done(false, { error: message });
    process.exit(1);
  }
}

const isCliEntry =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) void main();
