// Shared e2e harness.
//
// Boots the real backend in-process on an ephemeral port (via the exported
// `start()` from server.ts), against the configured DB_URL. Tests talk to it
// over HTTP with global fetch — exercising the full stack: routes -> dispatch
// -> run engine -> subprocess runner (real Python agent) -> bus -> Postgres ->
// SSE/interactions. Nothing is mocked.
//
// Requires: Postgres reachable at DB_URL (default
// postgresql://openshuki:openshuki@localhost:5432/openshuki) and, for the
// meeting-planner tests, Python + langgraph on PATH.

import type { Server } from "node:http";
import { start } from "../../src/server.js";

export type TestServer = {
  baseUrl: string;
  server: Server;
};

export async function startTestServer(): Promise<TestServer> {
  // Port 0 → OS picks a free port; we read it back from the bound address.
  const server = (await start(0)) as Server;
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (!port) throw new Error("failed to bind test server port");
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

export async function stopTestServer(ts: TestServer | null): Promise<void> {
  if (!ts) return;
  await new Promise<void>((resolve) => ts.server.close(() => resolve()));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- HTTP helpers --------------------------------------------------

export async function getJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function getStatus(url: string): Promise<number> {
  const res = await fetch(url);
  // Drain the body so the socket is freed.
  await res.text();
  return res.status;
}

export type JsonResult<T> = { status: number; body: T };

export async function sendJson<T = unknown>(
  method: "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown
): Promise<JsonResult<T>> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T };
}

// ---------- run driving ---------------------------------------------------

export type Interaction = {
  id: string;
  prompt: string;
  choices: string[] | null;
  status: string;
};

export type RunRow = { id: string; status: string; error: string | null };

export type ArtifactSummary = {
  id: string;
  name: string;
  kind: string;
  hasInlineContent: boolean;
};

/**
 * Poll a run to completion, answering each `ask_user` interaction as it
 * appears via `answerFor(prompt, choices)`. Returns the terminal run row.
 */
export async function driveRunToCompletion(
  baseUrl: string,
  runId: string,
  answerFor: (prompt: string, choices: string[]) => string,
  opts: { timeoutMs?: number } = {}
): Promise<{ run: RunRow; asked: string[] }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const answered = new Set<string>();
  const asked: string[] = [];

  while (Date.now() < deadline) {
    const run = await getJson<RunRow>(`${baseUrl}/api/runs/${runId}`);
    if (run.status === "succeeded" || run.status === "failed") {
      return { run, asked };
    }
    const pending = await getJson<Interaction[]>(
      `${baseUrl}/api/runs/${runId}/interactions?status=pending`
    );
    for (const it of pending) {
      if (answered.has(it.id)) continue;
      answered.add(it.id);
      asked.push(it.prompt);
      const answer = answerFor(it.prompt, it.choices ?? []);
      // A 409 (already answered/cancelled) is fine — ignore it.
      await sendJson(
        "POST",
        `${baseUrl}/api/runs/${runId}/interactions/${it.id}/respond`,
        { answer }
      );
    }
    await sleep(250);
  }
  throw new Error(`run ${runId} did not complete within ${timeoutMs}ms`);
}

export async function getArtifactContent(
  baseUrl: string,
  artifactId: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/artifacts/${artifactId}/content`);
  if (!res.ok) {
    throw new Error(`GET artifact content -> ${res.status}`);
  }
  return await res.text();
}

// ---------- prereq detection ----------------------------------------------

import { spawnSync } from "node:child_process";

/** True if a Python interpreter with langgraph importable is on PATH. */
export function pythonAgentAvailable(): boolean {
  for (const cmd of ["python", "python3"]) {
    const r = spawnSync(cmd, ["-c", "import langgraph"], {
      stdio: "ignore",
      timeout: 15_000
    });
    if (r.status === 0) return true;
  }
  return false;
}
