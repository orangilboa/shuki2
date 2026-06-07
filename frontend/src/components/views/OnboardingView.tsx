import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../store/useStore";
import type { OnboardingField } from "../../types";

type FieldValue = string | number | boolean | string[];

function defaultFor(field: OnboardingField): FieldValue {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean":
      return false;
    case "number":
      return "";
    case "string_list":
      return [];
    default:
      return "";
  }
}

// String-list chip editor: a list of removable chips plus an add box.
function StringListEditor({
  values,
  onChange
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="chip-editor">
      <div className="chip-list">
        {values.length === 0 && <span className="muted">none yet</span>}
        {values.map(v => (
          <span key={v} className="chip">
            {v}
            <button
              type="button"
              className="chip-remove"
              aria-label={`remove ${v}`}
              onClick={() => onChange(values.filter(x => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="chip-add">
        <input
          type="text"
          value={draft}
          placeholder="Add and press Enter…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn ghost" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

export default function OnboardingView({ agentId }: { agentId: string }) {
  const agent = useStore(s => s.agents.find(a => a.id === agentId));
  const loadOnboarding = useStore(s => s.loadOnboarding);
  const saveAgentConfig = useStore(s => s.saveAgentConfig);
  const resetAgentConfig = useStore(s => s.resetAgentConfig);
  const setCenterView = useStore(s => s.setCenterView);

  const [spec, setSpec] = useState<OnboardingField[]>([]);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadOnboarding(agentId)
      .then(({ spec: s, config }) => {
        if (cancelled) return;
        setSpec(s);
        const next: Record<string, FieldValue> = {};
        for (const field of s) {
          const stored = config[field.name];
          next[field.name] =
            stored !== undefined ? (stored as FieldValue) : defaultFor(field);
        }
        setValues(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, loadOnboarding]);

  // Group fields by their optional `section` label, preserving order.
  const sections = useMemo(() => {
    const order: string[] = [];
    const bySection = new Map<string, OnboardingField[]>();
    for (const field of spec) {
      const key = field.section ?? "";
      if (!bySection.has(key)) {
        bySection.set(key, []);
        order.push(key);
      }
      bySection.get(key)!.push(field);
    }
    return order.map(key => ({ title: key, fields: bySection.get(key)! }));
  }, [spec]);

  if (!agent) {
    return (
      <div className="view">
        <p className="muted">Agent not found.</p>
      </div>
    );
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      await saveAgentConfig(agentId, values);
      setSavedMsg("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      await resetAgentConfig(agentId);
      const next: Record<string, FieldValue> = {};
      for (const field of spec) next[field.name] = defaultFor(field);
      setValues(next);
      setSavedMsg("Reset to defaults.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view onboarding">
      <div className="view-header">
        <h2>Configure · {agent.name}</h2>
        <p className="muted">
          Optional setup for this agent. Saved settings apply to every run and
          can be changed any time.
        </p>
        <button
          className="btn ghost"
          onClick={() => setCenterView({ kind: "agent", agentId })}
        >
          ← Back to agent
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="form">
          {sections.map(section => (
            <div key={section.title || "_"} className="section">
              {section.title && (
                <div className="section-header">
                  <span className="section-title">{section.title}</span>
                </div>
              )}
              {section.fields.map(field => {
                const label = field.label ?? field.name;
                const value = values[field.name];
                if (field.type === "boolean") {
                  const checked = typeof value === "boolean" ? value : false;
                  return (
                    <div key={field.name} className="field">
                      <label className="field-checkbox">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={e =>
                            setValues({ ...values, [field.name]: e.target.checked })
                          }
                        />
                        <span className="field-label">{label}</span>
                      </label>
                      {field.description && (
                        <span className="muted">{field.description}</span>
                      )}
                    </div>
                  );
                }
                if (field.type === "string_list") {
                  const list = Array.isArray(value) ? value : [];
                  return (
                    <div key={field.name} className="field">
                      <span className="field-label">{label}</span>
                      {field.description && (
                        <span className="muted">{field.description}</span>
                      )}
                      <StringListEditor
                        values={list}
                        onChange={next =>
                          setValues({ ...values, [field.name]: next })
                        }
                      />
                    </div>
                  );
                }
                if (field.type === "number") {
                  const stringValue =
                    typeof value === "number"
                      ? String(value)
                      : typeof value === "string"
                      ? value
                      : "";
                  return (
                    <label key={field.name} className="field">
                      <span className="field-label">{label}</span>
                      <input
                        type="number"
                        step="any"
                        value={stringValue}
                        onChange={e =>
                          setValues({ ...values, [field.name]: e.target.value })
                        }
                      />
                      {field.description && (
                        <span className="muted">{field.description}</span>
                      )}
                    </label>
                  );
                }
                // string
                const stringValue = typeof value === "string" ? value : "";
                return (
                  <label key={field.name} className="field">
                    <span className="field-label">{label}</span>
                    <input
                      type="text"
                      value={stringValue}
                      onChange={e =>
                        setValues({ ...values, [field.name]: e.target.value })
                      }
                    />
                    {field.description && (
                      <span className="muted">{field.description}</span>
                    )}
                  </label>
                );
              })}
            </div>
          ))}

          {error && <p className="error-text">{error}</p>}
          {savedMsg && <p className="muted">{savedMsg}</p>}

          <div className="form-actions">
            <button className="btn primary" onClick={onSave} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn ghost" onClick={onReset} disabled={busy}>
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
