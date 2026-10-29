import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AppSelect } from "./AppSelect";
import { Icon } from "./icons";
import { useI18n } from "./i18n";

export type SlidingTabItem<T extends string> = {
  id: T;
  icon: string;
  label: string;
  buttonId: string;
  panelId: string;
  badge?: ReactNode;
};

/** Page tabs keep selection on the real button, without a measured label clone. */
export function SlidingTabs<T extends string>({
  id,
  ariaLabel,
  value,
  items,
  onChange,
  syncKey,
  orientation = "vertical",
  className,
}: {
  id?: string;
  ariaLabel: string;
  value: T;
  items: ReadonlyArray<SlidingTabItem<T>>;
  onChange: (id: T) => void;
  syncKey?: string;
  orientation?: "vertical" | "horizontal";
  className?: string;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const { resolvedLanguage } = useI18n();
  const allTabsLabel = resolvedLanguage === "zh" ? "全部标签" : "All tabs";
  // Callers recreate item objects on render; observe only structural/text changes.
  // Badge and font size changes are picked up by the ResizeObserver below.
  const itemKey = items.map((item) => `${item.buttonId}:${item.label}`).join("|");

  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const sync = () => {
      const horizontal = orientation === "horizontal";
      // Include the picker's reserved space when deciding whether it is needed,
      // so it disappears again once the full strip would fit without it.
      const available = horizontal
        ? Math.max(tabs.clientWidth, tabs.parentElement?.clientWidth ?? 0)
        : Math.max(tabs.clientHeight, tabs.parentElement?.clientHeight ?? 0);
      const hasOverflow = (horizontal ? tabs.scrollWidth : tabs.scrollHeight) > available + 1;
      setOverflow(hasOverflow);
      const active = tabs.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!active || !hasOverflow) return;
      // Only scroll the tab strip, never the page or a surrounding dialog.
      const view = tabs.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      if (horizontal) {
        const left = view.left + tabs.clientLeft;
        const right = left + tabs.clientWidth;
        tabs.scrollLeft += rect.left < left ? rect.left - left : Math.max(0, rect.right - right);
      } else {
        const top = view.top + tabs.clientTop;
        const bottom = top + tabs.clientHeight;
        tabs.scrollTop += rect.top < top ? rect.top - top : Math.max(0, rect.bottom - bottom);
      }
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(tabs);
    for (const button of tabs.querySelectorAll('[role="tab"]')) observer.observe(button);
    return () => observer.disconnect();
  }, [value, syncKey, orientation, itemKey]);

  const activate = (next: T, focus = false) => {
    if (next !== value) onChange(next);
    if (focus) {
      const buttonId = items.find((item) => item.id === next)?.buttonId;
      const button = Array.from(tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
        .find((button) => button.id === buttonId);
      button?.focus({ preventScroll: true });
    }
  };

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const keys = items.map((item) => item.id);
    const index = keys.indexOf(value);
    if (index < 0) return;
    let next: T | undefined;
    const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const back = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    if (event.key === forward) next = keys[(index + 1) % keys.length];
    else if (event.key === back) next = keys[(index - 1 + keys.length) % keys.length];
    else if (event.key === "Home") next = keys[0];
    else if (event.key === "End") next = keys[keys.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    activate(next, true);
  };

  return (
    <div className={`page-tabs page-tabs--${orientation}`}>
      <div
        id={id}
        className={className ?? (orientation === "vertical" ? "cap-side" : "workspace-tabs")}
        ref={tabsRef}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation={orientation}
        onKeyDown={onTabKey}
      >
        {items.map((item) => {
          const active = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              id={item.buttonId}
              role="tab"
              aria-controls={item.panelId}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={active ? "active" : undefined}
              data-tip={item.label}
              onClick={() => activate(item.id)}
            >
              <Icon name={item.icon} extra="sm" />
              <span className="page-tab-label">{item.label}</span>
              {item.badge}
            </button>
          );
        })}
      </div>
      {overflow ? (
        <AppSelect
          className="page-tabs-all"
          aria-label={`${ariaLabel} · ${allTabsLabel}`}
          data-tip={allTabsLabel}
          value={value}
          onChange={(event) => {
            const item = items.find((item) => item.id === event.target.value);
            if (item) activate(item.id, true);
          }}
        >
          {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </AppSelect>
      ) : null}
    </div>
  );
}
