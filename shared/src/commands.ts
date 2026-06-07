// Wire-facing command types shared by the backend command registry and the
// frontend. The richer internal `Command` interface (with its handler) stays
// in backend/src/commands/types.ts; only the serialisable summary is shared.

import type { AgentInput } from "./api.js";

export type CommandSummary = {
  id: string;
  title: string;
  description: string;
  inputs: AgentInput[];
};
