import { useStore } from "../store/useStore";

export type ModelPickerProps = {
  value: string | null; // "<endpointId>::<modelId>"
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
};

const NONE_VALUE = "__none__";

export default function ModelPicker({
  value,
  onChange,
  placeholder = "Select a model…",
  disabled
}: ModelPickerProps) {
  const models = useStore(s => s.models);

  return (
    <select
      className="model-picker"
      value={value ?? NONE_VALUE}
      disabled={disabled}
      onChange={e => {
        const v = e.target.value;
        onChange(v === NONE_VALUE ? null : v);
      }}
    >
      <option value={NONE_VALUE}>{placeholder}</option>
      {models.map(group => {
        const label =
          group.displayName + (group.source === "config" ? " (built-in)" : "");
        if (!group.ok) {
          const errLabel = group.error ?? "error";
          return (
            <optgroup key={group.endpointId} label={label} disabled>
              <option value={`__err__::${group.endpointId}`} disabled>
                {`<${errLabel}>`}
              </option>
            </optgroup>
          );
        }
        if (group.models.length === 0) {
          return (
            <optgroup key={group.endpointId} label={label} disabled>
              <option value={`__empty__::${group.endpointId}`} disabled>
                {"<no models>"}
              </option>
            </optgroup>
          );
        }
        return (
          <optgroup key={group.endpointId} label={label}>
            {group.models.map(m => (
              <option
                key={`${group.endpointId}::${m.id}`}
                value={`${group.endpointId}::${m.id}`}
              >
                {m.id}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
