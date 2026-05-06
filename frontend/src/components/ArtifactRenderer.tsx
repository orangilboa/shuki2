import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api } from "../api/client";
import type { ArtifactSummary } from "../types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

type Props = { artifact: ArtifactSummary };

export default function ArtifactRenderer({ artifact }: Props) {
  const url = api.artifactContentUrl(artifact.id);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (artifact.kind !== "md" && artifact.kind !== "text") return;

    setLoading(true);
    setError(null);
    setTextContent(null);
    setHtmlContent(null);

    fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.text();
      })
      .then(text => {
        if (cancelled) return;
        if (artifact.kind === "md") {
          const rendered = marked.parse(text, { async: false }) as string;
          const safe = DOMPurify.sanitize(rendered);
          setHtmlContent(safe);
        } else {
          setTextContent(text);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.kind, url]);

  return (
    <div className="artifact-renderer">
      <div className="artifact-renderer-header">
        <strong className="artifact-renderer-name" title={artifact.name}>
          {artifact.name}
        </strong>
        <span className="status">{artifact.kind}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {formatBytes(artifact.bytes)}
        </span>
        <a
          className="link-btn"
          href={url}
          download={artifact.name}
          style={{ marginLeft: "auto", textDecoration: "none" }}
        >
          Download
        </a>
      </div>

      <div className="artifact-renderer-body">
        {loading ? <p className="muted">Loading…</p> : null}
        {error ? <p className="error-text">{error}</p> : null}

        {artifact.kind === "md" && htmlContent !== null ? (
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        ) : null}

        {artifact.kind === "text" && textContent !== null ? (
          <pre className="artifact-text">{textContent}</pre>
        ) : null}

        {artifact.kind === "image" ? (
          <img className="artifact-image" src={url} alt={artifact.name} />
        ) : null}

        {artifact.kind === "audio" ? (
          <audio controls src={url} className="artifact-audio" />
        ) : null}

        {artifact.kind === "video" ? (
          <video controls src={url} className="artifact-video" />
        ) : null}
      </div>
    </div>
  );
}
