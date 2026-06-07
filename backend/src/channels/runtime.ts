// Channel runtime — owns the per-channel lifecycle (start/stop), the outbound
// firehose subscription with per-channel filtering, and the inbound polling
// loop for adapters that opt into pull semantics.

import { subscribeAll } from "../runs/bus.js";
import type { RunEventEnvelope, RunEventType } from "../runs/events.js";
import { typesInCategories } from "./eventCategory.js";
import { insertChannelMessage } from "./messages.js";
import { getKind } from "./registry.js";
import { listAllResolved } from "./store.js";
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelOutbound,
  ResolvedChannel
} from "./types.js";

type RunningChannel = {
  channel: ResolvedChannel;
  adapter: ChannelAdapter;
  unsubscribeFirehose: () => void;
  pollTimer?: NodeJS.Timeout;
};

const running = new Map<string, RunningChannel>();

// Build a per-channel filter function that decides whether an event should
// be forwarded to the adapter.
function buildFilter(channel: ResolvedChannel): (ev: RunEventEnvelope) => boolean {
  const allowed = typesInCategories(channel.filter.eventCategories);
  const includeSet = channel.filter.includeTypes
    ? new Set(channel.filter.includeTypes)
    : null;
  const excludeSet = channel.filter.excludeTypes
    ? new Set(channel.filter.excludeTypes)
    : null;
  const agentSet =
    channel.filter.agentIds && channel.filter.agentIds.length > 0
      ? new Set(channel.filter.agentIds)
      : null;
  return (ev: RunEventEnvelope) => {
    const t = ev.type as RunEventType;
    if (includeSet?.has(t)) return true;
    if (excludeSet?.has(t)) return false;
    if (!allowed.has(t)) return false;
    if (agentSet) {
      // The firehose envelope only carries `runId`; for now we honour agentIds
      // by matching against `run_started` events that include agentId, and we
      // skip per-event lookup. Agents-filter is best-effort until runs cache
      // their agentId per envelope — small cost, deferred.
      if (ev.type === "run_started") {
        const aid = (ev.payload as { agentId?: string } | null)?.agentId;
        if (typeof aid === "string" && !agentSet.has(aid)) return false;
      }
    }
    return true;
  };
}

function buildContext(channel: ResolvedChannel): AdapterContext {
  return {
    channel,
    log: async (msg) => {
      await insertChannelMessage({
        channelId: channel.id,
        direction: msg.direction,
        kind: msg.kind,
        payloadJson: JSON.stringify(msg.payload),
        correlationId: msg.correlationId ?? null
      });
    }
  };
}

export async function startChannel(channel: ResolvedChannel): Promise<void> {
  if (running.has(channel.id)) return;
  const desc = getKind(channel.kind);
  if (!desc) {
    console.warn(
      `[channels/runtime] no adapter registered for kind=${channel.kind}, channel ${channel.id} not started`
    );
    return;
  }
  const ctx = buildContext(channel);
  const adapter = desc.build(ctx);
  await adapter.start();

  // Outbound: subscribe to the firehose and forward filtered events.
  let unsubscribeFirehose = (): void => {};
  if (channel.direction !== "in_only" && adapter.send) {
    const accept = buildFilter(channel);
    unsubscribeFirehose = subscribeAll((ev) => {
      if (!accept(ev)) return;
      const outbound: ChannelOutbound = {
        kind: "event",
        payload: { event: ev }
      };
      // Persist + push. Both are best-effort; errors are logged.
      void (async () => {
        try {
          await ctx.log({ ...outbound, direction: "out" });
          if (adapter.send) await adapter.send(outbound);
        } catch (err) {
          console.error(
            `[channels/runtime] outbound failed channel=${channel.id} seq=${ev.seq}:`,
            err instanceof Error ? err.message : err
          );
        }
      })();
    });
  }

  // Inbound: pull-mode loop. Push-mode adapters (webhooks) ignore this and
  // call ctx.log + dispatch from their own handlers.
  let pollTimer: NodeJS.Timeout | undefined;
  if (channel.direction !== "out_only" && adapter.pollMessages) {
    const intervalMs = Number(
      (channel.adapterConfig.pollIntervalMs as number | undefined) ?? 2000
    );
    pollTimer = setInterval(async () => {
      try {
        const msgs = await adapter.pollMessages!();
        for (const m of msgs) {
          await ctx.log({
            direction: "in",
            kind: "chat",
            payload: { externalId: m.externalId, text: m.text, ts: m.ts, meta: m.meta ?? null }
          });
          // Inbound dispatch (commands etc.) is handled by the chat adapter
          // in PR #4 — this PR just persists the message.
        }
      } catch (err) {
        console.error(
          `[channels/runtime] poll failed channel=${channel.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }, intervalMs);
  }

  running.set(channel.id, {
    channel,
    adapter,
    unsubscribeFirehose,
    pollTimer
  });
  console.log(`[channels/runtime] started channel ${channel.id} (${channel.kind})`);
}

export async function stopChannel(channelId: string): Promise<void> {
  const r = running.get(channelId);
  if (!r) return;
  r.unsubscribeFirehose();
  if (r.pollTimer) clearInterval(r.pollTimer);
  try {
    await r.adapter.stop();
  } catch (err) {
    console.error(
      `[channels/runtime] stop failed channel=${channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
  running.delete(channelId);
}

export async function restartChannel(channel: ResolvedChannel): Promise<void> {
  await stopChannel(channel.id);
  if (channel.enabled) await startChannel(channel);
}

export async function startEnabled(): Promise<void> {
  const all = await listAllResolved();
  for (const ch of all) {
    if (ch.enabled) {
      try {
        await startChannel(ch);
      } catch (err) {
        console.error(
          `[channels/runtime] failed to start channel ${ch.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
}

export async function stopAll(): Promise<void> {
  const ids = [...running.keys()];
  for (const id of ids) await stopChannel(id);
}

export function isRunning(channelId: string): boolean {
  return running.has(channelId);
}
