import { test, expect } from "@playwright/test";
import { api } from "./helpers";

test.describe("backend health", () => {
  test("GET /api/health returns ok", async ({ request }) => {
    const res = await request.get(api("/api/health"));
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
  });
});
