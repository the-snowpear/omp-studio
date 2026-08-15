import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon } from "./icons";

export type SlidingTabItem<T extends string> = {
  id: T;
  icon: string;
  label: string;
  buttonId: string;
  panelId: string;
  badge?: ReactNode;
};

function TabFace<T extends string>({ item }: { item: SlidingTabItem<T> }) {
  return (
    <>
      <Icon name={item.icon} extra="sm" />
      {item.label}
      {item.badge}
    </>
  );
}

/**
 * Vertical side tab list with the sliding accent bubble used by page-nav /
 * model-config: a clipped purple clone covers the active row so the pill
 * sliding is the only color change.
 */
export function SlidingTabs<T extends string>({
  id,
  ariaLabel,
  value,
  items,
  onChange,
  syncKey,
}: {
  id?: string;
  ariaLabel: string;
  value: T;
  items: ReadonlyArray<SlidingTabItem<T>>;
  onChange: (id: T) => void;
  syncKey?: string;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<HTMLSpanElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const primed = useRef(false);

  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    const win = winRef.current;
    const mirror = mirrorRef.current;
    if (!tabs || !win || !mirror) return;

    const sync = (scroll: boolean) => {
      const active = tabs.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!active) return;
      const animate = primed.current;
      if (!animate) {
        win.style.transition = "none";
        mirror.style.transition = "none";
      }
      win.style.top = `${active.offsetTop}px`;
      win.style.height = `${active.offsetHeight}px`;
      mirror.style.top = `${-active.offsetTop}px`;
      if (!animate) {
        void win.offsetHeight;
        win.style.removeProperty("transition");
        mirror.style.removeProperty("transition");
      }
      primed.current = true;
      if (scroll) {
        const top = active.offsetTop;
        const bottom = top + active.offsetHeight;
        const viewTop = tabs.scrollTop;
        const viewBottom = viewTop + tabs.clientHeight;
        if (top < viewTop || bottom > viewBottom) {
          active.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
    };

    sync(true);
    const observer = new ResizeObserver(() => sync(false));
    observer.observe(tabs);
    for (const button of tabs.querySelectorAll('[role="tab"]')) observer.observe(button);
    return () => observer.disconnect();
  }, [value, syncKey]);

  const activate = (next: T, focus = false) => {
    onChange(next);
    if (focus) document.getElementById(items.find((item) => item.id === next)?.buttonId ?? "")?.focus();
  };

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = items.map((item) => item.id);
    const index = keys.indexOf(value);
    if (index < 0) return;
    let next: T | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = keys[(index + 1) % keys.length];
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = keys[(index - 1 + keys.length) % keys.length];
    else if (event.key === "Home") next = keys[0];
    else if (event.key === "End") next = keys[keys.length - 1];
    if (!next) return;
    event.preventDefault();
    activate(next, true);
  };

  return (
    <div
      id={id}
      className="cap-side"
      ref={tabsRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="vertical"
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
            onClick={() => activate(item.id)}
          >
            <TabFace item={item} />
          </button>
        );
      })}
      <span className="cap-tab-window" ref={winRef} aria-hidden="true">
        <span className="cap-tab-mirror" ref={mirrorRef}>
          {items.map((item) => (
            <button key={item.id} type="button" tabIndex={-1}>
              <TabFace item={item} />
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}
