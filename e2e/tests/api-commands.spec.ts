// Test plan §1 — #6 Command catalog + REST surface.
import { test, expect } from "@playwright/test";
import {
  api,
  cancelRunQuietly,
  startAgentRun,
  waitForPendingInteraction,
  waitForRunStatus
} from "./helpers";

const EXPECTED_COMMAND_IDS = [
  "run-agent",
  "cancel-run",
  "list-runs",
  "list-agents",
  "respond-to-interaction"
];

test.describe("#6 command catalog", () => {
  test("6.1 GET /api/commands lists the five built-in commands", async ({
    request
  }) => {
    const res = await request.get(api("/api/commands"));
    expect(res.ok()).toBeTruthy();
    const list = (await res.json()) as Array<{
      id: string;
      title: string;
      description: string;
      inputs: unknown;
    }>;
    const ids = list.map((c) => c.id).sort();
    expect(ids).toEqual([...EXPECTED_COMMAND_IDS].sort());
    for (const cmd of list) {
      expect(cmd.title, `${cmd.id} has title`).toBeTruthy();
      expect(cmd.description, `${cmd.id} has description`).toBeTruthy();
      expect(Array.isArray(cmd.inputs), `${cmd.id} inputs is array`).toBeTruthy();
    }
  });

  test("6.2 GET /api/commands/run-agent returns one command's spec", async ({
    request
  }) => {
    const res = await request.get(api("/api/commands/run-agent"));
    expect(res.ok()).toBeTruthy();
    const cmd = (await res.json()) as { id: string; inputs: unknown };
    expect(cmd.id).toBe("run-agent");
    expect(Array.isArray(cmd.inputs)).toBeTruthy();
  });

  test("6.3 POST /api/commands/run-agent dispatches a run", async ({
    request
  }) => {
    const res = await request.post(api("/api/commands/run-agent"), {
      data: { agentId: "weather", inputs: { location: "NYC", days: 1 } }
    });
    expect(res.ok()).toBeTruthy();
    const out = (await res.json()) as { runId: string; task: { id: string } };
    expect(out.runId).toBeTruthy();
    expect(out.task.id).toBe(out.runId);

    // The new run shows up in GET /api/running.
    const running = await request.get(api("/api/running"));
    const tasks = (await running.json()) as Array<{ id: string }>;
    expect(tasks.some((t) => t.id === out.runId)).toBeTruthy();

    await cancelRunQuietly(request, out.runId);
  });

  test("6.4 POST /api/commands/cancel-run signals an active run", async ({
    request
  }) => {
    // ask-demo blocks on its first ask_user, so it stays active long enough
    // to receive a cancel signal.
    const runId = await startAgentRun(request, "ask-demo");
    await waitForPendingInteraction(request, runId);

    const res = await request.post(api("/api/commands/cancel-run"), {
      data: { runId }
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ ok: true, mode: "signal" });

    const final = await waitForRunStatus(request, runId, ["failed"]);
    expect(final.status).toBe("failed");
  });

  test("6.5 + 6.9 respond-to-interaction delivers, then 409 on re-answer", async ({
    request
  }) => {
    const runId = await startAgentRun(request, "ask-demo");
    const interaction = await waitForPendingInteraction(request, runId);

    const first = await request.post(
      api("/api/commands/respond-to-interaction"),
      { data: { runId, interactionId: interaction.id, answer: "Alice" } }
    );
    expect(first.ok()).toBeTruthy();
    expect(await first.json()).toMatchObject({ delivered: true });

    // 6.9 — answering the same (now non-pending) interaction again is a 409.
    const second = await request.post(
      api("/api/commands/respond-to-interaction"),
      { data: { runId, interactionId: interaction.id, answer: "Alice" } }
    );
    expect(second.status()).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/^not_pending:/);

    await cancelRunQuietly(request, runId);
  });

  test("6.6 run-agent without agentId returns 400", async ({ request }) => {
    const res = await request.post(api("/api/commands/run-agent"), { data: {} });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({ error: "agentId required" });
  });

  test("6.7 unknown command id returns 404", async ({ request }) => {
    const res = await request.post(api("/api/commands/unknown-id"), {
      data: {}
    });
    expect(res.status()).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_command" });
  });

  test("6.8 REST and command dispatch produce equivalent runs", async ({
    request
  }) => {
    const inputs = { location: "Oslo", days: 1 };

    const viaRest = await startAgentRun(request, "weather", inputs);
    const cmdRes = await request.post(api("/api/commands/run-agent"), {
      data: { agentId: "weather", inputs }
    });
    const viaCmd = ((await cmdRes.json()) as { runId: string }).runId;

    const a = await waitForRunStatus(request, viaRest, [
      "succeeded",
      "failed"
    ]);
    const b = await waitForRunStatus(request, viaCmd, ["succeeded", "failed"]);

    expect(a.agentId).toBe(b.agentId);
    expect(a.agentId).toBe("weather");
    // Same agent + same inputs → same terminal status.
    expect(a.status).toBe(b.status);
  });
});
