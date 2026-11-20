import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { StudioClient } from "@omp-studio/client-contract";
import type { NativePlanReview, PlanExecutionTier } from "@omp-studio/studio-protocol";
import { surfaceWindow, useSurfaceDocument } from "../dock/SurfaceContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "../icons";
import { ProviderGlyph, ROLE_ICONS, ROLE_TINTS } from "../models/modelPresentation";
import { MODEL_THINKING } from "../preview/modelConfigFixtures";
import "./planExecution.css";

const ROLE_LABELS_ZH: Readonly<Record<string, string>> = {
  default: "默认",
  smol: "快速",
  slow: "深思",
  plan: "架构",
  vision: "视觉",
  designer: "设计",
  commit: "提交",
  tiny: "轻量",
  task: "子任务",
  advisor: "顾问",
  memory: "记忆",
  web: "联网",
  judge: "评估",
  widget: "组件",
};

const ROLE_LABELS_EN: Readonly<Record<string, string>> = {
  default: "Default",
  smol: "Fast",
  slow: "Thinking",
  plan: "Architect",
  vision: "Vision",
  designer: "Designer",
  commit: "Commit",
  tiny: "Tiny",
  task: "Subtask",
  advisor: "Advisor",
  memory: "Memory",
  web: "Web",
  judge: "Judge",
  widget: "Widget",
};

function resolveRoleMeta(roleId: string, zh: boolean): { label: string; icon: IconName; tint: string } {
  const label = (zh ? ROLE_LABELS_ZH[roleId] : ROLE_LABELS_EN[roleId]) ?? roleId;
  return {
    label,
    icon: ROLE_ICONS[roleId] ?? "cpu",
    tint: ROLE_TINTS[roleId] ?? "purple",
  };
}

function formatThinkingLevel(level: string | undefined): string | undefined {
  if (!level || level === "off") return undefined;
  return MODEL_THINKING.find((item) => item.id === level)?.label ?? level;
}

