import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import "./sessionPicker.css";

export interface SessionPickerItem {
  id: string;
  title: string;
  metadata: ReactNode;
  excerpt?: string | undefined;
  marker?: ReactNode;
}

/** The native picker keeps a single selection and accepts it with Enter. */
export function SessionPickerList({ items, selectedId, onSelect, onAccept, disabled, listRef, label }: {
  items: readonly SessionPickerItem[];
  selectedId?: string | undefined;
  onSelect(id: string): void;
  onAccept(): void;
  disabled?: boolean;
  listRef: RefObject<HTMLUListElement | null>;
  label: string;
}) {
  function keys(event: KeyboardEvent<HTMLUListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onAccept();
      return;
    }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    const index = buttons.findIndex(button => button === event.currentTarget.ownerDocument.activeElement);
    let next: number;
    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  return <ul className="session-picker-list" ref={listRef} aria-label={label} onKeyDown={keys}>
    {items.map(item => <li key={item.id}>
      <button
        type="button"
        className="session-picker-row"
        aria-pressed={selectedId === item.id}
        tabIndex={selectedId === item.id ? 0 : -1}
        disabled={disabled}
        onFocus={() => onSelect(item.id)}
        onClick={() => onSelect(item.id)}
        onDoubleClick={onAccept}
      >
        <span className="session-picker-row-top"><strong>{item.title}</strong>{item.marker}</span>
        <span className="session-picker-meta">{item.metadata}</span>
        {item.excerpt ? <span className="session-picker-excerpt">{item.excerpt}</span> : null}
      </button>
    </li>)}
  </ul>;
}

export function SessionPickerSearch({ value, onChange, onAccept, label, listRef, inputRef, disabled }: {
  value: string;
  onChange(value: string): void;
  onAccept(): void;
  label: string;
  listRef: RefObject<HTMLUListElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}) {
  return <label className="session-picker-search">
    <Icon name="search" extra="sm" />
    <input
      ref={inputRef}
      className="input"
      type="search"
      aria-label={label}
      placeholder={label}
      value={value}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          listRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
        } else if (event.key === "Enter") {
          event.preventDefault();
          onAccept();
        }
      }}
    />
  </label>;
}

export function SessionPickerKeys() {
  const { resolvedLanguage } = useI18n();
  return <span className="session-picker-keys" aria-hidden="true">
    <kbd>↑</kbd><kbd>↓</kbd><span>{resolvedLanguage === "zh" ? "选择" : "Select"}</span>
    <kbd>Enter</kbd><span>{resolvedLanguage === "zh" ? "继续" : "Continue"}</span>
  </span>;
}

export function sessionPickerTime(value: string, language: string): string {
  return new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
