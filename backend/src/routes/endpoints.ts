// Express routers for LLM endpoint CRUD and model aggregation.
//
// We expose two routers because they live under different mount points:
//   /api/endpoints -> endpointsRouter (CRUD on config + user endpoints)
//   /api/models    -> modelsRouter    (aggregated /v1/models with caching)

import { Router, type Request, type Response } from "express";
import {
  createUserEndpoint,
  deleteUserEndpoint,
  findById,
  listAll,
  updateUserEndpoint
} from "../endpoints/store.js";
import { getAllModels } from "../endpoints/models.js";

export const endpointsRouter: Router = Router();
export const modelsRouter: Router = Router();

// ---------- helpers -------------------------------------------------------

function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//.test(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------- /api/endpoints ------------------------------------------------

endpointsRouter.get("/", (_req: Request, res: Response) => {
  res.json(listAll());
});

endpointsRouter.post("/", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isNonEmptyString(body.displayName)) {
    res.status(400).json({ error: "invalid_displayName" });
    return;
  }
  if (!isHttpUrl(body.baseUrl)) {
    res.status(400).json({ error: "invalid_baseUrl" });
    return;
  }
  let apiKey: string | null = null;
  if (body.apiKey === null || body.apiKey === undefined) {
    apiKey = null;
  } else if (typeof body.apiKey === "string") {
    apiKey = body.apiKey.length > 0 ? body.apiKey : null;
  } else {
    res.status(400).json({ error: "invalid_apiKey" });
    return;
  }
  const created = createUserEndpoint({
    displayName: body.displayName,
    baseUrl: body.baseUrl,
    apiKey
  });
  res.json(created);
});

endpointsRouter.patch("/:id", (req: Request, res: Response) => {
  const found = findById(req.params.id);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (found.source === "config") {
    res.status(403).json({ error: "config_endpoints_are_read_only" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { displayName?: string; baseUrl?: string; apiKey?: string | null } = {};
  if (body.displayName !== undefined) {
    if (!isNonEmptyString(body.displayName)) {
      res.status(400).json({ error: "invalid_displayName" });
      return;
    }
    patch.displayName = body.displayName;
  }
  if (body.baseUrl !== undefined) {
    if (!isHttpUrl(body.baseUrl)) {
      res.status(400).json({ error: "invalid_baseUrl" });
      return;
    }
    patch.baseUrl = body.baseUrl;
  }
  if (body.apiKey !== undefined) {
    if (body.apiKey === null) {
      patch.apiKey = null;
    } else if (typeof body.apiKey === "string") {
      patch.apiKey = body.apiKey.length > 0 ? body.apiKey : null;
    } else {
      res.status(400).json({ error: "invalid_apiKey" });
      return;
    }
  }
  const updated = updateUserEndpoint(req.params.id, patch);
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(updated);
});

endpointsRouter.delete("/:id", (req: Request, res: Response) => {
  const found = findById(req.params.id);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (found.source === "config") {
    res.status(403).json({ error: "config_endpoints_are_read_only" });
    return;
  }
  deleteUserEndpoint(req.params.id);
  res.status(204).end();
});

// ---------- /api/models ---------------------------------------------------

modelsRouter.get("/", async (req: Request, res: Response) => {
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  try {
    const data = await getAllModels({ refresh });
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});
