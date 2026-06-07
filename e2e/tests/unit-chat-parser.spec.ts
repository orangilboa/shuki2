// Test plan §1 — #7 chat command parsing (§7.6, §7.7, §7.10).
// parseChatMessage is a pure, dependency-free function, so we test it directly.
import { test, expect } from "@playwright/test";
import { parseChatMessage } from "../../backend/src/channels/chat/parser";

test.describe("#7 chat parser", () => {
  test("7.10 typed argument parsing on /run", () => {
    const r = parseChatMessage('/run weather location="Tel Aviv" days=2 cold=true');
    expect(r.kind).toBe("command");
    if (r.kind !== "command") return;
    expect(r.commandId).toBe("run-agent");
    expect(r.input.agentId).toBe("weather");
    expect(r.input.inputs).toMatchObject({
      location: "Tel Aviv",
      days: 2,
      cold: true
    });
  });

  test("7.7 plain text is a no-op", () => {
    expect(parseChatMessage("just chatting").kind).toBe("noop");
    expect(parseChatMessage("").kind).toBe("noop");
  });

  test("7.6 unknown verb is an error", () => {
    const r = parseChatMessage("/bogus");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("unknown command: /bogus");
  });

  test("aliases map to canonical command ids", () => {
    const cancel = parseChatMessage("/cancel abc123");
    expect(cancel).toMatchObject({
      kind: "command",
      commandId: "cancel-run",
      input: { runId: "abc123" }
    });

    const respond = parseChatMessage("/respond run1 int1 hello there");
    expect(respond).toMatchObject({
      kind: "command",
      commandId: "respond-to-interaction",
      input: { runId: "run1", interactionId: "int1", answer: "hello there" }
    });
  });
});
