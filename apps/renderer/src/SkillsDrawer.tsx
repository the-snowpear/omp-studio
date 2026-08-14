import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { toDrawerItems } from "./extensibilityMap";
import {
  ICON_BY_NAME,
  countEnabledDrawerItems,
  createPreviewDrawerItems,
  isDrawerItemAdded,
  isDrawerItemEnabled,
  isDrawerItemError,
  matchesDrawerQuery,
  type DrawerCat,
  type DrawerItem,
  type SkillScope,
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

const SCOPE_COLOR: Record<string, string> = {
  workspace: "purple",
  global: "green",
  builtin: "gray",
  plugin: "amber",
};

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

  const grouped = GROUPS.map((group) => ({
    ...group,
    entries: visible.filter((item) => groupOf(item) === group.key),
  })).filter((group) => group.entries.length > 0);

  const patchItem = (name: string, patch: Partial<DrawerItem>) => {
    setItems((current) =>
      current.map((item) => (item.name === name ? ({ ...item, ...patch } as DrawerItem) : item)),
    );
  };

  const retryItem = (item: DrawerItem) => {
    if (!preview || item.retrying) return;
    patchItem(item.name, { retrying: true });
    window.setTimeout(() => {
      patchItem(item.name, { retrying: false });
    }, 1600);
  };

  const toggleItem = (item: DrawerItem) => {
    if (item.kind === "skill") {
      patchItem(item.name, { session: !item.session });
      return;
    }
    if (!preview) return;
    patchItem(item.name, { enabled: !isDrawerItemEnabled(item) });
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
            onClick={() => setCat(key)}
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
                : "已扫描 OMP 兼容目录与已安装插件（configured 库存）"}
          </div>
        ) : (
          grouped.map((group) => {
            const expanded = !collapsed.has(group.key);
            return (
              <section
                key={group.key}
                className={`sk-group${expanded ? "" : " is-collapsed"}`}
                aria-label={group.label}
              >
                <button
                  className="sk-group-head"
                  type="button"
                  aria-expanded={expanded}
                  data-scope={group.key}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span className="sk-group-chevron">
                    <Icon name="chevron-r" extra="sm" />
                  </span>
                  <span className="sk-group-label">{group.label}</span>
                  <span className="sk-group-count">{group.entries.length}</span>
                  <span className="sk-group-rule" />
                </button>
                {expanded ? (
                  <div className="sk-group-items">
                    {group.entries.map((item) => (
                      <SkillCard
                        key={item.name}
                        item={item}
                        onPrimary={() => primaryItem(item)}
                        onToggle={() => (isDrawerItemError(item) ? retryItem(item) : toggleItem(item))}
                        onOpenHub={() => onOpenHub?.({ tab: item.kind === "plugin" ? "plugins" : "skills", name: item.name })}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
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

function SkillCard({
  item,
  onPrimary,
  onToggle,
  onOpenHub,
}: {
  item: DrawerItem;
  onPrimary: () => void;
  onToggle: () => void;
  onOpenHub?: () => void;
}) {
  const err = isDrawerItemError(item);
  const added = isDrawerItemAdded(item);
  const retrying = Boolean(item.retrying);
  const scope = itemScope(item);
  const color = err ? "red" : SCOPE_COLOR[scope] ?? "gray";
  const desc = itemDesc(item);
  const meta = itemMeta(item);
  const cls = ["sk-card"];
  if (added) cls.push("is-added");
  if (err) cls.push("has-error");
  if (retrying) cls.push("is-retrying");

  return (
    <article
      className={cls.join(" ")}
      data-name={item.name}
      role="option"
      aria-selected={added}
      tabIndex={0}
      onClick={(event) => {
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
      <span className={`sk-icon ${color}${item.kind === "plugin" ? " sk-icon-plugin" : ""}`}>
        <Icon name={retrying ? "refresh" : itemIcon(item)} extra="sm" />
        {added ? (
          <span className="sk-added-mark">
            <Icon name="check" extra="sm" />
          </span>
        ) : null}
        {err && !retrying ? <span className="sk-error-mark" /> : null}
      </span>
      <div className="sk-content">
        <div className="sk-row1">
          <span className="sk-name" title={item.name}>
            {item.name}
          </span>
          <span className={`sk-scope sk-scope-${scope}`}>{SCOPE_SHORT[scope]}</span>
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
            data-tip="打开能力中心"
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
    </article>
  );
}
