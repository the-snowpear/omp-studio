import {
  Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState,
  type ButtonHTMLAttributes, type KeyboardEvent, type OptgroupHTMLAttributes,
  type OptionHTMLAttributes, type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";

import { Icon } from "./icons";
import { useI18n } from "./i18n";

export interface AppSelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange" | "children" | "type" | "role"> {
  value: string | number | undefined;
  /** Receives the same small target/value shape used by native select handlers. */
  onChange?: (event: { target: { value: string } }) => void;
  /** Declarative option / optgroup elements, consumed as data, never rendered natively. */
  children: ReactNode;
  placeholder?: string;
}

interface SelectOption {
  value: string;
  label: string;
  disabled: boolean;
  index: number;
  group?: { id: number; label: string };
}

function optionText(node: ReactNode): string {
  return Children.toArray(node).map(child => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : "";
  }).join("");
}

function collectOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  let groupId = 0;
  function visit(nodes: ReactNode, group?: SelectOption["group"], groupDisabled = false) {
    Children.forEach(nodes, child => {
      if (!isValidElement(child)) return;
      if (child.type === "option") {
        const props = child.props as OptionHTMLAttributes<HTMLOptionElement>;
        const label = props.label ?? optionText(props.children);
        options.push({ value: String(props.value ?? label), label, disabled: groupDisabled || !!props.disabled, index: options.length, ...(group ? { group } : {}) });
      } else if (child.type === "optgroup") {
        const props = child.props as OptgroupHTMLAttributes<HTMLOptGroupElement>;
        visit(props.children, { id: groupId++, label: props.label ?? "" }, groupDisabled || !!props.disabled);
      } else if (child.type === Fragment) {
        visit((child.props as { children?: ReactNode }).children, group, groupDisabled);
      }
    });
  }
  visit(children);
  return options;
}

