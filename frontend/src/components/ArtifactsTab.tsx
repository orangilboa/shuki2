import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { api } from "../api/client";
import type { ArtifactKind, ArtifactSummary } from "../types";
import ArtifactRenderer from "./ArtifactRenderer";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function KindIcon({ kind }: { kind: ArtifactKind }) {
  // 24x24 inline SVGs, currentColor strokes.
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
  switch (kind) {
    case "md":
    case "text":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M7 3h7l4 4v14H7z" />
          <path d="M14 3v4h4" />
          <path d="M9 13h6M9 16h6M9 10h3" />
        </svg>
      );
    case "image":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="M21 17l-5-5-9 9" />
        </svg>
      );
    case "audio":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M9 18V6l10-2v12" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="16" cy="16" r="2.5" />
        </svg>
      );
    case "video":
      return (
        <svg {...common} aria-hidden="true">
          <polygon points="6 4 20 12 6 20 6 4" />
        </svg>
      );
  }
}

type Props = { runId: string };

export default function ArtifactsTab({ runId }: Props) {
  const artifacts = useStore(s => s.artifactsByRun[runId]);
  const loading = useStore(s => s.artifactsLoading[runId] ?? false);
  const loadArtifacts = useStore(s => s.loadArtifacts);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);

  useEffect(() => {
    setSelectedId(null);
    setHasFetched(false);
  }, [runId]);

  useEffect(() => {
    if (hasFetched) return;
    setHasFetched(true);
    void loadArtifacts(runId);
  }, [runId, hasFetched, loadArtifacts]);

  const list: ArtifactSummary[] = artifacts ?? [];
  const selected = selectedId
    ? list.find(a => a.id === selectedId) ?? null
    : null;

  if (selected) {
    return (
      <div className="artifacts-tab">
        <div className="artifacts-tab-toolbar">
          <button
            type="button"
            className="link-btn"
            onClick={() => setSelectedId(null)}
          >
            ← Back to gallery
          </button>
        </div>
        <ArtifactRenderer artifact={selected} />
      </div>
    );
  }

  const showFirstLoadSpinner = loading && !artifacts;

  return (
    <div className="artifacts-tab">
      <div className="artifacts-tab-toolbar">
        <button
          type="button"
          className="btn ghost"
          onClick={() => void loadArtifacts(runId)}
          disabled={loading}
        >
          Refresh
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {list.length} artifact{list.length === 1 ? "" : "s"}
        </span>
      </div>

      {showFirstLoadSpinner ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">No artifacts emitted yet.</p>
      ) : (
        <div className="gallery-grid">
          {list.map(a => (
            <button
              key={a.id}
              type="button"
              className="artifact-card"
              onClick={() => setSelectedId(a.id)}
            >
              {a.kind === "image" ? (
                <img
                  className="artifact-card-thumb"
                  src={api.artifactContentUrl(a.id)}
                  alt={a.name}
                />
              ) : (
                <div className="artifact-card-icon">
                  <KindIcon kind={a.kind} />
                </div>
              )}
              <div className="artifact-card-name" title={a.name}>
                {a.name}
              </div>
              <div className="artifact-card-meta">
                <span className="status">{a.kind}</span>
                <span className="muted">{formatBytes(a.bytes)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
