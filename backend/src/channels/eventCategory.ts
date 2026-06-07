// Maps RunEventType to a single ChannelEventCategory. Users configure
// categories on channels; we expand to types at filter-evaluation time.

import type { RunEventType } from "../runs/events.js";
import type { ChannelEventCategory } from "../types/index.js";

const TABLE: Record<RunEventType, ChannelEventCategory> = {
  run_started: "run.lifecycle",
  done: "run.lifecycle",
  node_start: "run.progress",
  node_end: "run.progress",
  token: "run.logs",
  custom: "run.logs",
  tool_call: "run.tools",
  tool_result: "run.tools",
  artifact: "run.artifacts",
  ask_user: "run.interactions",
  user_response: "run.interactions",
  error: "run.errors",
  waiting_for_llm: "run.llm_wait",
  done_waiting: "run.llm_wait"
};

export function categoryFor(type: RunEventType): ChannelEventCategory {
  return TABLE[type];
}

export function typesInCategories(
  categories: ChannelEventCategory[]
): Set<RunEventType> {
  const wanted = new Set(categories);
  const out = new Set<RunEventType>();
  for (const [type, cat] of Object.entries(TABLE)) {
    if (wanted.has(cat)) out.add(type as RunEventType);
  }
  return out;
}
