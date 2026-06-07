// Notifications channel adapter (Windows toast). Outbound-only.
//
// Delivery path:
//   - When running inside the Electron host (env OPENSHUKI_NOTIFY_PORT
//     set by desktop/src/main.ts), POST every outbound message to that
//     local HTTP endpoint, which is a tiny listener in the Electron
//     process that shows a native Notification.
//   - In headless mode (no env), this adapter logs to channel_messages
//     and is a no-op visually. No node-notifier fallback in this version.

import { register as registerKind } from "../registry.js";
import { summarizeEvent, type SummaryStyle } from "../chat/formatter.js";
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelOutbound
} from "../types.js";

type AdapterConfig = {
  summaryStyle: SummaryStyle;
  soundEnabled: boolean;
  maxPerMinute: number;
};

function readConfig(raw: Record<string, unknown>): AdapterConfig {
  return {
    summaryStyle:
      raw.summaryStyle === "verbose" ? "verbose" : "compact",
    soundEnabled: raw.soundEnabled !== false,
    maxPerMinute: typeof raw.maxPerMinute === "number" ? raw.maxPerMinute : 10
  };
}

class RateLimiter {
  private windowStart = 0;
  private count = 0;
  constructor(private limitPerMinute: number) {}
  allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.limitPerMinute) return false;
    this.count += 1;
    return true;
  }
}

function buildAdapter(ctx: AdapterContext): ChannelAdapter {
  const cfg = readConfig(ctx.channel.adapterConfig);
  const limiter = new RateLimiter(cfg.maxPerMinute);
  const port = Number(process.env.OPENSHUKI_NOTIFY_PORT ?? 0);
  const electronHost = port > 0;

  return {
    start: async () => {
      if (!electronHost) {
        console.warn(
          `[notifications.windows] channel ${ctx.channel.id}: no Electron host detected (OPENSHUKI_NOTIFY_PORT unset); notifications will only be logged.`
        );
      }
    },
    stop: async () => {},
    send: async (msg: ChannelOutbound) => {
      if (msg.kind !== "event") return;
      const payload = msg.payload as { event?: import("../../runs/events.js").RunEventEnvelope };
      const ev = payload.event;
      if (!ev) return;
      const summary = summarizeEvent(ev, cfg.summaryStyle);
      if (!summary) return;
      if (!limiter.allow()) {
        // Persist the coalesced row so the operator can audit drops.
        await ctx.log({
          direction: "out",
          kind: "notification",
          payload: { coalesced: true, summary, runId: ev.runId, type: ev.type }
        });
        return;
      }
      const title = titleFor(ev);
      // Always persist what we tried to show.
      await ctx.log({
        direction: "out",
        kind: "notification",
        payload: {
          title,
          body: summary,
          runId: ev.runId,
          type: ev.type,
          deliveredVia: electronHost ? "electron" : "log-only",
          soundEnabled: cfg.soundEnabled
        }
      });
      if (!electronHost) return;
      try {
        await fetch(`http://127.0.0.1:${port}/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            body: summary,
            runId: ev.runId,
            soundEnabled: cfg.soundEnabled
          })
        });
      } catch (err) {
        console.error(
          `[notifications.windows] post to electron failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  };
}

function titleFor(ev: import("../../runs/events.js").RunEventEnvelope): string {
  switch (ev.type) {
    case "ask_user":
      return "openshuki — needs input";
    case "done":
      return "openshuki — run finished";
    case "error":
      return "openshuki — run error";
    case "run_started":
      return "openshuki — run started";
    default:
      return "openshuki";
  }
}

registerKind({
  kind: "notifications.windows",
  defaultDirection: "out_only",
  build: buildAdapter,
  validate: (channel) => {
    if (channel.direction !== "out_only") {
      throw new Error("notifications.windows channels must have direction=out_only");
    }
    if (channel.inbound.allowCommands) {
      throw new Error("notifications.windows channels cannot accept commands");
    }
  }
});
