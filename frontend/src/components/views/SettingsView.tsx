import { useState } from "react";
import { useStore } from "../../store/useStore";
import type { Agent, AgentExec, AgentInput, EndpointSummary } from "../../types";
import ModelPicker from "../ModelPicker";

// ---------- helpers for JSON validation ----------------------------------

function validateInputsJson(raw: string): { ok: true; value: AgentInput[] } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, error: "inputs must be an array" };
    for (const item of parsed) {
      if (!item || typeof item !== "object") return { ok: false, error: "each input must be an object" };
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== "string" || obj.name.length === 0)
        return { ok: false, error: "each input needs a string `name`" };
      if (obj.type !== "string" && obj.type !== "number" && obj.type !== "boolean")
        return { ok: false, error: `invalid type for "${obj.name}" (string|number|boolean)` };
    }
    return { ok: true, value: parsed as AgentInput[] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function validateExecJson(raw: string): { ok: true; value: AgentExec } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "exec must be an object" };
    const obj = parsed as Record<string, unknown>;
    if (obj.kind === "mock") return { ok: true, value: { kind: "mock" } };
    if (obj.kind === "subprocess") {
      if (typeof obj.command !== "string") return { ok: false, error: "subprocess.command must be a string" };
      if (!Array.isArray(obj.args) || !obj.args.every(a => typeof a === "string"))
        return { ok: false, error: "subprocess.args must be string[]" };
      if (obj.protocol !== "jsonl" && obj.protocol !== "raw")
        return { ok: false, error: "subprocess.protocol must be jsonl|raw" };
      return { ok: true, value: parsed as AgentExec };
    }
    return { ok: false, error: "exec.kind must be `mock` or `subprocess`" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const DEFAULT_INPUTS_JSON = "[]";
const DEFAULT_EXEC_JSON = JSON.stringify({ kind: "mock" }, null, 2);
const INPUTS_HELP =
  'Array of { name, label?, type: "string"|"number"|"boolean", required?, default?, description? }';
const EXEC_HELP =
  '{"kind":"mock"} or {"kind":"subprocess","command":"...","args":[],"protocol":"jsonl"|"raw"}';

type EditState = {
  displayName: string;
  baseUrl: string;
  // key handling: "keep" leaves existing key alone (no change),
  // "replace" sends a new key string, "clear" sends null.
  keyMode: "keep" | "replace" | "clear";
  newKey: string;
};

function CustomEndpointRow({ ep }: { ep: EndpointSummary }) {
  const updateEndpoint = useStore(s => s.updateEndpoint);
  const deleteEndpoint = useStore(s => s.deleteEndpoint);

  const [edit, setEdit] = useState<EditState>({
    displayName: ep.displayName,
    baseUrl: ep.baseUrl,
    keyMode: "keep",
    newKey: ""
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const patch: {
        displayName?: string;
        baseUrl?: string;
        apiKey?: string | null;
      } = {};
      if (edit.displayName !== ep.displayName) patch.displayName = edit.displayName;
      if (edit.baseUrl !== ep.baseUrl) patch.baseUrl = edit.baseUrl;
      if (edit.keyMode === "replace") patch.apiKey = edit.newKey;
      else if (edit.keyMode === "clear") patch.apiKey = null;

      if (Object.keys(patch).length === 0) {
        setBusy(false);
        return;
      }
      await updateEndpoint(ep.id, patch);
      setEdit(s => ({ ...s, keyMode: "keep", newKey: "" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!confirm(`Delete endpoint "${ep.displayName}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteEndpoint(ep.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const keyDisplay = ep.hasKey ? ep.apiKeyMasked ?? "(set)" : "not set";

  return (
    <div className="list-item endpoint-row">
      <div className="form">
        <label className="field">
          <span className="field-label">Display name</span>
          <input
            type="text"
            value={edit.displayName}
            onChange={e => setEdit({ ...edit, displayName: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">Base URL</span>
          <input
            type="text"
            value={edit.baseUrl}
            onChange={e => setEdit({ ...edit, baseUrl: e.target.value })}
          />
        </label>
        <div className="field">
          <span className="field-label">API key</span>
          {edit.keyMode === "keep" && (
            <div className="key-row">
              <code>{keyDisplay}</code>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setEdit({ ...edit, keyMode: "replace", newKey: "" })}
              >
                Replace key
              </button>
              {ep.hasKey && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setEdit({ ...edit, keyMode: "clear", newKey: "" })}
                >
                  Clear key
                </button>
              )}
            </div>
          )}
          {edit.keyMode === "replace" && (
            <div className="key-row">
              <input
                type="password"
                placeholder="New API key"
                value={edit.newKey}
                onChange={e => setEdit({ ...edit, newKey: e.target.value })}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn ghost"
                onClick={() => setEdit({ ...edit, keyMode: "keep", newKey: "" })}
              >
                Cancel
              </button>
            </div>
          )}
          {edit.keyMode === "clear" && (
            <div className="key-row">
              <span className="muted">Will clear the API key on save.</span>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setEdit({ ...edit, keyMode: "keep", newKey: "" })}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {err && <p className="error-text">{err}</p>}
        <div className="form-actions">
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function BuiltInEndpointRow({ ep }: { ep: EndpointSummary }) {
  return (
    <div className="list-item">
      <div className="list-item-row">
        <span className="list-item-title">{ep.displayName}</span>
        <span className="status">built-in</span>
      </div>
      <dl className="kv">
        <dt>Base URL</dt>
        <dd>
          <code>{ep.baseUrl}</code>
        </dd>
        <dt>API key</dt>
        <dd>{ep.hasKey ? <code>{ep.apiKeyMasked ?? "(set)"}</code> : <span className="muted">not set</span>}</dd>
      </dl>
    </div>
  );
}

function AddEndpointForm() {
  const createEndpoint = useStore(s => s.createEndpoint);
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!displayName.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createEndpoint({
        displayName: displayName.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.length > 0 ? apiKey : null
      });
      setDisplayName("");
      setBaseUrl("");
      setApiKey("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="list-item">
      <div className="form">
        <div className="section-title">Add endpoint</div>
        <label className="field">
          <span className="field-label">Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="My OpenAI"
          />
        </label>
        <label className="field">
          <span className="field-label">Base URL</span>
          <input
            type="text"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label className="field">
          <span className="field-label">API key (optional)</span>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </label>
        {err && <p className="error-text">{err}</p>}
        <div className="form-actions">
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "Adding…" : "Add endpoint"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Agents section -----------------------------------------------

function BuiltInAgentRow({ agent }: { agent: Agent }) {
  return (
    <div className="list-item">
      <div className="list-item-row">
        <span className="list-item-title">{agent.name}</span>
        <span className="status">built-in</span>
      </div>
      {agent.description && <p className="muted">{agent.description}</p>}
      <dl className="kv">
        <dt>Exec</dt>
        <dd>
          <code>{agent.exec.kind}</code>
        </dd>
        <dt>Model</dt>
        <dd>{agent.model ? <code>{agent.model}</code> : <span className="muted">default</span>}</dd>
        <dt>Inputs</dt>
        <dd>
          {agent.inputs.length === 0 ? (
            <span className="muted">none</span>
          ) : (
            <span className="muted">{agent.inputs.map(i => i.name).join(", ")}</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

function CustomAgentRow({ agent }: { agent: Agent }) {
  const updateAgent = useStore(s => s.updateAgent);
  const deleteAgent = useStore(s => s.deleteAgent);

  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [model, setModel] = useState<string | null>(agent.model);
  const [showSpec, setShowSpec] = useState(false);
  const [inputsJson, setInputsJson] = useState(JSON.stringify(agent.inputs, null, 2));
  const [execJson, setExecJson] = useState(JSON.stringify(agent.exec, null, 2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inputsResult = validateInputsJson(inputsJson);
  const execResult = validateExecJson(execJson);
  const specHasErrors = !inputsResult.ok || !execResult.ok;

  async function save() {
    if (specHasErrors) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: Parameters<typeof updateAgent>[1] = {};
      if (name !== agent.name) patch.name = name;
      if (description !== agent.description) patch.description = description;
      if (model !== agent.model) patch.model = model;
      if (inputsResult.ok && JSON.stringify(inputsResult.value) !== JSON.stringify(agent.inputs)) {
        patch.inputs = inputsResult.value;
      }
      if (execResult.ok && JSON.stringify(execResult.value) !== JSON.stringify(agent.exec)) {
        patch.exec = execResult.value;
      }
      if (Object.keys(patch).length === 0) {
        setBusy(false);
        return;
      }
      await updateAgent(agent.id, patch);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteAgent(agent.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="list-item agent-edit">
      <div className="form">
        <label className="field">
          <span className="field-label">Name</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Model</span>
          <ModelPicker value={model} onChange={setModel} placeholder="Default…" />
        </label>

        <div className="form-actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => setShowSpec(s => !s)}
          >
            {showSpec ? "Hide spec" : "Edit spec"}
          </button>
        </div>

        {showSpec && (
          <>
            <label className="field">
              <span className="field-label">Inputs (JSON)</span>
              <textarea
                value={inputsJson}
                onChange={e => setInputsJson(e.target.value)}
                spellCheck={false}
              />
              {!inputsResult.ok ? (
                <span className="error-text">{inputsResult.error}</span>
              ) : (
                <span className="muted">{INPUTS_HELP}</span>
              )}
            </label>
            <label className="field">
              <span className="field-label">Exec (JSON)</span>
              <textarea
                value={execJson}
                onChange={e => setExecJson(e.target.value)}
                spellCheck={false}
              />
              {!execResult.ok ? (
                <span className="error-text">{execResult.error}</span>
              ) : (
                <span className="muted">{EXEC_HELP}</span>
              )}
            </label>
          </>
        )}

        {err && <p className="error-text">{err}</p>}
        <div className="form-actions">
          <button
            className="btn primary"
            onClick={save}
            disabled={busy || specHasErrors}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function AddAgentForm() {
  const createAgent = useStore(s => s.createAgent);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [inputsJson, setInputsJson] = useState(DEFAULT_INPUTS_JSON);
  const [execJson, setExecJson] = useState(DEFAULT_EXEC_JSON);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inputsResult = validateInputsJson(inputsJson);
  const execResult = validateExecJson(execJson);
  const specHasErrors = !inputsResult.ok || !execResult.ok;

  async function submit() {
    if (!name.trim() || specHasErrors) return;
    if (!inputsResult.ok || !execResult.ok) return; // type narrowing
    setBusy(true);
    setErr(null);
    try {
      await createAgent({
        name: name.trim(),
        description: description.trim() || undefined,
        model: model ?? null,
        inputs: inputsResult.value,
        exec: execResult.value
      });
      setName("");
      setDescription("");
      setModel(null);
      setInputsJson(DEFAULT_INPUTS_JSON);
      setExecJson(DEFAULT_EXEC_JSON);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="list-item agent-edit">
      <div className="form">
        <div className="section-title">Add agent</div>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="my-agent"
          />
        </label>
        <label className="field">
          <span className="field-label">Description (optional)</span>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Model (optional)</span>
          <ModelPicker value={model} onChange={setModel} placeholder="Default…" />
        </label>
        <label className="field">
          <span className="field-label">Inputs (JSON)</span>
          <textarea
            value={inputsJson}
            onChange={e => setInputsJson(e.target.value)}
            spellCheck={false}
          />
          {!inputsResult.ok ? (
            <span className="error-text">{inputsResult.error}</span>
          ) : (
            <span className="muted">{INPUTS_HELP}</span>
          )}
        </label>
        <label className="field">
          <span className="field-label">Exec (JSON)</span>
          <textarea
            value={execJson}
            onChange={e => setExecJson(e.target.value)}
            spellCheck={false}
          />
          {!execResult.ok ? (
            <span className="error-text">{execResult.error}</span>
          ) : (
            <span className="muted">{EXEC_HELP}</span>
          )}
        </label>
        {err && <p className="error-text">{err}</p>}
        <div className="form-actions">
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy || !name.trim() || specHasErrors}
          >
            {busy ? "Adding…" : "Add agent"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SettingsView() {
  const endpoints = useStore(s => s.endpoints);
  const agents = useStore(s => s.agents);
  const models = useStore(s => s.models);
  const modelsLoading = useStore(s => s.modelsLoading);
  const modelsError = useStore(s => s.modelsError);
  const loadModels = useStore(s => s.loadModels);

  const [pickerValue, setPickerValue] = useState<string | null>(null);

  const builtIns = endpoints.filter(e => e.source === "config");
  const userEps = endpoints.filter(e => e.source === "user");
  const builtInAgents = agents.filter(a => a.source === "config");
  const userAgents = agents.filter(a => a.source === "user");

  return (
    <div className="view settings">
      <div className="view-header">
        <h2>Settings</h2>
        <p className="muted">Configure endpoints and inspect available models.</p>
      </div>

      <section className="section">
        <div className="section-header">
          <span className="section-title">Endpoints</span>
        </div>

        <div className="section-subhead">Built-in endpoints</div>
        {builtIns.length === 0 ? (
          <p className="empty">None.</p>
        ) : (
          <ul className="list">
            {builtIns.map(ep => (
              <li key={ep.id}>
                <BuiltInEndpointRow ep={ep} />
              </li>
            ))}
          </ul>
        )}

        <div className="section-subhead">Custom endpoints</div>
        {userEps.length === 0 ? (
          <p className="empty">No custom endpoints yet.</p>
        ) : (
          <ul className="list">
            {userEps.map(ep => (
              <li key={ep.id}>
                <CustomEndpointRow ep={ep} />
              </li>
            ))}
          </ul>
        )}

        <div className="section-subhead">Add a new endpoint</div>
        <AddEndpointForm />
      </section>

      <section className="section">
        <div className="section-header">
          <span className="section-title">Agents</span>
        </div>

        <div className="section-subhead">Built-in agents</div>
        {builtInAgents.length === 0 ? (
          <p className="empty">None.</p>
        ) : (
          <ul className="list">
            {builtInAgents.map(a => (
              <li key={a.id}>
                <BuiltInAgentRow agent={a} />
              </li>
            ))}
          </ul>
        )}

        <div className="section-subhead">Custom agents</div>
        {userAgents.length === 0 ? (
          <p className="empty">No custom agents yet.</p>
        ) : (
          <ul className="list">
            {userAgents.map(a => (
              <li key={a.id}>
                <CustomAgentRow agent={a} />
              </li>
            ))}
          </ul>
        )}

        <div className="section-subhead">Add a new agent</div>
        <AddAgentForm />
      </section>

      <section className="section">
        <div className="section-header">
          <span className="section-title">Models</span>
          <button
            className="btn"
            onClick={() => loadModels({ refresh: true })}
            disabled={modelsLoading}
          >
            {modelsLoading ? "Refreshing…" : "Refresh models"}
          </button>
        </div>
        {modelsError && <p className="error-text">{modelsError}</p>}
        {models.length === 0 && !modelsLoading ? (
          <p className="empty">No model groups loaded.</p>
        ) : (
          <ul className="list">
            {models.map(g => (
              <li key={g.endpointId} className="list-item">
                <div className="list-item-row">
                  <span className="list-item-title">{g.displayName}</span>
                  {g.source === "config" && <span className="status">built-in</span>}
                </div>
                <div className="list-item-meta">
                  {g.ok ? `${g.models.length} model${g.models.length === 1 ? "" : "s"}` : `error: ${g.error ?? "unknown"}`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <div className="section-header">
          <span className="section-title">Try the picker</span>
        </div>
        <div className="form">
          <ModelPicker value={pickerValue} onChange={setPickerValue} />
          <pre className="picker-debug">{JSON.stringify({ value: pickerValue }, null, 2)}</pre>
        </div>
      </section>
    </div>
  );
}
