// E2E: agent onboarding / per-agent config HTTP surface.
//
// Exercises GET /api/agents/:id/onboarding, PUT /:id/config, DELETE /:id/config
// against a real backend + Postgres. No agent run involved — fast.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  stopTestServer,
  getJson,
  getStatus,
  sendJson,
  type TestServer
} from "./harness.js";

const AGENT = "meeting-planner"; // a config agent that declares an onboarding spec
const NO_ONBOARDING_AGENT = "weather"; // declares none

type Onboarding = {
  spec: Array<{ name: string; type: string; section?: string }>;
  config: Record<string, unknown>;
};

let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  // Leave no learned/test config behind on the shared DB.
  await sendJson("DELETE", `${ts.baseUrl}/api/agents/${AGENT}/config`);
  await stopTestServer(ts);
});

test("GET onboarding returns the declared spec and a config object", async () => {
  await sendJson("DELETE", `${ts.baseUrl}/api/agents/${AGENT}/config`);
  const ob = await getJson<Onboarding>(`${ts.baseUrl}/api/agents/${AGENT}/onboarding`);

  const names = ob.spec.map((f) => f.name);
  assert.ok(names.includes("alwaysOverride"), "spec exposes alwaysOverride");
  assert.ok(names.includes("neverOverride"), "spec exposes neverOverride");
  assert.ok(names.includes("workdayStart"), "spec exposes workdayStart");

  const listField = ob.spec.find((f) => f.name === "alwaysOverride");
  assert.equal(listField?.type, "string_list", "alwaysOverride is a string_list");
  assert.ok(
    ob.spec.some((f) => f.section === "Working hours"),
    "fields carry section labels"
  );
  assert.equal(typeof ob.config, "object");
});

test("PUT config persists and GET reflects it", async () => {
  const desired = {
    workdayStart: "08:30",
    workdayEnd: "16:00",
    defaultDurationMin: 45,
    alwaysOverride: ["Team Lunch", "Gym"],
    neverOverride: ["Customer Demo"]
  };
  const put = await sendJson<Record<string, unknown>>(
    "PUT",
    `${ts.baseUrl}/api/agents/${AGENT}/config`,
    desired
  );
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.alwaysOverride, ["Team Lunch", "Gym"]);

  const ob = await getJson<Onboarding>(`${ts.baseUrl}/api/agents/${AGENT}/onboarding`);
  assert.equal(ob.config.workdayStart, "08:30");
  assert.equal(ob.config.defaultDurationMin, 45);
  assert.deepEqual(ob.config.neverOverride, ["Customer Demo"]);
});

test("PUT coerces values to the spec types and ignores unknown keys", async () => {
  const put = await sendJson<Record<string, unknown>>(
    "PUT",
    `${ts.baseUrl}/api/agents/${AGENT}/config`,
    {
      defaultDurationMin: "60", // string -> number
      alwaysOverride: ["A", 5, "B"], // non-strings filtered out
      bogusKey: "should be dropped"
    }
  );
  assert.equal(put.status, 200);
  assert.equal(put.body.defaultDurationMin, 60, "number coerced from string");
  assert.deepEqual(
    put.body.alwaysOverride,
    ["A", "B"],
    "non-string list entries dropped"
  );
  assert.ok(!("bogusKey" in put.body), "unknown keys are not persisted");
  // Missing spec keys fall back to a type-appropriate default.
  assert.equal(typeof put.body.workdayStart, "string");
});

test("DELETE resets config to empty", async () => {
  await sendJson("PUT", `${ts.baseUrl}/api/agents/${AGENT}/config`, {
    alwaysOverride: ["X"]
  });
  const del = await sendJson("DELETE", `${ts.baseUrl}/api/agents/${AGENT}/config`);
  assert.equal(del.status, 204);
  const ob = await getJson<Onboarding>(`${ts.baseUrl}/api/agents/${AGENT}/onboarding`);
  assert.deepEqual(ob.config, {}, "config cleared after reset");
});

test("PUT config on an agent without an onboarding spec is rejected", async () => {
  const put = await sendJson<{ error: string }>(
    "PUT",
    `${ts.baseUrl}/api/agents/${NO_ONBOARDING_AGENT}/config`,
    { foo: "bar" }
  );
  assert.equal(put.status, 400);
  assert.equal(put.body.error, "agent_has_no_onboarding");
});

test("unknown agent returns 404 for onboarding endpoints", async () => {
  assert.equal(
    await getStatus(`${ts.baseUrl}/api/agents/does-not-exist/onboarding`),
    404
  );
  const put = await sendJson(
    "PUT",
    `${ts.baseUrl}/api/agents/does-not-exist/config`,
    {}
  );
  assert.equal(put.status, 404);
});
