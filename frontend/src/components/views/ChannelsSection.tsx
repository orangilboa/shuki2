import { useEffect, useState } from "react";
import { api, type ChannelCreateInput } from "../../api/client";
import {
  CHANNEL_EVENT_CATEGORIES,
  type ChannelDirection,
  type ChannelEventCategory,
  type ChannelKindDescriptor,
  type ChannelSummary
} from "../../types";

const DIRECTIONS: ChannelDirection[] = ["in_out", "out_only", "in_only"];

const DEFAULT_FILTER_JSON = JSON.stringify(
  {
    eventCategories: ["run.lifecycle", "run.interactions", "run.errors"]
  },
  null,
  2
);

const DEFAULT_INBOUND_JSON = JSON.stringify(
  { allowCommands: false, allowedCommandIds: [] },
  null,
  2
);

const DEFAULT_ADAPTER_CONFIG_JSON = "{}";

type CreateForm = {
  name: string;
  kind: string;
  direction: ChannelDirection;
  filterJson: string;
  inboundJson: string;
  adapterConfigJson: string;
};

function emptyForm(): CreateForm {
  return {
    name: "",
    kind: "",
    direction: "out_only",
    filterJson: DEFAULT_FILTER_JSON,
    inboundJson: DEFAULT_INBOUND_JSON,
    adapterConfigJson: DEFAULT_ADAPTER_CONFIG_JSON
  };
}

function parseJsonOrNull<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export default function ChannelsSection() {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [kinds, setKinds] = useState<ChannelKindDescriptor[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [form, setForm] = useState<CreateForm>(emptyForm());
  const [busy, setBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const [list, ks] = await Promise.all([
        api.listChannels(),
        api.listChannelKinds()
      ]);
      setChannels(list);
      setKinds(ks);
      if (!form.kind && ks.length > 0) {
        setForm(f => ({ ...f, kind: ks[0]!.kind, direction: ks[0]!.defaultDirection }));
      }
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createChannel() {
    setBusy(true);
    setCreateErr(null);
    try {
      const filter = parseJsonOrNull<ChannelCreateInput["filter"]>(form.filterJson);
      const inbound = parseJsonOrNull<ChannelCreateInput["inbound"]>(form.inboundJson);
      const adapterConfig = parseJsonOrNull<Record<string, unknown>>(
        form.adapterConfigJson
      );
      if (!filter) throw new Error("filter is not valid JSON");
      if (!inbound) throw new Error("inbound is not valid JSON");
      if (!adapterConfig) throw new Error("adapterConfig is not valid JSON");
      await api.createChannel({
        name: form.name,
        kind: form.kind,
        direction: form.direction,
        filter,
        inbound,
        adapterConfig
      });
      setForm(emptyForm());
      await refresh();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Channels</span>
        <button className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {loadErr && <p className="error-text">{loadErr}</p>}

      {channels.length === 0 ? (
        <p className="empty">No channels configured.</p>
      ) : (
        <ul className="list">
          {channels.map(c => (
            <ChannelRow key={c.id} ch={c} onChange={() => void refresh()} />
          ))}
        </ul>
      )}

      <div className="section-subhead">Add a new channel</div>
      <div className="form">
        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="My chat bridge"
          />
        </label>
        <label className="field">
          <span className="field-label">Kind</span>
          <select
            value={form.kind}
            onChange={e => {
              const k = e.target.value;
              const desc = kinds.find(x => x.kind === k);
              setForm({
                ...form,
                kind: k,
                direction: desc?.defaultDirection ?? form.direction
              });
            }}
          >
            <option value="">— select —</option>
            {kinds.map(k => (
              <option key={k.kind} value={k.kind}>
                {k.kind}
              </option>
            ))}
          </select>
          {kinds.length === 0 && (
            <span className="muted">
              No adapter kinds registered yet. Channels can still be saved and will
              start once a matching adapter is loaded.
            </span>
          )}
        </label>
        <label className="field">
          <span className="field-label">Direction</span>
          <select
            value={form.direction}
            onChange={e =>
              setForm({ ...form, direction: e.target.value as ChannelDirection })
            }
          >
            {DIRECTIONS.map(d => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">
            Filter (JSON) — categories: {CHANNEL_EVENT_CATEGORIES.join(", ")}
          </span>
          <textarea
            rows={5}
            value={form.filterJson}
            onChange={e => setForm({ ...form, filterJson: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Inbound policy (JSON)</span>
          <textarea
            rows={3}
            value={form.inboundJson}
            onChange={e => setForm({ ...form, inboundJson: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Adapter config (JSON)</span>
          <textarea
            rows={4}
            value={form.adapterConfigJson}
            onChange={e =>
              setForm({ ...form, adapterConfigJson: e.target.value })
            }
            spellCheck={false}
          />
        </label>
        {form.kind.startsWith("notifications.") && (
          <p className="muted">
            Notifications channels are outbound-only; direction is locked to out_only and
            inbound.allowCommands is forced to false at save time.
          </p>
        )}
        <div className="form-actions">
          <button
            className="btn primary"
            disabled={busy || form.name.length === 0 || form.kind.length === 0}
            onClick={() => void createChannel()}
          >
            {busy ? "Creating…" : "Create channel"}
          </button>
        </div>
        {createErr && <p className="error-text">{createErr}</p>}
      </div>
    </section>
  );
}

function ChannelRow({
  ch,
  onChange
}: {
  ch: ChannelSummary;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setErr(null);
    try {
      if (ch.enabled) await api.disableChannel(ch.id);
      else await api.enableChannel(ch.id);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete channel "${ch.name}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteChannel(ch.id);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="list-item">
      <div className="list-item-row">
        <span className="list-item-title">
          {ch.name}{" "}
          <span className="muted" style={{ fontSize: "0.85em" }}>
            ({ch.kind}, {ch.direction})
          </span>
          {ch.source === "config" && <span className="status"> built-in</span>}
        </span>
        <span style={{ display: "inline-flex", gap: 6 }}>
          <button className="btn" disabled={busy} onClick={() => void toggle()}>
            {ch.enabled ? "Disable" : "Enable"}
          </button>
          {ch.source === "user" && (
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </button>
          )}
        </span>
      </div>
      <div className="list-item-meta">
        categories: {ch.filter.eventCategories.join(", ") || "(none)"} ·
        inbound: {ch.inbound.allowCommands ? "commands ON" : "no commands"} ·
        {ch.enabled ? " enabled" : " disabled"}
      </div>
      {err && <p className="error-text">{err}</p>}
    </li>
  );
}