/** The ordinary single-select used throughout Studio. Business state stays at the call site. */
export function AppSelect({ value, onChange, children, placeholder, className = "", disabled, onKeyDown, onClick, ...props }: AppSelectProps) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const uid = useId();
  const triggerId = props.id ?? `${uid}-trigger`;
  const listId = `${uid}-list`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 180, maxHeight: 360, above: false });
  const options = useMemo(() => collectOptions(children), [children]);
  const selected = options.find(option => option.value === String(value ?? ""));
  const searchable = options.length > 10;
  const needle = query.trim().toLocaleLowerCase();
  const visible = options.filter(option => !needle || `${option.label} ${option.value} ${option.group?.label ?? ""}`.toLocaleLowerCase().includes(needle));
  const enabled = visible.filter(option => !option.disabled);
  const activeOption = enabled.find(option => option.index === active) ?? enabled[0];
  const optionId = (index: number) => `${uid}-option-${index}`;
  const label = selected?.label ?? placeholder ?? (value ? String(value) : "—");
  const fieldLabel = props["aria-label"] || trigger.current?.labels?.[0]?.textContent?.replace(label, "").trim() || label;

  const dismiss = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };
  const choose = (option: SelectOption) => {
    dismiss(true);
    if (option.value !== String(value ?? "")) onChange?.({ target: { value: option.value } });
  };
  const expand = (last = false) => {
    if (disabled) return;
    setQuery("");
    setActive(selected && !selected.disabled ? selected.index : (last ? [...options].reverse().find(option => !option.disabled)?.index : options.find(option => !option.disabled)?.index) ?? -1);
    setOpen(true);
  };

  const place = useCallback(() => {
    const button = trigger.current;
    const menu = popup.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const desired = Math.min((list.current?.scrollHeight ?? 0) + (search.current?.parentElement?.offsetHeight ?? 0) + 14, 360);
    const flip = below < desired && above > below;
    const maxHeight = Math.max(0, Math.min(360, flip ? above : below));
    const height = Math.min(desired, maxHeight);
    setPosition({
      top: flip ? rect.top - height - 6 : rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width, maxHeight, above: flip,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, query, options.length, place]);
  useLayoutEffect(() => {
    if (!open) return;
    if (searchable) search.current?.focus();
  }, [open, searchable]);
  useLayoutEffect(() => {
    if (open && activeOption) document.getElementById(optionId(activeOption.index))?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeOption?.index]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popup.current?.contains(target)) {
        setOpen(false);
        setQuery("");
      }
    };
    const reposition = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      place();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", reposition, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (trigger.current) observer?.observe(trigger.current);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", reposition, true);
      observer?.disconnect();
    };
  }, [open, place]);
  useEffect(() => {
    if (disabled) dismiss();
  }, [disabled]);

  const keys = (event: KeyboardEvent<HTMLElement>, inSearch = false) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Tab" && open) {
      // Return to the field before native Tab navigation / the parent dialog's trap.
      flushSync(() => dismiss(true));
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) { expand(event.key === "ArrowUp" || event.key === "End"); return; }
      const current = enabled.findIndex(option => option.index === activeOption?.index);
      const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) : enabled[(current + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length];
      if (next) setActive(next.index);
      return;
    }
    if (event.key === "Enter" || (event.key === " " && !inSearch)) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) expand();
      else if (activeOption) choose(activeOption);
      return;
    }
    if (!inSearch && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const previous = now - typeahead.current.at < 700 ? typeahead.current.text : "";
      const text = previous + event.key.toLocaleLowerCase();
      typeahead.current = { text, at: now };
      const prefix = [...text].every(char => char === text[0]) ? text[0]! : text;
      const start = open ? activeOption?.index ?? -1 : selected?.index ?? -1;
      const candidates = [...options.filter(option => option.index > start), ...options.filter(option => option.index <= start)];
      const match = candidates.find(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(prefix));
      if (match) {
        event.preventDefault();
        event.stopPropagation();
        if (open) setActive(match.index);
        else choose(match);
      }
    }
  };

  const renderOption = (option: SelectOption) => (
    <button
      type="button" role="option" tabIndex={-1} key={option.index} id={optionId(option.index)}
      aria-selected={option.value === String(value ?? "")} disabled={option.disabled}
      className={`app-select-option${activeOption?.index === option.index ? " is-active" : ""}`}
      onMouseDown={event => event.preventDefault()}
      onPointerMove={() => { if (!option.disabled) setActive(option.index); }}
      onClick={() => choose(option)}
    >
      <span>{option.label}</span>
      <span className="app-select-check">{option.value === String(value ?? "") ? <Icon name="check" extra="sm" /> : null}</span>
    </button>
  );
  const rows: ReactNode[] = [];
  for (let i = 0; i < visible.length;) {
    const option = visible[i]!;
    if (!option.group) { rows.push(renderOption(option)); i++; continue; }
    const group = option.group;
    const members: ReactNode[] = [];
    while (visible[i]?.group?.id === group.id) members.push(renderOption(visible[i++]!));
    rows.push(<div role="group" aria-labelledby={`${uid}-group-${group.id}`} key={`group-${group.id}`}><div className="app-select-group" id={`${uid}-group-${group.id}`}>{group.label}</div>{members}</div>);
  }

  return <>
    <button
      {...props} id={triggerId} ref={trigger} type="button" role="combobox"
      className={`select app-select ${className}`} disabled={disabled}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && activeOption ? optionId(activeOption.index) : undefined}
      onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) keys(event); }}
      onClick={event => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.currentTarget.focus();
        if (open) dismiss(); else expand();
      }}
    >
      <span className="app-select-value">{label}</span><Icon name="chevron-d" extra="sm app-select-chevron" />
    </button>
    {open && !disabled ? createPortal(
      <div
        ref={popup} className="app-select-popup" data-side={position.above ? "top" : "bottom"}
        style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
        onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      >
        {searchable ? <div className="app-select-search"><Icon name="search" extra="sm" /><input
          ref={search} type="search" role="searchbox" value={query}
          aria-label={zh ? "搜索选项" : "Search options"} placeholder={zh ? "搜索选项…" : "Search options…"}
          aria-controls={listId} aria-activedescendant={activeOption ? optionId(activeOption.index) : undefined}
          onChange={event => { setQuery(event.target.value); setActive(-1); }} onKeyDown={event => keys(event, true)}
        /></div> : null}
        <div ref={list} id={listId} role="listbox" aria-label={fieldLabel} aria-labelledby={props["aria-labelledby"]} className="app-select-list">
          {rows.length ? rows : <div className="app-select-empty" role="status">{zh ? "没有匹配的选项" : "No matching options"}</div>}
        </div>
      </div>,
      // Keep the search field within the modal's focus and accessibility boundary.
      trigger.current?.closest("[role='dialog']") ?? document.body,
    ) : null}
  </>;
}
