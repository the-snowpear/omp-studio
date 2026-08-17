import { Icon } from "../icons";
import { chipIconName } from "./ingest";
import type { MentionCandidate } from "./types";

export function MentionMenu({
  trigger,
  query,
  items,
  activeIndex,
  onSelect,
  onHover,
}: {
  trigger: "@" | "/";
  query: string;
  items: readonly MentionCandidate[];
  activeIndex: number;
  onSelect: (item: MentionCandidate) => void;
  onHover: (index: number) => void;
}) {
  const title = trigger === "@" ? "引用文件 / 文件夹 / Agent" : "插入技能";
  return (
    <div className="cm-mention" role="listbox" aria-label={title}>
      <div className="cm-mention-head">
        <span>{title}</span>
        {query ? <span className="muted tiny">{query}</span> : null}
      </div>
      {items.length === 0 ? (
        <div className="cm-mention-empty muted small">没有匹配项</div>
      ) : (
        items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`cm-mention-item${index === activeIndex ? " active" : ""}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
          >
            <Icon name={chipIconName(item.kind)} extra="sm" />
            <span className="cm-mention-label">{item.label}</span>
            {item.detail ? <span className="cm-mention-detail">{item.detail}</span> : null}
          </button>
        ))
      )}
    </div>
  );
}
