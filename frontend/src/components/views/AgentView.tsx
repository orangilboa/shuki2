import { useMemo, useState } from "react";
import { useStore } from "../../store/useStore";
import type { AgentInput } from "../../types";
import ModelPicker from "../ModelPicker";

type FieldValue = string | number | boolean;

function initialValueFor(input: AgentInput): FieldValue {
  if (input.default !== undefined) return input.default;
  if (input.type === "boolean") return false;
  if (input.type === "number") return "";
  return "";
}

function isFilled(input: AgentInput, value: FieldValue): boolean {
  if (input.type === "boolean") return typeof value === "boolean" && value === true;
  if (input.type === "number") {
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return value.trim().length > 0 && Number.isFinite(Number(value));
    return false;
  }
  return typeof value === "string" && value.length > 0;
}

function castForSubmit(input: AgentInput, value: FieldValue): unknown {
  if (input.type === "boolean") return Boolean(value);
  if (input.type === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    return undefined;
  }
  return typeof value === "string" ? value : String(value);
}

export default function AgentView({ agentId }: { agentId: string }) {
  const agent = useStore(s => s.agents.find(a => a.id === agentId));
  const runAgent = useStore(s => s.runAgent);
  const loadRunning = useStore(s => s.loadRunning);
  const setCenterView = useStore(s => s.setCenterView);
  const hasOnboarding = !!agent?.onboarding && agent.onboarding.length > 0;

  const initialValues = useMemo<Record<string, FieldValue>>(() => {
    const out: Record<string, FieldValue> = {};
    if (!agent) return out;
    for (const inp of agent.inputs) out[inp.name] = initialValueFor(inp);
    return out;
  }, [agent]);

  const [values, setValues] = useState<Record<string, FieldValue>>(initialValues);
  const [model, setModel] = useState<string | null>(agent?.model ?? null);
  const [busy, setBusy] = useState(false);

  if (!agent) return <div className="view"><p className="muted">Agent not found.</p></div>;

  const allRequiredFilled = agent.inputs.every(inp => {
    if (!inp.required) return true;
    const v = values[inp.name];
    return v !== undefined && isFilled(inp, v);
  });

  async function onRun() {
    if (!agent) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const inp of agent.inputs) {
        const raw = values[inp.name];
        const cast = castForSubmit(inp, raw);
        if (cast !== undefined) payload[inp.name] = cast;
      }
      const task = await runAgent(agent.id, payload, model);
      await loadRunning();
      setCenterView({ kind: "run", runId: task.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view agent">
      <div className="view-header">
        <h2>
          {agent.name}{" "}
          {agent.source === "config" && <span className="status">built-in</span>}
        </h2>
        <p className="muted">{agent.description}</p>
        {hasOnboarding && (
          <button
            className="btn ghost"
            onClick={() => setCenterView({ kind: "onboarding", agentId })}
          >
            ⚙ Configure / Onboarding
          </button>
        )}
      </div>
      <div className="form">
        <label className="field">
          <span className="field-label">model</span>
          <ModelPicker value={model} onChange={setModel} placeholder="Default…" />
        </label>
        {agent.inputs.map(inp => {
          const label = inp.label ?? inp.name;
          const value = values[inp.name];
          if (inp.type === "boolean") {
            const checked = typeof value === "boolean" ? value : false;
            return (
              <div key={inp.name} className="field">
                <label className="field-checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={e =>
                      setValues({ ...values, [inp.name]: e.target.checked })
                    }
                  />
                  <span className="field-label">
                    {label}
                    {inp.required && <span className="required-mark"> *</span>}
                  </span>
                </label>
                {inp.description && <span className="muted">{inp.description}</span>}
              </div>
            );
          }
          if (inp.type === "number") {
            const stringValue =
              typeof value === "number"
                ? String(value)
                : typeof value === "string"
                ? value
                : "";
            return (
              <label key={inp.name} className="field">
                <span className="field-label">
                  {label}
                  {inp.required && <span className="required-mark"> *</span>}
                </span>
                <input
                  type="number"
                  step="any"
                  value={stringValue}
                  onChange={e =>
                    setValues({ ...values, [inp.name]: e.target.value })
                  }
                />
                {inp.description && <span className="muted">{inp.description}</span>}
              </label>
            );
          }
          // string
          const stringValue = typeof value === "string" ? value : "";
          return (
            <label key={inp.name} className="field">
              <span className="field-label">
                {label}
                {inp.required && <span className="required-mark"> *</span>}
              </span>
              <input
                type="text"
                value={stringValue}
                onChange={e =>
                  setValues({ ...values, [inp.name]: e.target.value })
                }
              />
              {inp.description && <span className="muted">{inp.description}</span>}
            </label>
          );
        })}
        <div className="form-actions">
          <button
            className="btn primary"
            onClick={onRun}
            disabled={busy || !allRequiredFilled}
          >
            {busy ? "Starting…" : "Run agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
