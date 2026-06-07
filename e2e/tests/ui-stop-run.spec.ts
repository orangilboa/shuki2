// Test plan §1 — #4 Stop a running task (UI surface, §4.1 / §4.2).
import { test, expect, type Page } from "@playwright/test";
import { cancelRunQuietly } from "./helpers";

const ASK_DEMO = "Ask demo";
const RUNNING_NAME = "Ask demo (subprocess)";

// Open the Ask demo agent and start a run, returning the new run id (captured
// from the dispatch response). ask-demo pauses on its first ask_user, so the
// run stays active until we stop it. /api/running is ordered newest-first, so
// the new run is always the first right-panel row even if stale rows exist.
async function startAskDemo(page: Page): Promise<string> {
  await page.goto("/");
  await page.locator('button[title="Agents"]').click();
  await page.locator(".panel.left .list-item", { hasText: ASK_DEMO }).click();
  await expect(page.getByRole("button", { name: "Run agent" })).toBeEnabled();

  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/agents/ask-demo/run") && r.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Run agent" }).click()
  ]);
  const task = (await resp.json()) as { id: string };
  return task.id;
}

test.describe("#4 stop a running task (UI)", () => {
  const started: string[] = [];

  test.afterEach(async ({ request }) => {
    // Ensure the run we started never leaks (e.g. on assertion failure).
    while (started.length) await cancelRunQuietly(request, started.pop()!);
  });

  test("4.1 Stop from the RunView header flips the run to failed", async ({
    page
  }) => {
    started.push(await startAskDemo(page));

    const row = page
      .locator(".panel.right .list-item", { hasText: RUNNING_NAME })
      .first();
    await expect(row).toBeVisible();

    // Open the run in the center panel.
    await row.click();
    // The agent's first question (rendered in the RunView) confirms the
    // subprocess is alive.
    await expect(
      page.locator(".ask-user-prompt", { hasText: "What is your name?" })
    ).toBeVisible();

    const stop = page.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    await stop.click();

    // The run leaves the "stoppable" state: status flips to failed and the
    // header Stop button unmounts.
    await expect(row.locator(".status.failed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  });

  test("4.2 mini Stop in the right panel stops without opening the run", async ({
    page
  }) => {
    started.push(await startAskDemo(page));

    const row = page
      .locator(".panel.right .list-item", { hasText: RUNNING_NAME })
      .first();
    await expect(row).toBeVisible();

    // The mini ■ control is a hover action; reveal it, then click.
    await row.hover();
    await row.locator(".btn-stop-mini").click();

    // stopPropagation: the click must NOT have navigated to the RunView.
    await expect(page.getByRole("heading", { name: /^Run / })).toHaveCount(0);
    // The run flips to failed in place.
    await expect(row.locator(".status.failed")).toBeVisible();
  });
});
