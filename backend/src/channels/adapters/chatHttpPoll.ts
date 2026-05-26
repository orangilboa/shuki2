// Chat adapter: polls a remote HTTP endpoint for new messages, parses them
// as openshuki commands, dispatches via the command registry, and POSTs the
// formatted reply back. Outbound run events also go through sendMessage()
// after the channel runtime filters them.
//
// adapterConfig shape:
//   {
//     pollUrl: string         // GET {pollUrl}?since=<cursor>
//     sendUrl: string         // POST {sendUrl} with { text }
//     authHeader?: string     // optional bearer/auth header
//     pollIntervalMs?: number // default 2000; honoured by runtime
//   }

import { dispatch } from "../../commands/registry.js";
import { register as registerKind } from "../registry.js";
import { formatCommandResult, summarizeEvent } from "../chat/formatter.js";
import { helpText, parseChatMessage } from "../chat/parser.js";
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelMessageInbound,
  ChannelOutbound
} from "../types.js";

type AdapterConfig = {
  pollUrl: string;
  sendUrl: string;
  authHeader?: string;
  pollIntervalMs?: number;
};

function readConfig(raw: Record<string, unknown>): AdapterConfig {
  const pollUrl = raw.pollUrl;
  const sendUrl = raw.sendUrl;
  if (typeof pollUrl !== "string" || pollUrl.length === 0) {
    throw new Error("chat.http-poll: adapterConfig.pollUrl required");
  }
  if (typeof sendUrl !== "string" || sendUrl.length === 0) {
    throw new Error("chat.http-poll: adapterConfig.sendUrl required");
  }
  return {
    pollUrl,
    sendUrl,
    authHeader: typeof raw.authHeader === "string" ? raw.authHeader : undefined,
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number" ? raw.pollIntervalMs : undefined
  };
}

function buildAdapter(ctx: AdapterContext): ChannelAdapter {
  let cursor: string | null = null;
  let cfg: AdapterConfig;
  try {
    cfg = readConfig(ctx.channel.adapterConfig);
  } catch (err) {
    // Defer the throw until start() so the channel record stays createable.
    return {
      start: async () => {
        throw err;
      },
      stop: async () => {}
    };
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.authHeader) h.Authorization = cfg.authHeader;
    return h;
  }

  async function sendText(text: string, correlationId?: string): Promise<void> {
    await fetch(cfg.sendUrl, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ text })
    });
    await ctx.log({
      direction: "out",
      kind: "chat",
      text,
      payload: { text },
      correlationId
    });
  }

  return {
    start: async () => {
      // No persistent connection — the runtime ticks pollMessages.
    },
    stop: async () => {
      // nothing to clean up
    },
    pollMessages: async (): Promise<ChannelMessageInbound[]> => {
      const url = new URL(cfg.pollUrl);
      if (cursor) url.searchParams.set("since", cursor);
      const res = await fetch(url.toString(), { headers: headers() });
      if (!res.ok) throw new Error(`poll failed: ${res.status} ${res.statusText}`);
      const body = (await res.json()) as {
        messages?: Array<{ id?: string; text?: string; ts?: number }>;
        nextCursor?: string;
      };
      const list = body.messages ?? [];
      if (typeof body.nextCursor === "string") cursor = body.nextCursor;
      else if (list.length > 0) {
        const last = list[list.length - 1]!;
        if (typeof last.id === "string") cursor = last.id;
      }
      const out: ChannelMessageInbound[] = [];
      for (const m of list) {
        if (typeof m.text !== "string") continue;
        const externalId = typeof m.id === "string" ? m.id : crypto.randomUUID();
        out.push({
          externalId,
          text: m.text,
          ts: typeof m.ts === "number" ? m.ts : Date.now()
        });
        // Dispatch inline so the runtime only persists what we tell it to.
        await handleInbound(m.text, externalId);
      }
      return out;
    },
    send: async (msg: ChannelOutbound) => {
      // Run events arriving from the firehose. Summarise; suppress null.
      if (msg.kind === "event") {
        const payload = msg.payload as { event?: import("../../runs/events.js").RunEventEnvelope };
        const ev = payload.event;
        if (!ev) return;
        const summary = summarizeEvent(ev, "compact");
        if (!summary) return;
        await sendText(summary);
        return;
      }
      // Command results and outbound chat — already text.
      if (msg.text) await sendText(msg.text, msg.correlationId);
    }
  };

  async function handleInbound(text: string, externalId: string): Promise<void> {
    const parsed = parseChatMessage(text);
    if (parsed.kind === "noop") return;
    if (parsed.kind === "error") {
      await sendText(`${parsed.message}\n\n${helpText()}`, externalId);
      return;
    }

    const allow = ctx.channel.inbound.allowCommands;
    if (!allow) {
      await sendText(
        `commands are disabled for this channel (enable inbound.allowCommands in settings)`,
        externalId
      );
      return;
    }
    const allowed = ctx.channel.inbound.allowedCommandIds;
    if (allowed.length > 0 && !allowed.includes("*") && !allowed.includes(parsed.commandId)) {
      await sendText(
        `command not permitted on this channel: ${parsed.commandId}`,
        externalId
      );
      return;
    }
    await ctx.log({
      direction: "in",
      kind: "command",
      payload: { commandId: parsed.commandId, input: parsed.input, externalId },
      correlationId: externalId
    });
    const result = await dispatch(parsed.commandId, parsed.input, {
      source: "channel",
      meta: { channelId: ctx.channel.id, externalId }
    });
    if (!result.ok) {
      await sendText(`✗ ${parsed.commandId}: ${result.error}`, externalId);
      return;
    }
    await sendText(
      formatCommandResult(parsed.commandId, result.output),
      externalId
    );
  }
}

registerKind({
  kind: "chat.http-poll",
  defaultDirection: "in_out",
  build: buildAdapter,
  validate: (channel) => {
    // Surface a clear error at create-time instead of waiting for start().
    readConfig(channel.adapterConfig);
  }
});
