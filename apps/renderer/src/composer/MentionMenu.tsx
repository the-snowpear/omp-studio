import { useI18n } from "../i18n";
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
  trigger: "@" | "/" | "^";
  query: string;
  items: readonly MentionCandidate[];
  activeIndex: number;
  onSelect: (item: MentionCandidate) => void;
  onHover: (index: number) => void;
}) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const title = trigger === "^"
    ? t("runtimeUpgrade.modelMention")
    : trigger === "@"
      ? (zh ? "引用文件 / 文件夹 / Agent" : "Mention File / Folder / Agent")
      : (zh ? "指令已改到输入开头的 /" : "Commands moved to / at the start");
  return (
    <div className="cm-mention" role="listbox" aria-label={title}>
      <div className="cm-mention-head">
        <span>{title}</span>
        {query ? <span className="muted tiny">{query}</span> : null}
      </div>
      {items.length === 0 ? (
        <div className="cm-mention-empty muted small">{zh ? "没有匹配项" : "No matches"}</div>
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
