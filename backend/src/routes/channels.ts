// REST router for channel CRUD and per-channel control.

import { Router, type Request, type Response } from "express";
import {
  createUserChannel,
  deleteUserChannel,
  findById,
  isConfigChannel,
  listAll,
  setEnabled,
  updateUserChannel,
  type CreateChannelInput,
  type PatchChannelInput
} from "../channels/store.js";
import { restartChannel, stopChannel } from "../channels/runtime.js";
import { listKinds } from "../channels/registry.js";
import { listChannelMessages } from "../channels/messages.js";
import type {
  ChannelDirection,
  ChannelFilter,
  ChannelInboundPolicy
} from "../types/index.js";

export const channelsRouter: Router = Router();

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseFilter(raw: unknown): ChannelFilter | string {
  if (!raw || typeof raw !== "object") return "invalid_filter";
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.eventCategories)) return "invalid_filter_eventCategories";
  if (!obj.eventCategories.every((c) => typeof c === "string")) {
    return "invalid_filter_eventCategories";
  }
  const out: ChannelFilter = {
    eventCategories: obj.eventCategories as ChannelFilter["eventCategories"]
  };
  if (obj.includeTypes !== undefined) {
    if (!Array.isArray(obj.includeTypes)) return "invalid_filter_includeTypes";
    out.includeTypes = obj.includeTypes as string[];
  }
  if (obj.excludeTypes !== undefined) {
    if (!Array.isArray(obj.excludeTypes)) return "invalid_filter_excludeTypes";
    out.excludeTypes = obj.excludeTypes as string[];
  }
  if (obj.agentIds !== undefined) {
    if (!Array.isArray(obj.agentIds)) return "invalid_filter_agentIds";
    out.agentIds = obj.agentIds as string[];
  }
  return out;
}

function parseInbound(raw: unknown): ChannelInboundPolicy | string {
  if (!raw || typeof raw !== "object") return "invalid_inbound";
  const obj = raw as Record<string, unknown>;
  if (typeof obj.allowCommands !== "boolean") return "invalid_inbound_allowCommands";
  if (!Array.isArray(obj.allowedCommandIds)) return "invalid_inbound_allowedCommandIds";
  return {
    allowCommands: obj.allowCommands,
    allowedCommandIds: obj.allowedCommandIds as string[]
  };
}

function parseDirection(raw: unknown): ChannelDirection | null {
  if (raw === "in_out" || raw === "out_only" || raw === "in_only") return raw;
  return null;
}

// GET /api/channels → list all
channelsRouter.get("/", async (_req: Request, res: Response) => {
  res.json(await listAll());
});

// GET /api/channels/kinds → list registered adapter kinds (for the UI's dropdown)
channelsRouter.get("/kinds", (_req: Request, res: Response) => {
  res.json(
    listKinds().map((k) => ({ kind: k.kind, defaultDirection: k.defaultDirection }))
  );
});

// GET /api/channels/:id
channelsRouter.get("/:id", async (req: Request, res: Response) => {
  const found = await findById(req.params.id as string);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const list = await listAll();
  const summary = list.find((c) => c.id === found.id);
  if (!summary) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(summary);
});

// GET /api/channels/:id/messages
channelsRouter.get("/:id/messages", async (req: Request, res: Response) => {
  const found = await findById(req.params.id as string);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const limit = Math.min(
    500,
    Math.max(1, Number(req.query.limit ?? 100))
  );
  res.json(await listChannelMessages(found.id, { limit }));
});

// POST /api/channels
channelsRouter.post("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isStr(body.name)) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }
  if (!isStr(body.kind)) {
    res.status(400).json({ error: "invalid_kind" });
    return;
  }
  const direction = parseDirection(body.direction);
  if (!direction) {
    res.status(400).json({ error: "invalid_direction" });
    return;
  }
  const filter = parseFilter(body.filter);
  if (typeof filter === "string") {
    res.status(400).json({ error: filter });
    return;
  }
  const inbound = parseInbound(body.inbound);
  if (typeof inbound === "string") {
    res.status(400).json({ error: inbound });
    return;
  }
  const input: CreateChannelInput = {
    name: body.name,
    kind: body.kind,
    direction,
    enabled: typeof body.enabled === "boolean" ? body.enabled : false,
    filter,
    inbound,
    adapterConfig:
      body.adapterConfig && typeof body.adapterConfig === "object"
        ? (body.adapterConfig as Record<string, unknown>)
        : {}
  };
  try {
    const created = await createUserChannel(input);
    if (created.enabled) {
      const resolved = await findById(created.id);
      if (resolved) await restartChannel(resolved);
    }
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "create_failed" });
  }
});

// PATCH /api/channels/:id
channelsRouter.patch("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (isConfigChannel(id)) {
    res.status(403).json({ error: "config_channels_are_read_only" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: PatchChannelInput = {};
  if (body.name !== undefined) {
    if (!isStr(body.name)) {
      res.status(400).json({ error: "invalid_name" });
      return;
    }
    patch.name = body.name;
  }
  if (body.kind !== undefined) {
    if (!isStr(body.kind)) {
      res.status(400).json({ error: "invalid_kind" });
      return;
    }
    patch.kind = body.kind;
  }
  if (body.direction !== undefined) {
    const d = parseDirection(body.direction);
    if (!d) {
      res.status(400).json({ error: "invalid_direction" });
      return;
    }
    patch.direction = d;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "invalid_enabled" });
      return;
    }
    patch.enabled = body.enabled;
  }
  if (body.filter !== undefined) {
    const f = parseFilter(body.filter);
    if (typeof f === "string") {
      res.status(400).json({ error: f });
      return;
    }
    patch.filter = f;
  }
  if (body.inbound !== undefined) {
    const i = parseInbound(body.inbound);
    if (typeof i === "string") {
      res.status(400).json({ error: i });
      return;
    }
    patch.inbound = i;
  }
  if (body.adapterConfig !== undefined) {
    if (!body.adapterConfig || typeof body.adapterConfig !== "object") {
      res.status(400).json({ error: "invalid_adapterConfig" });
      return;
    }
    patch.adapterConfig = body.adapterConfig as Record<string, unknown>;
  }
  try {
    const updated = await updateUserChannel(id, patch);
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const resolved = await findById(id);
    if (resolved) await restartChannel(resolved);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "update_failed" });
  }
});

// POST /api/channels/:id/enable
channelsRouter.post("/:id/enable", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const updated = await setEnabled(id, true);
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const resolved = await findById(id);
    if (resolved) await restartChannel(resolved);
    res.json(updated);
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : "enable_failed" });
  }
});

// POST /api/channels/:id/disable
channelsRouter.post("/:id/disable", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const updated = await setEnabled(id, false);
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await stopChannel(id);
    res.json(updated);
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : "disable_failed" });
  }
});

// DELETE /api/channels/:id
channelsRouter.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (isConfigChannel(id)) {
    res.status(403).json({ error: "config_channels_are_read_only" });
    return;
  }
  await stopChannel(id);
  const ok = await deleteUserChannel(id);
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.status(204).end();
});
