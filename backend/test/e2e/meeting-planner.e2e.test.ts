// E2E: the meeting-planner agent through the full stack.
//
// Boots the real backend, dispatches the agent over HTTP, answers its
// `ask_user` prompts via the interactions API, and asserts on the produced
// artifact and persisted config. This spawns the real Python subprocess agent
// and the mock Outlook COM layer — nothing is stubbed.
//
// Covers two behaviours that span every layer:
//   1. saved onboarding config is INJECTED into the run and changes how the
//      agent classifies conflicts;
//   2. a clearance answered "Always override" is LEARNED via a `config_patch`
//      event and persisted into the agent's config.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  stopTestServer,
  getJson,
  sendJson,
  driveRunToCompletion,
  getArtifactContent,
  pythonAgentAvailable,
  type TestServer,
  type ArtifactSummary
} from "./harness.js";

const AGENT = "meeting-planner";
const HAVE_PY = pythonAgentAvailable();
const skip = HAVE_PY ? false : "python + langgraph not available on PATH";

let ts: TestServer;

before(async () => {
  ts = await startTestServer();
});

after(async () => {
  if (ts) {
    await sendJson("DELETE", `${ts.baseUrl}/api/agents/${AGENT}/config`);
    await stopTestServer(ts);
  }
});

// ---------- helpers -------------------------------------------------------

async function runPlanner(
  inputs: Record<string, unknown>,
  answerFor: (prompt: string, choices: string[]) => string
) {
  const dispatch = await sendJson<{ id: string }>(
    "POST",
    `${ts.baseUrl}/api/agents/${AGENT}/run`,
    { inputs, model: null }
  );
  assert.equal(dispatch.status, 200, "run dispatched");
  const runId = dispatch.body.id;

  const { run, asked } = await driveRunToCompletion(ts.baseUrl, runId, answerFor, {
    timeoutMs: 90_000
  });
  assert.equal(run.status, "succeeded", `run ${runId} succeeded (err=${run.error})`);

  const artifacts = await getJson<ArtifactSummary[]>(
    `${ts.baseUrl}/api/runs/${runId}/artifacts`
  );
  const plan = artifacts.find((a) => a.name === "meeting-plan.md");
  assert.ok(plan, "meeting-plan.md artifact produced");
  const md = await getArtifactContent(ts.baseUrl, plan.id);
  return { runId, asked, md, artifacts };
}

// Extract the meeting subjects listed under a given "## <header>" section's
// table (column 2 of `| Person | Meeting | When |`).
function subjectsUnder(md: string, header: string): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${header}`);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells: ["", person, subject, when, ""]
    if (cells.length >= 4 && cells[2] && cells[2] !== "Meeting" && cells[2] !== "---") {
      out.push(cells[2]);
    }
  }
  return out;
}

const clarifyKeepBusy = (prompt: string, choices: string[]) =>
  prompt.includes("Pick a time") ? choices[0] : "Keep busy";
const clarifyAlways = (prompt: string, choices: string[]) =>
  prompt.includes("Pick a time") ? choices[0] : "Always override";

// ---------- tests ---------------------------------------------------------

test(
  "saved override rule is injected and reclassifies a conflict",
  { skip },
  async () => {
    // Baseline run with no config: overridden conflicts are exactly the
    // auto-overridable (Free) meetings, since we answer every ambiguous one
    // "Keep busy" (-> hard). The calendar is deterministic per attendee, so we
    // derive a concrete subject that is genuinely present in this window.
    await sendJson("DELETE", `${ts.baseUrl}/api/agents/${AGENT}/config`);
    const baseline = await runPlanner(
      { people: "Alice,Bob", urgency: "30d", subject: "E2E Baseline", duration_min: 30 },
      clarifyKeepBusy
    );
    const baseOverridden = subjectsUnder(baseline.md, "Conflicts overridden");
    if (baseOverridden.length === 0) {
      // No free meetings landed in the window for this clock — can't form a
      // deterministic assertion. Surface it rather than assert vacuously.
      console.warn("[e2e] no auto-overridable meeting in window; skipping injection assertion");
      return;
    }
    const subject = baseOverridden[0];
    assert.ok(
      !subjectsUnder(baseline.md, "Hard conflicts respected").includes(subject),
      `baseline: '${subject}' is overridable, not hard`
    );

    // Now forbid that subject via config and re-run. It must flip to a hard
    // conflict purely because the saved config was injected into the run.
    const put = await sendJson(
      "PUT",
      `${ts.baseUrl}/api/agents/${AGENT}/config`,
      { neverOverride: [subject] }
    );
    assert.equal(put.status, 200);

    const ruled = await runPlanner(
      { people: "Alice,Bob", urgency: "30d", subject: "E2E Ruled", duration_min: 30 },
      clarifyKeepBusy
    );
    const ruledHard = subjectsUnder(ruled.md, "Hard conflicts respected");
    const ruledOverridden = subjectsUnder(ruled.md, "Conflicts overridden");
    assert.ok(
      ruledHard.includes(subject),
      `'${subject}' became a hard conflict under neverOverride`
    );
    assert.ok(
      !ruledOverridden.includes(subject),
      `'${subject}' is no longer overridden under neverOverride`
    );
  }
);

test(
  "answering 'Always override' is learned and persisted via config_patch",
  { skip },
  async () => {
    await sendJson("DELETE", `${ts.baseUrl}/api/agents/${AGENT}/config`);

    const { asked } = await runPlanner(
      { people: "Alice,Bob", urgency: "7d", subject: "E2E Learn", duration_min: 30 },
      clarifyAlways
    );

    const clarifyPrompts = asked.filter((p) => !p.includes("Pick a time"));
    assert.ok(
      clarifyPrompts.length > 0,
      "the agent asked at least one clearance question"
    );

    // The "Always override" answers must have been persisted into the agent's
    // config via config_patch -> mergeConfigPatch.
    const ob = await getJson<{ config: { alwaysOverride?: string[] } }>(
      `${ts.baseUrl}/api/agents/${AGENT}/onboarding`
    );
    const learned = ob.config.alwaysOverride ?? [];
    assert.ok(
      Array.isArray(learned) && learned.length > 0,
      `learned rules persisted (got ${JSON.stringify(learned)})`
    );
    // Each learned subject should match one of the clearance prompts.
    for (const subj of learned) {
      assert.ok(
        clarifyPrompts.some((p) => p.includes(subj)),
        `learned subject '${subj}' came from a clearance prompt`
      );
    }
  }
);
