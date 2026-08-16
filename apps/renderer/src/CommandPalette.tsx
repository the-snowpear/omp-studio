import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import {
  flattenPaletteItems,
  type PaletteAction,
  type PaletteGroup,
  type PaletteItem,
} from "./commandPaletteCatalog";

export type CommandPaletteHandle = {
  focusInput: () => void;
};

export const CommandPalette = forwardRef<CommandPaletteHandle, {
  open: boolean;
  groups: ReadonlyArray<PaletteGroup>;
  onQueryChange: (query: string) => void;
  query: string;
  onClose: () => void;
  onRun: (action: PaletteAction) => void;
}>(function CommandPalette({ open, groups, query, onQueryChange, onClose, onRun }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const flat = useMemo(() => flattenPaletteItems(groups), [groups]);
  const selectedId = flat[selected]?.id;

  useImperativeHandle(ref, () => ({
    focusInput: () => inputRef.current?.focus(),
  }));

  useEffect(() => {
    if (!open) return;
    setSelected(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (selected >= flat.length) setSelected(0);
  }, [flat.length, selected]);

  useEffect(() => {
    if (!open || !selectedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-cmdk-id="${CSS.escape(selectedId)}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: "nearest" });
  }, [open, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.isComposing) return;
      const withMod = event.ctrlKey || event.metaKey;
      if (withMod && /^[1-9]$/.test(event.key) && !event.shiftKey && !event.altKey) {
        const index = Number(event.key);
        const recent = flat.find((item) => item.recentIndex === index);
        if (recent) {
          event.preventDefault();
          onRun(recent.action);
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!flat.length) return;
        setSelected((value) => (value + 1) % flat.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!flat.length) return;
        setSelected((value) => (value - 1 + flat.length) % flat.length);
      } else if (event.key === "Home") {
        event.preventDefault();
        setSelected(0);
      } else if (event.key === "End") {
        event.preventDefault();
        if (flat.length) setSelected(flat.length - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const item = flat[selected];
        if (item && !item.disabled) onRun(item.action);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, flat, selected, onClose, onRun]);

  if (!open) return null;

  const activeDescendant = selectedId ? `cmdkItem-${selectedId}` : undefined;

  return createPortal(
    <div
      className="cmdk-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cmdk-shell">
        <div className="cmdk-glow" aria-hidden="true" />
        <div
          className="cmdk"
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
          onMouseDown={(event) => event.stopPropagation()}
        >
        <div className="cmdk-input">
          <Icon name="search" extra="sm" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdkList"
            aria-autocomplete="list"
            aria-label="搜索命令、会话、页面"
            {...(activeDescendant ? { "aria-activedescendant": activeDescendant } : {})}
            placeholder="搜索命令、会话、页面…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <span className="kbd" aria-hidden="true">Esc</span>
        </div>
        <div className="cmdk-list" id="cmdkList" ref={listRef} role="listbox" aria-label="搜索结果">
          {flat.length === 0 ? (
            <div className="cmdk-empty">
              <Icon name="search" />
              无匹配结果
            </div>
          ) : groups.map((group) => (
            <div className="cmdk-group" key={group.id} role="group" aria-label={group.label}>
              <div className="cmdk-group-label">{group.label}</div>
              {group.items.map((item) => (
                <PaletteRow
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onHover={() => {
                    const index = flat.findIndex((entry) => entry.id === item.id);
                    if (index >= 0) setSelected(index);
                  }}
                  onRun={() => onRun(item.action)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {flat.length ? `${flat.length} 个结果` : "无匹配结果"}
        </div>
      </div>
      </div>
    </div>,
    document.body,
  );
});

function PaletteRow({
  item,
  selected,
  onHover,
  onRun,
}: {
  item: PaletteItem;
  selected: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      className={`cmdk-item${selected ? " sel" : ""}`}
      id={`cmdkItem-${item.id}`}
      data-cmdk-id={item.id}
      role="option"
      aria-selected={selected}
      aria-disabled={item.disabled === true}
      disabled={item.disabled === true}
      title={item.disabledReason}
      onPointerEnter={onHover}
      onClick={() => {
        if (!item.disabled) onRun();
      }}
    >
      <Icon name={item.icon} extra="sm" />
      <span className="cmdk-item-label">{item.label}</span>
      {item.meta ? <span className="cmdk-item-meta">{item.meta}</span> : null}
      {item.hint ? <span className="kbd">{item.hint}</span> : null}
    </button>
  );
}
