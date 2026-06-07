// Test plan §1 — #7 Chat channel adapter (representative end-to-end flow).
//
// Spins up a local HTTP stub that the chat.http-poll adapter polls. The stub
// hands the backend a batch of inbound messages on its first GET, then records
// every reply the adapter POSTs back.
import { test, expect } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { api, deleteChannelQuietly } from "./helpers";

type Stub = {
  url: string;
  replies: string[];
  close: () => Promise<void>;
};

async function startStub(inbox: Array<{ id: string; text: string }>): Promise<Stub> {
  const replies: string[] = [];
  let drained = false;

  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      const messages = drained ? [] : inbox;
      drained = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          messages,
          nextCursor: inbox.length ? inbox[inbox.length - 1]!.id : "0"
        })
      );
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { text?: string };
          if (typeof parsed.text === "string") replies.push(parsed.text);
        } catch {
          /* ignore malformed */
        }
        res.writeHead(200);
        res.end();
      });
      return;
    }
    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    replies,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test.describe("#7 chat channel adapter", () => {
  test("7.1/7.6/7.7 polls, dispatches commands, replies, ignores noise", async ({
    request
  }) => {
    const stub = await startStub([
      { id: "1", text: "/bogus" }, // 7.6 → parser error + help
      { id: "2", text: "just chatting" }, // 7.7 → noop, no reply
      { id: "3", text: "/list-agents" } // 7.1 → agents listing reply
    ]);

    let channelId: string | null = null;
    try {
      const createRes = await request.post(api("/api/channels"), {
        data: {
          name: "e2e chat stub",
          kind: "chat.http-poll",
          direction: "in_out",
          enabled: true,
          filter: { eventCategories: ["run.lifecycle"] },
          inbound: { allowCommands: true, allowedCommandIds: ["*"] },
          adapterConfig: {
            pollUrl: `${stub.url}/poll`,
            sendUrl: `${stub.url}/send`,
            pollIntervalMs: 400
          }
        }
      });
      expect(createRes.ok()).toBeTruthy();
      channelId = ((await createRes.json()) as { id: string }).id;

      // Wait for the adapter to poll, dispatch, and reply.
      await expect
        .poll(() => stub.replies.join("\n"), { timeout: 15_000 })
        .toContain("weather");

      const joined = stub.replies.join("\n");
      // 7.1 — list-agents reply lists agents.
      expect(joined).toContain("Weather forecast");
      // 7.6 — /bogus produced a parser error reply with help text.
      expect(joined).toContain("unknown command: /bogus");
      expect(joined).toContain("Commands:");
      // 7.7 — plain text never triggered a reply.
      expect(joined).not.toContain("just chatting");
    } finally {
      if (channelId) await deleteChannelQuietly(request, channelId);
      await stub.close();
    }
  });
});
