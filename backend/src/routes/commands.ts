// REST surface for the command registry.

import { Router, type Request, type Response } from "express";
import { dispatch, get, list } from "../commands/registry.js";

export const commandsRouter: Router = Router();

// GET /api/commands — list all registered commands with their input specs.
commandsRouter.get("/", (_req: Request, res: Response) => {
  res.json(list());
});

// GET /api/commands/:id — one command's spec.
commandsRouter.get("/:id", (req: Request, res: Response) => {
  const cmd = get(req.params.id as string);
  if (!cmd) {
    res.status(404).json({ error: "unknown_command" });
    return;
  }
  res.json({
    id: cmd.id,
    title: cmd.title,
    description: cmd.description,
    inputs: cmd.inputs
  });
});

// POST /api/commands/:id — dispatch.
commandsRouter.post("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await dispatch(id, body, { source: "user" });
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json(result.output);
});
