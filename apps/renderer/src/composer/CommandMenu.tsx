import { SLASH_GROUP_LABEL, type SlashGroup, type StudioSlashCommand } from "./commands";

function formatCommandHint(raw: string): string {
  const hint = raw.trim();
  if (hint.startsWith("[") || hint.startsWith("<")) return hint;
  return `[${hint}]`;
}

export function CommandMenu({
  query,
  items,
  activeIndex,
  onSelect,
  onHover,
}: {
  query: string;
  items: readonly StudioSlashCommand[];
  activeIndex: number;
  onSelect: (item: StudioSlashCommand) => void;
  onHover: (index: number) => void;
}) {
  let lastGroup: SlashGroup | undefined;
  return (
    <div className="cm-mention cm-command" role="listbox" aria-label="指令">
      <div className="cm-mention-head">
        <span>指令</span>
        {query ? <span className="muted tiny">{query}</span> : null}
      </div>
      {items.length === 0 ? (
        <div className="cm-mention-empty muted small">没有匹配的指令</div>
      ) : (
        items.map((item, index) => {
          const showGroup = item.group !== lastGroup;
          lastGroup = item.group;
          const hint = item.hint ?? (item.allowArgs ? "参数" : undefined);
          return (
            <div key={item.name}>
              {showGroup ? <div className="cm-mention-group">{SLASH_GROUP_LABEL[item.group]}</div> : null}
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={item.availability === "disabled"}
                className={`cm-mention-item cm-command-item${index === activeIndex ? " active" : ""}${item.availability === "disabled" ? " is-disabled" : ""}`}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (item.availability !== "disabled") onSelect(item);
                }}
              >
                <span className="cm-command-id">/{item.name}</span>
                {hint ? <span className="cm-command-hint">{formatCommandHint(hint)}</span> : null}
                <span className="cm-mention-detail">{item.disabledReason ?? item.description}</span>
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
