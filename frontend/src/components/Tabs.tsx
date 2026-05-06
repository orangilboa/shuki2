import type { ReactNode } from "react";

export type TabItem = {
  id: string;
  label: ReactNode;
};

type Props = {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
};

export default function Tabs({ items, activeId, onChange }: Props) {
  return (
    <div className="tabs-bar" role="tablist">
      {items.map(item => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? "tab-pill active" : "tab-pill"}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
