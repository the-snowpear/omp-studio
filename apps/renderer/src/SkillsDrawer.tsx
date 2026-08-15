import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { StudioClient } from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { toDrawerItems } from "./extensibilityMap";
import {
  ICON_BY_NAME,
  countEnabledDrawerItems,
  createPreviewDrawerItems,
  drawerItemKey,
  isDrawerItemAdded,
  isDrawerItemEnabled,
  isDrawerItemError,
  itemTone,
  matchesDrawerQuery,
  withUniqueDrawerKeys,
  type DrawerCat,
  type DrawerItem,
  type SkillScope,
  type SkillTone,
} from "./skillsPreview";
import { usePreviewMode } from "./preview/PreviewContext";

type GroupKey = "workspace" | "global" | "builtin-plugin";

const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: "workspace", label: "项目" },
  { key: "global", label: "全局" },
  { key: "builtin-plugin", label: "内置与插件" },
];

const SCOPE_SHORT: Record<string, string> = {
  workspace: "PRJ",
  global: "GLB",
  builtin: "SYS",
  plugin: "PLG",
};

const SCOPE_LABEL: Record<string, string> = {
  workspace: "项目技能",
  global: "全局技能",
  builtin: "内置技能",
  plugin: "插件",
};

const HOVER_PREVIEW_MS = 420;
const HOVER_HIDE_MS = 180;
const FLY_EXIT_MS = 160;
const FILTER_SETTLE_MS = 1040;
const ADDED_REPLAY_STAY_MS = 420;
const ADDED_REPLAY_ENTER_MS = 640;
const STAGGER_MAX = 3;

type SlotPhase = "stay" | "enter" | "leave";

