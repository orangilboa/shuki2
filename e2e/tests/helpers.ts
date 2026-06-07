import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

// Must match BACKEND_PORT in playwright.config.ts — the e2e backend runs on a
// dedicated port so it never collides with a developer's `pnpm dev`.
export const API_BASE = "http://localhost:4100";

export function api(path: string): string {
  return `${API_BASE}${path}`;
}

export type RunningTask = {
  id: string;
  agentId: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  startedAt: string;
};

/** Dispatch an agent run via the REST surface and return the run id. */
export async function startAgentRun(
  request: APIRequestContext,
  agentId: string,
  inputs: Record<string, unknown> = {}
): Promise<string> {
  const res = await request.post(api(`/api/agents/${agentId}/run`), {
    data: inputs
  });
  expect(res.ok(), `run dispatch failed: ${res.status()}`).toBeTruthy();
  const task = (await res.json()) as RunningTask;
  expect(task.id).toBeTruthy();
  return task.id;
}

/** Poll a run's status until it matches one of the wanted values (or times out). */
export async function waitForRunStatus(
  request: APIRequestContext,
  runId: string,
  wanted: ReadonlyArray<RunningTask["status"]>,
  timeoutMs = 20_000
): Promise<RunningTask> {
  const deadline = Date.now() + timeoutMs;
  let last: RunningTask | null = null;
  while (Date.now() < deadline) {
    const res = await request.get(api(`/api/runs/${runId}`));
    if (res.ok()) {
      last = (await res.json()) as RunningTask;
      if (wanted.includes(last.status)) return last;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `run ${runId} never reached ${wanted.join("|")}; last status = ${last?.status ?? "unknown"}`
  );
}

type Interaction = {
  id: string;
  runId: string;
  status: "pending" | "answered" | "cancelled";
  prompt: string;
};

/** Poll a run for its first pending ask_user interaction. */
export async function waitForPendingInteraction(
  request: APIRequestContext,
  runId: string,
  timeoutMs = 20_000
): Promise<Interaction> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get(
      api(`/api/runs/${runId}/interactions?status=pending`)
    );
    if (res.ok()) {
      const list = (await res.json()) as Interaction[];
      if (list.length > 0) return list[0]!;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`run ${runId} never produced a pending interaction`);
}

/** Best-effort cleanup: cancel a run if it is still active. */
export async function cancelRunQuietly(
  request: APIRequestContext,
  runId: string
): Promise<void> {
  try {
    await request.post(api(`/api/runs/${runId}/cancel`));
  } catch {
    /* ignore */
  }
}

/** Best-effort cleanup: delete a user channel. */
export async function deleteChannelQuietly(
  request: APIRequestContext,
  channelId: string
): Promise<void> {
  try {
    await request.delete(api(`/api/channels/${channelId}`));
  } catch {
    /* ignore */
  }
}
