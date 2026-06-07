// Test plan §1 — #5 Channels foundation, plus #9.8/#9.9 notification guards.
import { test, expect } from "@playwright/test";
import { api, deleteChannelQuietly } from "./helpers";

const CONFIG_CHANNEL_ID = "notifications-default";

type ChannelSummary = {
  id: string;
  name: string;
  kind: string;
  direction: string;
  enabled: boolean;
  source: "config" | "user";
};

test.describe("#5 channels foundation", () => {
  test("5.1 GET /api/channels includes the built-in config channel", async ({
    request
  }) => {
    const res = await request.get(api("/api/channels"));
    expect(res.ok()).toBeTruthy();
    const list = (await res.json()) as ChannelSummary[];
    const cfg = list.find((c) => c.id === CONFIG_CHANNEL_ID);
    expect(cfg, "notifications-default present").toBeTruthy();
    expect(cfg!.source).toBe("config");
    // Every entry carries a source tag.
    for (const c of list) {
      expect(["config", "user"]).toContain(c.source);
    }
  });

  test("5.2 POST /api/channels creates a user channel tagged source:user", async ({
    request
  }) => {
    const res = await request.post(api("/api/channels"), {
      data: {
        name: "test chat bridge",
        kind: "chat.http-poll",
        direction: "in_out",
        filter: { eventCategories: ["run.lifecycle"] },
        inbound: { allowCommands: false, allowedCommandIds: [] },
        adapterConfig: {
          pollUrl: "http://127.0.0.1:8787/poll",
          sendUrl: "http://127.0.0.1:8787/send"
        }
      }
    });
    expect(res.ok()).toBeTruthy();
    const created = (await res.json()) as ChannelSummary;
    try {
      expect(created.source).toBe("user");
      expect(created.kind).toBe("chat.http-poll");
      expect(created.id).toBeTruthy();
    } finally {
      await deleteChannelQuietly(request, created.id);
    }
  });

  test("5.3 POST /api/channels with unknown kind is stored", async ({
    request
  }) => {
    const res = await request.post(api("/api/channels"), {
      data: {
        name: "mystery channel",
        kind: "totally.unknown-kind",
        direction: "out_only",
        filter: { eventCategories: ["run.lifecycle"] },
        inbound: { allowCommands: false, allowedCommandIds: [] }
      }
    });
    expect(res.ok()).toBeTruthy();
    const created = (await res.json()) as ChannelSummary;
    try {
      expect(created.kind).toBe("totally.unknown-kind");
      expect(created.source).toBe("user");
    } finally {
      await deleteChannelQuietly(request, created.id);
    }
  });

  test("5.4 PATCH a config channel is 403 read-only", async ({ request }) => {
    const res = await request.patch(api(`/api/channels/${CONFIG_CHANNEL_ID}`), {
      data: { name: "renamed" }
    });
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "config_channels_are_read_only"
    });
  });

  test("5.5 DELETE a config channel is 403 read-only", async ({ request }) => {
    const res = await request.delete(api(`/api/channels/${CONFIG_CHANNEL_ID}`));
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "config_channels_are_read_only"
    });
  });

  test("5.6 enable then disable flips a user channel's enabled flag", async ({
    request
  }) => {
    // An out_only notifications channel needs no network endpoint, so toggling
    // it on/off is side-effect-free in a headless backend.
    const createRes = await request.post(api("/api/channels"), {
      data: {
        name: "toggle target",
        kind: "notifications.windows",
        direction: "out_only",
        filter: { eventCategories: ["run.lifecycle"] },
        inbound: { allowCommands: false, allowedCommandIds: [] }
      }
    });
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as ChannelSummary;
    expect(created.enabled).toBe(false);

    try {
      const enabled = await request.post(
        api(`/api/channels/${created.id}/enable`)
      );
      expect(enabled.ok()).toBeTruthy();
      expect((await enabled.json()).enabled).toBe(true);

      const disabled = await request.post(
        api(`/api/channels/${created.id}/disable`)
      );
      expect(disabled.ok()).toBeTruthy();
      expect((await disabled.json()).enabled).toBe(false);
    } finally {
      await deleteChannelQuietly(request, created.id);
    }
  });
});

test.describe("#9 notifications channel guards", () => {
  test("9.8 notifications.windows must be out_only", async ({ request }) => {
    const res = await request.post(api("/api/channels"), {
      data: {
        name: "bad direction",
        kind: "notifications.windows",
        direction: "in_out",
        filter: { eventCategories: ["run.lifecycle"] },
        inbound: { allowCommands: false, allowedCommandIds: [] }
      }
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "notifications.windows channels must have direction=out_only"
    });
  });

  test("9.9 notifications.windows cannot accept commands", async ({
    request
  }) => {
    const res = await request.post(api("/api/channels"), {
      data: {
        name: "bad inbound",
        kind: "notifications.windows",
        direction: "out_only",
        filter: { eventCategories: ["run.lifecycle"] },
        inbound: { allowCommands: true, allowedCommandIds: ["*"] }
      }
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "notifications.windows channels cannot accept commands"
    });
  });
});