export function useNativePlanReview(
  client: StudioClient,
  sessionId: string | undefined,
  enabled: boolean,
  active: boolean,
  stateVersion: number | undefined,
) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [details, setDetails] = useState<NativePlanReview>();
  const [role, setRole] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [errorCause, setErrorCause] = useState<unknown>(undefined);
  const previousReview = useRef<string | undefined>(undefined);
  const activeSession = useRef<string | undefined>(undefined);
  const settledSession = useRef<string | undefined>(undefined);
  useEffect(() => {
    let current = true;
    if (!enabled || !active || !sessionId) {
      activeSession.current = undefined;
      settledSession.current = undefined;
      previousReview.current = undefined;
      setDetails(undefined);
      setRole("");
      setLoading(false);
      setReady(false);
      setErrorCause(undefined);
      return;
    }
    if (activeSession.current !== sessionId) {
      activeSession.current = sessionId;
      settledSession.current = undefined;
      previousReview.current = undefined;
      setDetails(undefined);
      setRole("");
      setReady(false);
      setErrorCause(undefined);
    }
    const initialLoad = settledSession.current !== sessionId;
    if (initialLoad) {
      setLoading(true);
      setErrorCause(undefined);
    }
    void (async () => {
      const handle = await client.command("mode.plan.review.details", { sessionId, ...(role ? { role } : {}) });
      const result = (await waitReceipt<{ result: NativePlanReview }>(client, handle.requestId)).result;
      if (!current) return;
      settledSession.current = sessionId;
      setReady(true);
      setErrorCause(undefined);
      setDetails(result);
      const reviewKey = result.reviewId ?? "";
      const sameReview = previousReview.current === reviewKey;
      const defaultRole = result.selectedRole && result.tiers.some((tier) => tier.role === result.selectedRole)
        ? result.selectedRole
        : "";
      setRole((value) => {
        if (!sameReview) return defaultRole;
        if (value === "") return defaultRole;
        return result.tiers.some((tier) => tier.role === value) ? value : defaultRole;
      });
      previousReview.current = reviewKey;
    })()
      .catch((cause) => {
        if (current) {
          settledSession.current = sessionId;
          setReady(true);
          if (initialLoad) setDetails(undefined);
          setErrorCause(cause);
        }
      })
      .finally(() => {
        if (current && initialLoad) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, sessionId, enabled, active, stateVersion, role]);
  const error = errorCause !== undefined
    ? hostErrorMessage(errorCause, zh ? "无法读取计划执行档位" : "Cannot read plan execution tiers")
    : "";
  return { details, role, setRole, loading, ready, error };
}

export function PlanExecutionPicker({
  details,
  role,
  onChange,
  disabled,
  loading,
  error,
}: {
  details?: NativePlanReview | undefined;
  role: string;
  onChange(role: string): void;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
}) {
  const document = useSurfaceDocument();
  const window = surfaceWindow(document);
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const uid = useId();
  const triggerId = `${uid}-trigger`;
  const listId = `${uid}-list`;
  const labelId = `${uid}-label`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const tiers = details?.tiers ?? [];
  const selectedTier = role ? tiers.find((item) => item.role === role) : undefined;
  const controlDisabled = Boolean(disabled || loading || !details?.available || tiers.length === 0);
  const searchable = tiers.length > 8;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeRole, setActiveRole] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0, width: 320, maxHeight: 320, above: true });

  const needle = query.trim().toLocaleLowerCase();
  const visibleTiers = useMemo(
    () => tiers.filter((item) => {
      if (!needle) return true;
      const meta = resolveRoleMeta(item.role, zh);
      return `${item.role} ${meta.label} ${item.name} ${item.provider} ${item.model} ${item.thinkingLevel ?? ""}`
        .toLocaleLowerCase()
        .includes(needle);
    }),
    [needle, tiers, zh],
  );

  const activeTier = visibleTiers.find((item) => item.role === activeRole) ?? visibleTiers[0];
  const optionId = (roleKey: string) => `${uid}-opt-${roleKey}`;

  const dismiss = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const choose = useCallback((item: PlanExecutionTier) => {
    dismiss(true);
    if (item.role !== role) onChange(item.role);
  }, [dismiss, onChange, role]);

  const expand = useCallback((last = false) => {
    if (controlDisabled) return;
    setQuery("");
    const fallback = last ? tiers.at(-1)?.role : tiers[0]?.role;
    setActiveRole(selectedTier?.role ?? fallback ?? "");
    setOpen(true);
  }, [controlDisabled, selectedTier?.role, tiers]);

  const place = useCallback(() => {
    const button = triggerRef.current;
    const menu = popupRef.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const maxAllowedWidth = Math.max(240, window.innerWidth - 24);
    const width = Math.min(Math.max(rect.width, 336), Math.min(420, maxAllowedWidth));
    const searchEl = searchRef.current?.parentElement;
    const headHeight = (menu.querySelector<HTMLElement>(".plan-exec-pop-head")?.offsetHeight ?? 0)
      + (searchEl ? searchEl.offsetHeight + 6 : 0);
    const chromeHeight = headHeight + 14;
    const listScrollHeight = listRef.current?.scrollHeight ?? 0;
    const desired = Math.min(listScrollHeight + chromeHeight, 340);
    const above = rect.top - 14;
    const below = window.innerHeight - rect.bottom - 14;
    // Prefer opening upward so the bottom approval action bar stays unobstructed.
    const openAbove = above >= desired || above >= below;
    const availableHeight = Math.max(96, Math.min(340, openAbove ? above : below));
    const nextMaxHeight = Math.max(60, availableHeight - chromeHeight);
    const actualListHeight = listScrollHeight > 0
      ? Math.min(listScrollHeight, nextMaxHeight)
      : (listRef.current?.offsetHeight ?? 0);
    const actualHeight = Math.max(
      listScrollHeight === 0 ? menu.offsetHeight : 0,
      chromeHeight + actualListHeight,
    );
    const preferredLeft = rect.right - width >= 12 ? rect.right - width : rect.left;
    const nextTop = openAbove ? Math.max(12, rect.top - actualHeight - 6) : rect.bottom + 6;
    const nextLeft = Math.max(12, Math.min(preferredLeft, window.innerWidth - width - 12));
    setPosition((prev) => (
      prev.top === nextTop
      && prev.left === nextLeft
      && prev.width === width
      && prev.maxHeight === nextMaxHeight
      && prev.above === openAbove
        ? prev
        : {
            top: nextTop,
            left: nextLeft,
            width,
            maxHeight: nextMaxHeight,
            above: openAbove,
          }
    ));
  }, [window]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, query, visibleTiers.length, place]);

  useLayoutEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  useLayoutEffect(() => {
    if (open && activeTier) {
      document.getElementById(optionId(activeTier.role))?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, activeTier?.role, document]);

  useEffect(() => {
    if (!open) return;
    let rafId: number | undefined;
    const schedulePlace = () => {
      if (rafId !== undefined) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = undefined;
        place();
      });
    };
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        dismiss(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss(true);
    };
    const reposition = (event: Event) => {
      if (event.target instanceof window.Node && popupRef.current?.contains(event.target)) return;
      schedulePlace();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", onEscape, true);
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("scroll", reposition, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedulePlace);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => {
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("resize", schedulePlace);
      window.removeEventListener("scroll", reposition, true);
      observer?.disconnect();
    };
  }, [dismiss, document, open, place, window]);

  useEffect(() => {
    if (controlDisabled && open) dismiss(false);
  }, [controlDisabled, dismiss, open]);

  const handleKeys = (event: ReactKeyboardEvent<HTMLElement>, inSearch = false) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Tab" && open) {
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
      if (!open) {
        expand(event.key === "ArrowUp" || event.key === "End");
        return;
      }
      if (visibleTiers.length === 0) return;
      const currentIndex = visibleTiers.findIndex((item) => item.role === activeTier?.role);
      const next = event.key === "Home"
        ? visibleTiers[0]
        : event.key === "End"
          ? visibleTiers.at(-1)
          : visibleTiers[(currentIndex + (event.key === "ArrowUp" ? -1 : 1) + visibleTiers.length) % visibleTiers.length];
      if (next) setActiveRole(next.role);
      return;
    }
    if (event.key === "Enter" || (event.key === " " && !inSearch)) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) expand();
      else if (activeTier) choose(activeTier);
    }
  };

  const selectedMeta = selectedTier ? resolveRoleMeta(selectedTier.role, zh) : undefined;
  const selectedThinking = formatThinkingLevel(selectedTier?.thinkingLevel);
  const fallbackLabel = loading
    ? (zh ? "正在读取执行模型…" : "Loading execution models…")
    : (zh ? "使用当前会话模型" : "Keep session model");

  return (
    <div className="plan-execution">
      <div className="plan-exec-info">
        <span className="plan-exec-kicker-ic" aria-hidden="true">
          <Icon name="play" extra="sm" />
        </span>
        <div className="plan-exec-copy">
          <span id={labelId} className="plan-exec-title">
            {zh ? "执行模型" : "Execution model"}
          </span>
          <span className="plan-exec-sub">
            {zh ? "批准计划后切换至此档位执行" : "Used to execute the plan upon approval"}
          </span>
        </div>
      </div>

      <div className="plan-exec-control">
        {error ? (
          <span role="alert" className="plan-exec-error">
            <Icon name="alert-c" extra="sm" />
            <span>{error}</span>
          </span>
        ) : null}

        <button
          id={triggerId}
          ref={triggerRef}
          type="button"
          role="combobox"
          className={`plan-exec-trigger${open ? " is-open" : ""}`}
          disabled={controlDisabled}
          aria-labelledby={labelId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && activeTier ? optionId(activeTier.role) : undefined}
          onKeyDown={(event) => handleKeys(event)}
          onClick={() => {
            triggerRef.current?.focus();
            if (open) dismiss();
            else expand();
          }}
        >
          <span
            className="plan-exec-role-ic"
            data-tint={selectedMeta?.tint ?? "gray"}
            aria-hidden="true"
          >
            <Icon name={selectedMeta?.icon ?? (loading ? "refresh" : "link")} extra="sm" />
          </span>

          {selectedTier && selectedMeta ? (
            <span className="plan-exec-summary">
              <span className="plan-exec-primary">
                <span className="plan-exec-model">{selectedTier.name}{selectedTier.contextWindow ? ` · ${Math.round(selectedTier.contextWindow / 1000)}k` : ""}</span>
                <span className="plan-exec-role-pill" data-tint={selectedMeta.tint}>
                  {selectedMeta.label}
                </span>
                {details?.contextRatio !== undefined && <small>{zh ? "上下文" : "Context"} {Math.round(details.contextRatio * 100)}%</small>}
                {selectedThinking ? (
                  <span className="plan-exec-think-pill">
                    <Icon name="brain" extra="sm" />
                    <span>{selectedThinking}</span>
                  </span>
                ) : null}
              </span>
              <span className="plan-exec-meta">
                <span className="plan-exec-provider-ic" aria-hidden="true">
                  <ProviderGlyph id={selectedTier.provider} />
                </span>
                <span className="plan-exec-route">
                  {selectedTier.provider}/{selectedTier.model}
                </span>
              </span>
            </span>
          ) : (
            <span className="plan-exec-summary is-empty">
              <span className="plan-exec-model">{fallbackLabel}</span>
            </span>
          )}

          <Icon name="chevron-d" extra="sm plan-exec-chevron" />
        </button>
      </div>

      {open && !controlDisabled && document.body ? createPortal(
        <div
          ref={popupRef}
          className="plan-exec-popover"
          data-side={position.above ? "top" : "bottom"}
          style={{ top: position.top, left: position.left, width: position.width }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="plan-exec-pop-head">
            <span>{zh ? "选择执行档位" : "Select execution tier"}</span>
            <span className="plan-exec-pop-count">{tiers.length}</span>
          </div>
          {searchable ? (
            <div className="plan-exec-search">
              <Icon name="search" extra="sm" />
              <input
                ref={searchRef}
                type="search"
                role="searchbox"
                value={query}
                aria-label={zh ? "搜索执行模型" : "Search execution models"}
                placeholder={zh ? "搜索角色或模型…" : "Search role or model…"}
                aria-controls={listId}
                aria-activedescendant={activeTier ? optionId(activeTier.role) : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveRole("");
                }}
                onKeyDown={(event) => handleKeys(event, true)}
              />
            </div>
          ) : null}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={zh ? "计划执行模型" : "Plan execution model"}
            className="plan-exec-list"
            style={{ maxHeight: position.maxHeight }}
          >
            {visibleTiers.length > 0 ? visibleTiers.map((item) => {
              const meta = resolveRoleMeta(item.role, zh);
              const think = formatThinkingLevel(item.thinkingLevel);
              const isSelected = item.role === selectedTier?.role;
              const isActive = item.role === activeTier?.role;
              return (
                <button
                  key={item.role}
                  id={optionId(item.role)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  className={`plan-exec-option${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => setActiveRole(item.role)}
                  onClick={() => choose(item)}
                >
                  <span className="plan-exec-role-ic is-lg" data-tint={meta.tint} aria-hidden="true">
                    <Icon name={meta.icon} extra="sm" />
                  </span>
                  <span className="plan-exec-opt-body">
                    <span className="plan-exec-opt-top">
                      <b className="plan-exec-opt-name">{item.name}</b>
                      <span className="plan-exec-role-pill" data-tint={meta.tint}>{meta.label}</span>
                      <span className="plan-exec-alias">@{item.role}</span>
                    </span>
                    <span className="plan-exec-opt-sub">
                      <span className="plan-exec-provider-ic" aria-hidden="true">
                        <ProviderGlyph id={item.provider} />
                      </span>
                      <span className="plan-exec-route">{item.provider}/{item.model}</span>
                    </span>
                  </span>
                  <span className="plan-exec-opt-end">
                    {think ? (
                      <span className="plan-exec-think-pill">
                        <Icon name="brain" extra="sm" />
                        <span>{think}</span>
                      </span>
                    ) : null}
                    <span className="plan-exec-check" aria-hidden="true">
                      {isSelected ? <Icon name="check" extra="sm" /> : null}
                    </span>
                  </span>
                </button>
              );
            }) : (
              <div className="plan-exec-empty" role="status">
                {zh ? "没有匹配的执行模型" : "No matching execution models"}
              </div>
            )}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
