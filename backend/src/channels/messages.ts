// Persistence for channel_messages.

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  channelMessages,
  type ChannelMessageRow,
  type NewChannelMessageRow
} from "../db/schema.js";
import type {
  ChannelMessageDirection,
  ChannelMessageKind,
  ChannelMessageSummary
} from "../types/index.js";

function rowToSummary(r: ChannelMessageRow): ChannelMessageSummary {
  let payload: unknown = {};
  try {
    payload = JSON.parse(r.payloadJson);
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    channelId: r.channelId,
    direction: r.direction as ChannelMessageDirection,
    kind: r.kind as ChannelMessageKind,
    payload,
    correlationId: r.correlationId,
    createdAt: new Date(r.createdAt).toISOString()
  };
}

export async function insertChannelMessage(
  input: Omit<NewChannelMessageRow, "id" | "createdAt"> & { id?: string }
): Promise<ChannelMessageSummary> {
  const id = input.id ?? crypto.randomUUID();
  const row: NewChannelMessageRow = {
    id,
    channelId: input.channelId,
    direction: input.direction,
    kind: input.kind,
    payloadJson: input.payloadJson,
    correlationId: input.correlationId ?? null,
    createdAt: Date.now()
  };
  await db.insert(channelMessages).values(row);
  const rows = await db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.id, id));
  const inserted = rows[0];
  if (!inserted) throw new Error("[channels/messages] insert vanished");
  return rowToSummary(inserted);
}

export async function listChannelMessages(
  channelId: string,
  opts?: { limit?: number; direction?: ChannelMessageDirection }
): Promise<ChannelMessageSummary[]> {
  const limit = opts?.limit ?? 100;
  const whereExpr = opts?.direction
    ? and(
        eq(channelMessages.channelId, channelId),
        eq(channelMessages.direction, opts.direction)
      )
    : eq(channelMessages.channelId, channelId);
  const rows = await db
    .select()
    .from(channelMessages)
    .where(whereExpr)
    .orderBy(desc(channelMessages.createdAt))
    .limit(limit);
  return rows.map(rowToSummary).reverse();
}

export async function latestInboundExternalId(channelId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(channelMessages)
    .where(
      and(eq(channelMessages.channelId, channelId), eq(channelMessages.direction, "in"))
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payloadJson) as { externalId?: unknown };
    return typeof payload.externalId === "string" ? payload.externalId : null;
  } catch {
    return null;
  }
}

export { asc };