type FilterSlot = {
  item: DrawerItem;
  phase: SlotPhase;
  stagger: number;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function mergeVisible(prev: DrawerItem[], next: DrawerItem[]): Array<{ item: DrawerItem; phase: SlotPhase }> {
  const nextIds = new Set(next.map(drawerItemKey));
  const prevIds = new Set(prev.map(drawerItemKey));
  const result: Array<{ item: DrawerItem; phase: SlotPhase }> = [];
  let pi = 0;
  for (const item of next) {
    const id = drawerItemKey(item);
    if (prevIds.has(id)) {
      while (pi < prev.length) {
        const candidate = prev[pi];
        if (!candidate || drawerItemKey(candidate) === id) break;
        if (!nextIds.has(drawerItemKey(candidate))) {
          result.push({ item: candidate, phase: "leave" });
        }
        pi += 1;
      }
      const matched = prev[pi];
      if (matched && drawerItemKey(matched) === id) pi += 1;
      result.push({ item, phase: "stay" });
    } else {
      result.push({ item, phase: "enter" });
    }
  }
  while (pi < prev.length) {
    const leftover = prev[pi];
    if (leftover && !nextIds.has(drawerItemKey(leftover))) {
      result.push({ item: leftover, phase: "leave" });
    }
    pi += 1;
  }
  return result;
}

function assignStagger(slots: Array<{ item: DrawerItem; phase: SlotPhase }>): FilterSlot[] {
  let leaveI = 0;
  let enterI = 0;
  return slots.map((slot) => {
    if (slot.phase === "leave") {
      const stagger = Math.min(leaveI, STAGGER_MAX);
      leaveI += 1;
      return { ...slot, stagger };
    }
    if (slot.phase === "enter") {
      const stagger = Math.min(enterI, STAGGER_MAX);
      enterI += 1;
      return { ...slot, stagger };
    }
    return { ...slot, stagger: 0 };
  });
}

function staySlots(items: DrawerItem[]): FilterSlot[] {
  return items.map((item) => ({ item, phase: "stay" as const, stagger: 0 }));
}

function syncSlots(current: FilterSlot[], visible: DrawerItem[]): FilterSlot[] {
  const visById = new Map(visible.map((item) => [drawerItemKey(item), item]));
  const kept: FilterSlot[] = [];
  const keptIds = new Set<string>();
  for (const slot of current) {
    const id = drawerItemKey(slot.item);
    const nextItem = visById.get(id);
    if (nextItem) {
      kept.push({ ...slot, item: nextItem });
      keptIds.add(id);
      continue;
    }
    if (slot.phase === "leave") {
      kept.push(slot);
      keptIds.add(id);
    }
  }
  const added = visible
    .filter((item) => !keptIds.has(drawerItemKey(item)))
    .map((item) => ({ item, phase: "stay" as const, stagger: 0 }));
  return [...kept, ...added];
}

function useMotionArm(shouldAnimate: boolean): boolean {
  const [marker, setMarker] = useState(shouldAnimate);
  const [armed, setArmed] = useState(!shouldAnimate);
  if (shouldAnimate !== marker) {
    setMarker(shouldAnimate);
    setArmed(!shouldAnimate);
  }
  useLayoutEffect(() => {
    if (!shouldAnimate) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setArmed(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [shouldAnimate]);
  return armed;
}

function groupOf(item: DrawerItem): GroupKey {
  if (item.kind === "plugin" || item.scope === "builtin") return "builtin-plugin";
  return item.scope;
}

function itemScope(item: DrawerItem): SkillScope | "plugin" {
  return item.kind === "skill" ? item.scope : "plugin";
}

function itemIcon(item: DrawerItem): string {
  return ICON_BY_NAME[item.name] ?? (item.kind === "plugin" ? "plug" : "puzzle");
}

function itemDesc(item: DrawerItem): string {
  if (item.retrying) return "正在重新加载清单…";
  if (item.kind === "skill") return item.desc;
  return item.err ?? "—";
}

function itemMeta(item: DrawerItem): string {
  if (item.kind !== "plugin") return "";
  return (item.src.split("·")[0] ?? "").trim();
}

export function SkillsDrawer({
  open,
  client,
  onClose,
  onEnabledCountChange,
  onOpenHub,
}: {
  open: boolean;
  client: StudioClient;
  onClose: () => void;
  onEnabledCountChange?: (count: number) => void;
  onOpenHub?: (intent?: { tab: "skills" | "plugins"; name?: string }) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<DrawerCat>("all");
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(() => new Set());
  const { preview } = usePreviewMode();
  const [items, setItems] = useState<DrawerItem[]>(() => preview ? createPreviewDrawerItems() : []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slots, setSlots] = useState<FilterSlot[]>([]);
  const [filterEpoch, setFilterEpoch] = useState(0);
  const queryRef = useRef(query);
  const slotsRef = useRef(slots);
  const epochAppliedRef = useRef(0);
  slotsRef.current = slots;

  const refresh = useCallback(async () => {
    if (preview) {
      setItems(createPreviewDrawerItems());
      setLoadError(null);
      return;
    }
    try {
      const next = await client.query("skills.get", {});
      setItems(toDrawerItems(next));
      setLoadError(next.unavailableReason ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "skills.get failed";
      setItems([]);
      setLoadError(message);
    }
  }, [client, preview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (open && !preview) void refresh();
  }, [open, preview, refresh]);

  useEffect(() => {
    onEnabledCountChange?.(countEnabledDrawerItems(items));
  }, [items, onEnabledCountChange]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable)) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const skillN = items.filter((item) => item.kind === "skill").length;
  const pluginN = items.filter((item) => item.kind === "plugin").length;
  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (cat === "skill" && item.kind !== "skill") return false;
        if (cat === "plugin" && item.kind !== "plugin") return false;
        return matchesDrawerQuery(item, query);
      }),
    [items, cat, query],
  );

  useLayoutEffect(() => {
    const queryChanged = queryRef.current !== query;
    queryRef.current = query;

    if (queryChanged) {
      epochAppliedRef.current = filterEpoch;
      setSlots(staySlots(visible));
      return;
    }

    if (filterEpoch !== epochAppliedRef.current && filterEpoch > 0) {
      epochAppliedRef.current = filterEpoch;
      if (prefersReducedMotion()) {
        setSlots(staySlots(visible));
        return;
      }
      const prev = slotsRef.current.map((slot) => slot.item);
      setSlots(assignStagger(mergeVisible(prev, visible)));
      return;
    }

    setSlots((current) => syncSlots(current, visible));
  }, [visible, query, filterEpoch]);

  useEffect(() => {
    if (filterEpoch === 0) return;
    const timer = window.setTimeout(() => {
      setSlots((current) => {
        if (!current.some((slot) => slot.phase === "leave" || slot.phase === "enter")) return current;
        return current
          .filter((slot) => slot.phase !== "leave")
          .map((slot) => ({ ...slot, phase: "stay" as const, stagger: 0 }));
      });
    }, FILTER_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [filterEpoch]);

  const grouped = GROUPS.map((group) => ({
    ...group,
    entries: slots.filter((slot) => groupOf(slot.item) === group.key),
  })).filter((group) => group.entries.length > 0);

  const patchItem = (target: DrawerItem, patch: Partial<DrawerItem>) => {
    const id = drawerItemKey(target);
    setItems((current) =>
      current.map((item) => (drawerItemKey(item) === id ? ({ ...item, ...patch } as DrawerItem) : item)),
    );
  };

  const retryItem = (item: DrawerItem) => {
    if (!preview || item.retrying) return;
    patchItem(item, { retrying: true });
    window.setTimeout(() => {
      patchItem(item, { retrying: false });
    }, 1600);
  };

  const toggleItem = (item: DrawerItem) => {
    if (item.kind === "skill") {
      patchItem(item, { session: !item.session });
      return;
    }
    if (!preview) return;
    patchItem(item, { enabled: !isDrawerItemEnabled(item) });
  };

  const primaryItem = (item: DrawerItem) => {
    if (isDrawerItemError(item)) {
      retryItem(item);
      return;
    }
    if (item.kind === "plugin") return;
    toggleItem(item);
  };

  const toggleGroup = (key: GroupKey) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside
      className={`sb-drawer-mask${open ? " open" : ""}`}
      id="skillsDrawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="sdTitle"
      aria-hidden={!open}
      hidden={!open}
    >
      <div className="sd-head">
        <div className="sd-title" id="sdTitle">
          <Icon name="layers" extra="sm" />
          技能 & 插件
          <span className="count">{items.length}</span>
        </div>
        <span className="spacer" />
        <button
          className="icon-btn small"
          data-tip="打开能力中心"
          aria-label="打开能力中心"
          type="button"
          onClick={() => onOpenHub?.()}
        >
          <Icon name="external" extra="sm" />
        </button>
        <button className="icon-btn small" data-tip="关闭 (Esc)" aria-label="关闭技能面板" onClick={onClose}>
          <Icon name="x" extra="sm" />
        </button>
      </div>
      <label className="sd-search">
        <Icon name="search" extra="sm" />
        <input
          ref={searchRef}
          id="sdSearchInput"
          type="text"
          value={query}
          placeholder="搜索技能 / 插件…"
          aria-label="在技能与插件中搜索"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="kbd">/</span>
      </label>
      <nav className="sd-tabs" role="tablist" aria-label="技能分类">
        {([
          ["all", "全部", items.length],
          ["skill", "技能", skillN],
          ["plugin", "插件", pluginN],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            className={`sd-tab${cat === key ? " active" : ""}`}
            role="tab"
            aria-selected={cat === key}
            data-cat={key}
            type="button"
            onClick={() => {
              if (key === cat) return;
              setCat(key);
              setFilterEpoch((epoch) => epoch + 1);
            }}
          >
            {label} <span className="count">{count}</span>
          </button>
        ))}
      </nav>
      <div className="sd-body" id="sdBody" tabIndex={-1}>
        {grouped.length === 0 ? (
          <div className="sd-empty">
            <Icon name="search" extra="lg" />
            {preview
              ? "没有匹配的技能或插件"
              : loadError
                ? loadError
                : items.length === 0
                  ? "未发现已配置的技能 / 插件"
                  : "没有匹配的技能或插件"}
            <br />
            {preview
              ? "试试换个关键词，或在「能力中心」浏览全部"
              : loadError
                ? "Host 未能读取本机 OMP 配置目录"
                : "已扫描本机的 OMP 兼容目录与已安装插件"}
          </div>
        ) : (
          grouped.map((group) => {
            const expanded = !collapsed.has(group.key);
            const leaving = group.entries.length > 0 && group.entries.every((slot) => slot.phase === "leave");
            const entering = group.entries.length > 0 && group.entries.every((slot) => slot.phase === "enter");
            const shownCount = group.entries.filter((slot) => slot.phase !== "leave").length;
            const keys = withUniqueDrawerKeys(group.entries.map((entry) => entry.item));
            const keyedEntries = group.entries.map((slot, index) => ({
              slot,
              key: keys[index]?.key ?? drawerItemKey(slot.item),
            }));
            return (
              <SkillGroup
                key={group.key}
                label={group.label}
                groupKey={group.key}
                expanded={expanded}
                leaving={leaving}
                entering={entering}
                count={shownCount}
                onToggle={() => toggleGroup(group.key)}
              >
                {expanded
                  ? keyedEntries.map(({ slot, key }) => (
                      <SkillSlot
                        key={key}
                        phase={slot.phase}
                        stagger={slot.stagger}
                      >
                        <SkillCard
                          item={slot.item}
                          drawerOpen={open}
                          filterEpoch={filterEpoch}
                          phase={slot.phase}
                          onPrimary={() => primaryItem(slot.item)}
                          onToggle={() => (isDrawerItemError(slot.item) ? retryItem(slot.item) : toggleItem(slot.item))}
                          onOpenHub={() => onOpenHub?.({ tab: slot.item.kind === "plugin" ? "plugins" : "skills", name: slot.item.name })}
                        />
                      </SkillSlot>
                    ))
                  : null}
              </SkillGroup>
            );
          })
        )}
      </div>
      <div className="sd-foot">
        <a
          className="sd-foot-link"
          href="#!capabilities"
          aria-label="进入能力中心（管理全部技能与插件）"
          onClick={(event) => {
            event.preventDefault();
            onOpenHub?.();
          }}
        >
          <Icon name="package" />
          <span className="label">进入能力中心</span>
        </a>
      </div>
    </aside>
  );
}

function SkillGroup({
  label,
  groupKey,
  expanded,
  leaving,
  entering,
  count,
  onToggle,
  children,
}: {
  label: string;
  groupKey: GroupKey;
  expanded: boolean;
  leaving: boolean;
  entering: boolean;
  count: number;
  onToggle: () => void;
  children: ReactNode;
}) {
  const leaveArmed = useMotionArm(leaving);
  const enterArmed = useMotionArm(entering);

  const cls = ["sk-group"];
  if (!expanded) cls.push("is-collapsed");
  if (leaving && leaveArmed) cls.push("is-leave");
  if (entering) cls.push("is-enter");
  if (entering && enterArmed) cls.push("is-in");

  return (
    <section className={cls.join(" ")} aria-label={label}>
      <button
        className="sk-group-head"
        type="button"
        aria-expanded={expanded}
        data-scope={groupKey}
        onClick={onToggle}
      >
        <span className="sk-group-chevron">
          <Icon name="chevron-r" extra="sm" />
        </span>
        <span className="sk-group-label">{label}</span>
        <span className="sk-group-count">{count}</span>
        <span className="sk-group-rule" />
      </button>
      {children ? <div className="sk-group-items">{children}</div> : null}
    </section>
  );
}

function SkillSlot({
  phase,
  stagger,
  children,
}: {
  phase: SlotPhase;
  stagger: number;
  children: ReactNode;
}) {
  const armed = useMotionArm(phase !== "stay");

  const cls = ["sk-slot"];
  if (phase === "leave" && armed) cls.push("is-leave");
  if (phase === "enter") cls.push("is-enter");
  if (phase === "enter" && armed) cls.push("is-in");

  return (
    <div className={cls.join(" ")} style={{ "--sk-stagger": stagger } as CSSProperties}>
      <div className="sk-slot-clip">{children}</div>
    </div>
  );
}

function SkillCard({
  item,
  drawerOpen,
  filterEpoch,
  phase,
  onPrimary,
  onToggle,
  onOpenHub,
}: {
  item: DrawerItem;
  drawerOpen: boolean;
  filterEpoch: number;
  phase: SlotPhase;
  onPrimary: () => void;
  onToggle: () => void;
  onOpenHub?: () => void;
}) {
  const err = isDrawerItemError(item);
  const added = isDrawerItemAdded(item);
  const retrying = Boolean(item.retrying);
  const scope = itemScope(item);
  const tone = itemTone(item);
  const desc = itemDesc(item);
  const meta = itemMeta(item);
  const epochRef = useRef(filterEpoch);
  const [addedPaint, setAddedPaint] = useState(() => {
    if (filterEpoch === 0 || phase === "leave" || !added) return added;
    if (typeof window !== "undefined" && prefersReducedMotion()) return added;
    return false;
  });
  const cls = ["sk-card"];
  if (addedPaint) cls.push("is-added");
  if (err) cls.push("has-error");
  if (retrying) cls.push("is-retrying");
  const flyId = `sk-fly-${drawerItemKey(item).replaceAll(":", "-")}`;
  const cardRef = useRef<HTMLElement>(null);
  const showTimerRef = useRef(0);
  const hideTimerRef = useRef(0);
  const exitTimerRef = useRef(0);
  const insideRef = useRef({ card: false, fly: false });
  const suppressRef = useRef(false);
  const [flyRect, setFlyRect] = useState<DOMRect | null>(null);
  const [flyOpen, setFlyOpen] = useState(false);

  const hideFly = (immediate = false) => {
    window.clearTimeout(showTimerRef.current);
    window.clearTimeout(hideTimerRef.current);
    window.clearTimeout(exitTimerRef.current);
    if (immediate) {
      setFlyOpen(false);
      setFlyRect(null);
      return;
    }
    setFlyOpen(false);
    exitTimerRef.current = window.setTimeout(() => setFlyRect(null), FLY_EXIT_MS);
  };

  const scheduleHide = () => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!insideRef.current.card && !insideRef.current.fly) hideFly();
    }, HOVER_HIDE_MS);
  };

  useEffect(() => {
    if (!drawerOpen) hideFly(true);
  }, [drawerOpen]);

  useEffect(() => {
    if (filterEpoch > 0) hideFly(true);
  }, [filterEpoch]);

  useEffect(() => {
    if (!added || phase === "leave") {
      epochRef.current = filterEpoch;
      setAddedPaint(Boolean(added && phase !== "leave"));
      return;
    }
    if (filterEpoch === 0 || prefersReducedMotion()) {
      epochRef.current = filterEpoch;
      setAddedPaint(true);
      return;
    }
    const epochChanged = epochRef.current !== filterEpoch;
    epochRef.current = filterEpoch;
    const shouldReplay = epochChanged || phase === "enter";
    if (!shouldReplay) {
      setAddedPaint(true);
      return;
    }
    if (phase === "enter") setAddedPaint(false);
    let first = 0;
    let second = 0;
    const timer = window.setTimeout(() => {
      setAddedPaint(false);
      first = window.requestAnimationFrame(() => {
        second = window.requestAnimationFrame(() => setAddedPaint(true));
      });
    }, phase === "enter" ? ADDED_REPLAY_ENTER_MS : ADDED_REPLAY_STAY_MS);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [filterEpoch, added, phase]);

  const onHitEnter = () => {
    if (suppressRef.current) return;
    window.clearTimeout(showTimerRef.current);
    window.clearTimeout(hideTimerRef.current);
    window.clearTimeout(exitTimerRef.current);
    const reveal = () => {
      const rect = cardRef.current?.getBoundingClientRect();
      if (!rect) return;
      setFlyRect(rect);
      setFlyOpen(true);
    };
    if (flyRect) {
      reveal();
      return;
    }
    showTimerRef.current = window.setTimeout(reveal, HOVER_PREVIEW_MS);
  };

  const onHitLeave = () => {
    window.clearTimeout(showTimerRef.current);
  };

  const onCardEnter = () => {
    insideRef.current.card = true;
    window.clearTimeout(hideTimerRef.current);
    window.clearTimeout(exitTimerRef.current);
    if (flyRect) setFlyOpen(true);
  };

  const onCardLeave = () => {
    insideRef.current.card = false;
    suppressRef.current = false;
    scheduleHide();
  };

  const onFlyEnter = () => {
    insideRef.current.fly = true;
    window.clearTimeout(hideTimerRef.current);
  };

  const onFlyLeave = () => {
    insideRef.current.fly = false;
    scheduleHide();
  };

  useEffect(() => () => {
    window.clearTimeout(showTimerRef.current);
    window.clearTimeout(hideTimerRef.current);
    window.clearTimeout(exitTimerRef.current);
  }, []);

  useEffect(() => {
    if (!flyRect) return;
    const onScroll = () => hideFly(true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [flyRect]);

  return (
    <article
      ref={cardRef}
      className={cls.join(" ")}
      data-name={item.name}
      data-tone={tone}
      role="option"
      aria-selected={added}
      aria-describedby={flyOpen ? flyId : undefined}
      tabIndex={0}
      onPointerEnter={onCardEnter}
      onPointerLeave={onCardLeave}
      onClick={(event) => {
        suppressRef.current = true;
        hideFly();
        onPrimary();
        if (event.detail > 0) event.currentTarget.blur();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPrimary();
        }
      }}
    >
      <div
        className="sk-preview-hit"
        onPointerEnter={onHitEnter}
        onPointerLeave={onHitLeave}
      >
        <span className={`sk-icon${item.kind === "plugin" ? " sk-icon-plugin" : ""}`}>
          <Icon name={retrying ? "refresh" : itemIcon(item)} extra="sm" />
          {err && !retrying ? <span className="sk-error-mark" /> : (
            <span className="sk-added-mark" aria-hidden="true">
              <Icon name="check" extra="sm" />
            </span>
          )}
        </span>
        <div className="sk-content">
          <div className="sk-row1">
            <span className="sk-name">{item.name}</span>
            <span className={`sk-scope sk-scope-${scope}`}>{SCOPE_SHORT[scope]}</span>
            {item.kind === "skill" && item.src ? <span className="chip outline xs">{item.src}</span> : null}
            {item.kind === "plugin" ? (
              <span className="sk-external">
                <Icon name="external" extra="sm" />
              </span>
            ) : null}
          </div>
          <div className="sk-desc">
            {err && !retrying ? <Icon name="alert" extra="sm" /> : null}
            {desc || "—"}
          </div>
        </div>
      </div>
      <div className="sk-action-zone">
        <div className="sk-actions">
          {retrying ? <span className="sk-persistent">重试中…</span> : null}
          {err ? (
            !retrying ? (
              <button
                className="add-btn hover-action retry-hover"
                type="button"
                aria-label={`重试加载 ${item.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle();
                  event.currentTarget.blur();
                }}
              >
                <Icon name="refresh" extra="sm" />
                重试
              </button>
            ) : null
          ) : !retrying && added ? (
            <button
              className="add-btn hover-action"
              type="button"
              aria-label={`从当前对话移除 ${item.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
                event.currentTarget.blur();
              }}
            >
              <Icon name="x" extra="sm" />
              移出
            </button>
          ) : !retrying ? (
            <button
              className="add-btn hover-action"
              type="button"
              aria-label={`把 ${item.name} 加入当前对话`}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
                event.currentTarget.blur();
              }}
            >
              <Icon name="plus" extra="sm" />
              加入
            </button>
          ) : null}
          <button
            className="icon-btn open-hub"
            aria-label={`打开能力中心查看 ${item.name}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenHub?.();
              event.currentTarget.blur();
            }}
          >
            <Icon name="more" />
          </button>
          {!retrying && !added && !err && meta ? <span className="sk-meta">{meta}</span> : null}
        </div>
      </div>
      {flyRect
        ? createPortal(
            <SkillFlyout
              id={flyId}
              item={item}
              tone={tone}
              scope={scope}
              desc={desc}
              err={err}
              open={flyOpen}
              cardRect={flyRect}
              onPointerEnter={onFlyEnter}
              onPointerLeave={onFlyLeave}
            />,
            document.body,
          )
        : null}
    </article>
  );
}

function SkillFlyout({
  id,
  item,
  tone,
  scope,
  desc,
  err,
  open,
  cardRect,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  item: DrawerItem;
  tone: SkillTone;
  scope: SkillScope | "plugin";
  desc: string;
  err: boolean;
  open: boolean;
  cardRect: DOMRect;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: "right" | "left" }>({
    top: cardRect.top,
    left: cardRect.right + 12,
    side: "right",
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fly = el.getBoundingClientRect();
    let side: "right" | "left" = "right";
    let left = cardRect.right + 12;
    if (left + fly.width > window.innerWidth - 8) {
      left = Math.max(8, cardRect.left - fly.width - 12);
      side = "left";
    }
    let top = cardRect.top;
    if (top + fly.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - fly.height - 8);
    }
    setPos({ top, left, side });
  }, [cardRect]);

  useLayoutEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      id={id}
      className={`sk-fly${err ? " has-error" : ""}${entered ? " is-open" : ""}`}
      data-tone={tone}
      data-side={pos.side}
      role="tooltip"
      style={{ top: pos.top, left: pos.left }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <span className="sk-fly-bridge" aria-hidden="true" />
      <span className="sk-fly-arrow" aria-hidden="true" />
      <div className="sk-fly-kicker">
        <span className={`sk-icon${item.kind === "plugin" ? " sk-icon-plugin" : ""}`}>
          <Icon name={itemIcon(item)} extra="sm" />
        </span>
        {SCOPE_LABEL[scope] ?? "技能"}
        {item.kind === "skill" && item.src ? <span className="chip outline xs">{item.src}</span> : null}
      </div>
      <div className="sk-fly-name">{item.name}</div>
      <div className="sk-fly-rule" aria-hidden="true" />
      <div className="sk-fly-desc">{desc || "暂无简介"}</div>
    </div>
  );
}
