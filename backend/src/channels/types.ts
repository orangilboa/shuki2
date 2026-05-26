// Internal types used by the channels module. Wire-facing types live in
// backend/src/types/index.ts.

import type { RunEventEnvelope } from "../runs/events.js";
import type {
  ChannelDirection,
  ChannelFilter,
  ChannelInboundPolicy,
  ChannelMessageKind,
  ChannelSource,
  ChannelSummary
} from "../types/index.js";

export type ResolvedChannel = {
  id: string;
  name: string;
  kind: string;
  direction: ChannelDirection;
  enabled: boolean;
  filter: ChannelFilter;
  inbound: ChannelInboundPolicy;
  adapterConfig: Record<string, unknown>;
  source: ChannelSource;
  createdAt: number;
  updatedAt: number;
};

export type ChannelMessageInbound = {
  // Adapter-provided external id (e.g. chat message id), used for cursoring.
  externalId: string;
  text: string;
  ts: number;
  meta?: Record<string, unknown>;
};

export type ChannelOutbound = {
  kind: ChannelMessageKind;
  text?: string;
  payload: unknown;
  correlationId?: string;
};

// Context handed to adapter factories at start().
export type AdapterContext = {
  channel: ResolvedChannel;
  // Append a row to channel_messages and (where relevant) hand the message
  // off to the adapter. Adapters receive outbound events and command results
  // through `send()`; inbound messages are returned by `pollMessages()` or
  // pushed via `pushInbound()`.
  log: (msg: ChannelOutbound & { direction: "in" | "out" }) => Promise<void>;
};

// All adapters implement at least one direction. Optional methods stay
// unimplemented for the other directions.
export interface ChannelAdapter {
  // Called once when the channel is enabled.
  start(): Promise<void>;
  // Called when the channel is disabled or the process exits.
  stop(): Promise<void>;
  // Outbound — forwards a single ChannelOutbound to the external surface.
  // Adapters that are inbound-only may no-op.
  send?(msg: ChannelOutbound): Promise<void>;
  // For adapters that want explicit pull semantics from the runtime. Optional;
  // when present, the runtime invokes on a tick (interval from adapterConfig).
  pollMessages?(): Promise<ChannelMessageInbound[]>;
}

// Factory: builds an adapter for a specific channel + runtime context.
export type ChannelAdapterFactory = (ctx: AdapterContext) => ChannelAdapter;

export type ChannelKindDescriptor = {
  kind: string;
  defaultDirection: ChannelDirection;
  build: ChannelAdapterFactory;
  // Adapter-side validation hook called when storing/updating a channel.
  // Throw an Error to reject with `{ error: <message> }` 400 at the route.
  validate?: (channel: ResolvedChannel) => void;
};

export type RouteableEvent = RunEventEnvelope;

export type { ChannelSummary };
