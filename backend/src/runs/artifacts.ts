// Artifact persistence for runs.
//
// Agents emit `artifact` events on the JSONL stream. The subprocess runner
// validates + persists via `persistArtifact`, which:
//   1. Sanitizes the artifact name for safe filesystem use.
//   2. Resolves a default mime per kind when the agent didn't supply one.
//   3. Either stores text inline (`content_text`) for kinds {md, text}, or
//      copies the source file under `<backend>/data/artifacts/<runId>/`
//      with collision-avoiding suffixes.
//   4. Publishes the `artifact` event on the bus FIRST so the assigned `seq`
//      matches what gets written into the artifacts row — the same monotonic
//      counter the run_events table uses, so artifact and event ordering
//      interleave deterministically.
//
// Failures never crash the run: the runner catches and emits a `token` event
// describing the rejection.

import path from "node:path";
import fsp from "node:fs/promises";
import { db } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import type { ArtifactKind } from "../types/index.js";
import { publish } from "./bus.js";

export const ARTIFACTS_DIR: string = path.resolve(process.cwd(), "data", "artifacts");

const KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  "md",
  "text",
  "image",
  "audio",
  "video"
]);

const DEFAULT_MIME: Record<ArtifactKind, string> = {
  md: "text/markdown",
  text: "text/plain",
  image: "image/png",
  audio: "audio/mpeg",
  video: "video/mp4"
};

const TEXT_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["md", "text"]);
const BINARY_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  "image",
  "audio",
  "video"
]);

export type RawArtifactPayload = {
  name?: unknown;
  kind?: unknown;
  mime?: unknown;
  content?: unknown;
  path?: unknown;
};

export type PersistArtifactArgs = {
  runId: string;
  cwd: string | undefined;
  payload: RawArtifactPayload;
  fallbackSeq: number; // used when generating a default name like "artifact-<seq>"
};

export type PersistedArtifact = {
  id: string;
  runId: string;
  seq: number;
  name: string;
  kind: ArtifactKind;
  mime: string;
  bytes: number;
  hasInlineContent: boolean;
  createdAt: number;
};

/** Strip path separators / shell metacharacters and clamp length. */
export function sanitizeArtifactName(input: string, fallback: string): string {
  // Take only the basename — defeat any "./" or "../" or absolute paths.
  const base = path.basename(input);
  // Allow [A-Za-z0-9._-]; collapse anything else to "_"; trim leading dots.
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200);
  if (cleaned.length === 0) return fallback;
  return cleaned;
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function chooseUniqueDest(dir: string, name: string): Promise<string> {
  const dotIdx = name.lastIndexOf(".");
  const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  const ext = dotIdx > 0 ? name.slice(dotIdx) : "";

  let candidate = name;
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const full = path.join(dir, candidate);
    try {
      await fsp.access(full);
      candidate = `${stem}.${i}${ext}`;
      i += 1;
    } catch {
      return candidate;
    }
  }
}

/**
 * Validate, persist, and publish a single artifact emitted by a subprocess
 * agent. Throws on validation failures — callers should translate the message
 * into a `token` event.
 */
export async function persistArtifact(
  args: PersistArtifactArgs
): Promise<PersistedArtifact> {
  const { runId, cwd, payload, fallbackSeq } = args;

  // ---- kind ----
  if (typeof payload.kind !== "string" || !KINDS.has(payload.kind as ArtifactKind)) {
    throw new Error(
      `invalid kind ${JSON.stringify(payload.kind)}; expected one of md|text|image|audio|video`
    );
  }
  const kind = payload.kind as ArtifactKind;

  // ---- name ----
  const rawName = typeof payload.name === "string" ? payload.name.trim() : "";
  if (rawName.length === 0) {
    throw new Error("name is required and must be a non-empty string");
  }
  const name = sanitizeArtifactName(rawName, `artifact-${fallbackSeq}`);

  // ---- content vs path ----
  const hasContent = typeof payload.content === "string";
  const hasPath = typeof payload.path === "string" && payload.path.length > 0;
  if (hasContent && hasPath) {
    throw new Error("provide either `content` or `path`, not both");
  }
  if (!hasContent && !hasPath) {
    throw new Error("either `content` (string) or `path` (string) must be provided");
  }
  if (BINARY_KINDS.has(kind) && hasContent) {
    throw new Error(`kind=${kind} requires \`path\`; inline content is not supplied`);
  }

  // ---- mime ----
  const mime =
    typeof payload.mime === "string" && payload.mime.trim().length > 0
      ? payload.mime.trim()
      : DEFAULT_MIME[kind];

  // ---- inline path ----
  if (hasContent) {
    const text = payload.content as string;
    const bytes = Buffer.byteLength(text, "utf8");
    const id = crypto.randomUUID();

    // Publish first so the bus assigns `seq`; reuse it for the row.
    const env = publish(runId, {
      type: "artifact",
      node: null,
      payload: {
        artifactId: id,
        name,
        kind,
        mime,
        bytes,
        hasInlineContent: true
      }
    });

    const createdAt = Date.now();
    db.insert(artifacts)
      .values({
        id,
        runId,
        seq: env.seq,
        name,
        kind,
        mime,
        bytes,
        contentText: text,
        contentPath: null,
        createdAt
      })
      .run();

    return {
      id,
      runId,
      seq: env.seq,
      name,
      kind,
      mime,
      bytes,
      hasInlineContent: true,
      createdAt
    };
  }

  // ---- file path ----
  const srcRaw = payload.path as string;
  const src = path.isAbsolute(srcRaw)
    ? srcRaw
    : path.resolve(cwd ?? process.cwd(), srcRaw);

  let stat;
  try {
    stat = await fsp.stat(src);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`source file not accessible (${m})`);
  }
  if (!stat.isFile()) {
    throw new Error("source path is not a regular file");
  }

  const runDir = path.join(ARTIFACTS_DIR, runId);
  await ensureDir(runDir);
  const finalName = await chooseUniqueDest(runDir, name);
  const dest = path.join(runDir, finalName);
  await fsp.copyFile(src, dest);

  const bytes = stat.size;
  const id = crypto.randomUUID();

  const env = publish(runId, {
    type: "artifact",
    node: null,
    payload: {
      artifactId: id,
      name: finalName,
      kind,
      mime,
      bytes,
      hasInlineContent: false
    }
  });

  const createdAt = Date.now();
  db.insert(artifacts)
    .values({
      id,
      runId,
      seq: env.seq,
      name: finalName,
      kind,
      mime,
      bytes,
      contentText: null,
      // Stored relative to ARTIFACTS_DIR for portability.
      contentPath: path.posix.join(runId, finalName),
      createdAt
    })
    .run();

  return {
    id,
    runId,
    seq: env.seq,
    name: finalName,
    kind,
    mime,
    bytes,
    hasInlineContent: false,
    createdAt
  };
}
