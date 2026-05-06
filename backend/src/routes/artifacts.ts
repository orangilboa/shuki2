// Artifact metadata + content endpoints.
//
//   GET /api/runs/:runId/artifacts            (mounted from runs router)
//   GET /api/artifacts/:id
//   GET /api/artifacts/:id/content
//
// The list/detail routes return ArtifactSummary[] / ArtifactSummary — the
// shape locked by `src/types/index.ts`. Content is served separately from
// `data/artifacts/<runId>/<file>` (or inline text for {md, text}).
//
// TODO: cascade file cleanup when DELETE /api/runs/:id lands. Today the FK
// `ON DELETE CASCADE` removes the artifacts row, but on-disk files under
// `data/artifacts/<runId>/` are left behind.

import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { artifacts, runs } from "../db/schema.js";
import type { Artifact } from "../db/schema.js";
import type { ArtifactKind, ArtifactSummary } from "../types/index.js";
import { ARTIFACTS_DIR } from "../runs/artifacts.js";

function rowToSummary(r: Artifact): ArtifactSummary {
  return {
    id: r.id,
    runId: r.runId,
    seq: r.seq,
    name: r.name,
    kind: r.kind as ArtifactKind,
    mime: r.mime,
    bytes: r.bytes,
    hasInlineContent: r.contentText !== null,
    createdAt: new Date(r.createdAt).toISOString()
  };
}

export const artifactsRouter: Router = Router();

// GET /api/artifacts/:id
artifactsRouter.get("/:id", (req: Request, res: Response) => {
  const row = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, req.params.id))
    .get();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rowToSummary(row));
});

// GET /api/artifacts/:id/content
artifactsRouter.get("/:id/content", async (req: Request, res: Response) => {
  const row = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, req.params.id))
    .get();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Sanitize filename for Content-Disposition (no quotes, no CRLF).
  const safeFilename = row.name.replace(/["\r\n]/g, "_");

  if (row.contentText !== null) {
    res.setHeader("Content-Type", `${row.mime}; charset=utf-8`);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeFilename}"`
    );
    res.send(row.contentText);
    return;
  }

  if (row.contentPath === null) {
    res.status(500).json({ error: "artifact has neither inline content nor file path" });
    return;
  }

  // Resolve strictly under ARTIFACTS_DIR. Reject any traversal attempt.
  const abs = path.resolve(ARTIFACTS_DIR, row.contentPath);
  const rel = path.relative(ARTIFACTS_DIR, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.status(400).json({ error: "invalid_path" });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    res.status(404).json({ error: "file_missing" });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: "file_missing" });
    return;
  }

  res.setHeader("Content-Type", row.mime);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Content-Disposition", `inline; filename="${safeFilename}"`);

  const stream = fs.createReadStream(abs);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "stream_failed" });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
});

/**
 * Sub-route handler for GET /api/runs/:runId/artifacts.
 * Mounted from the runs router so the runId param is in scope.
 */
export function listArtifactsForRun(req: Request, res: Response): void {
  const runId = req.params.id;
  const exists = db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get();
  if (!exists) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const rows = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.runId, runId))
    .orderBy(asc(artifacts.seq))
    .all();
  res.json(rows.map(rowToSummary));
}
