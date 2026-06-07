// Test plan §1 — #4 Stop a running task (REST surface, §4.4 / §4.5).
import { test, expect } from "@playwright/test";
import {
  api,
  startAgentRun,
  waitForPendingInteraction,
  waitForRunStatus
} from "./helpers";

test.describe("#4 stop a running task (REST)", () => {
  test("4.4 cancel an active run via REST → mode:signal, run fails", async ({
    request
  }) => {
    const runId = await startAgentRun(request, "ask-demo");
    await waitForPendingInteraction(request, runId);

    const res = await request.post(api(`/api/runs/${runId}/cancel`));
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ ok: true, mode: "signal" });

    const final = await waitForRunStatus(request, runId, ["failed"]);
    expect(final.status).toBe("failed");
    expect(final.error).toBe("aborted");
  });

  test("4.5 cancel an already-finished run via REST → mode:noop", async ({
    request
  }) => {
    const runId = await startAgentRun(request, "weather", {
      location: "Reykjavik",
      days: 1
    });
    const final = await waitForRunStatus(request, runId, [
      "succeeded",
      "failed"
    ]);
    expect(final.status).toBe("succeeded");

    const res = await request.post(api(`/api/runs/${runId}/cancel`));
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ ok: true, mode: "noop" });
  });
});
