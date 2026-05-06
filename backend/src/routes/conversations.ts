import { Router, type Request, type Response } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import type { ChatMessage, Conversation, ConversationSummary } from "../types/index.js";

export const conversationsRouter: Router = Router();

function rowToSummary(r: typeof conversations.$inferSelect): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    preview: r.preview,
    model: r.model,
    updatedAt: new Date(r.updatedAt).toISOString()
  };
}

function rowToMessage(r: typeof messages.$inferSelect): ChatMessage {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: new Date(r.createdAt).toISOString()
  };
}

conversationsRouter.get("/", async (_req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt));
  res.json(rows.map(rowToSummary));
});

conversationsRouter.get("/:id", async (req: Request, res: Response) => {
  const convRows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, (req.params.id as string)));
  const conv = convRows[0];
  if (!conv) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(asc(messages.createdAt));

  const full: Conversation = {
    ...rowToSummary(conv),
    messages: msgs.map(rowToMessage)
  };
  res.json(full);
});

conversationsRouter.post("/", async (_req: Request, res: Response) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(conversations).values({
    id,
    title: "New chat",
    preview: "",
    createdAt: now,
    updatedAt: now
  });
  const conv: Conversation = {
    id,
    title: "New chat",
    preview: "",
    model: null,
    updatedAt: new Date(now).toISOString(),
    messages: []
  };
  res.json(conv);
});

conversationsRouter.post("/:id/messages", async (req: Request, res: Response) => {
  const convId = (req.params.id as string);
  const existsRows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId));
  if (existsRows.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = (req.body ?? {}) as { content?: unknown; model?: unknown };
  const content = String(body.content ?? "");
  const model =
    typeof body.model === "string" && body.model.length > 0
      ? body.model
      : body.model === null
        ? null
        : undefined;

  const userMsg = {
    id: crypto.randomUUID(),
    conversationId: convId,
    role: "user" as const,
    content,
    createdAt: Date.now()
  };
  await db.insert(messages).values(userMsg);

  const replyContent = "(mock) Got it. I'll get back to you shortly with the full plan.";
  const replyMsg = {
    id: crypto.randomUUID(),
    conversationId: convId,
    role: "assistant" as const,
    content: replyContent,
    createdAt: Date.now() + 1
  };
  await db.insert(messages).values(replyMsg);

  // Update preview + updated_at on the parent conversation. Persist `model`
  // when the client sent one (sticky last-used; null clears).
  await db
    .update(conversations)
    .set({
      preview: replyContent,
      updatedAt: replyMsg.createdAt,
      ...(model !== undefined ? { model } : {})
    })
    .where(eq(conversations.id, convId));

  res.json({
    messages: [
      {
        id: userMsg.id,
        role: userMsg.role,
        content: userMsg.content,
        createdAt: new Date(userMsg.createdAt).toISOString()
      },
      {
        id: replyMsg.id,
        role: replyMsg.role,
        content: replyMsg.content,
        createdAt: new Date(replyMsg.createdAt).toISOString()
      }
    ] satisfies ChatMessage[]
  });
});
