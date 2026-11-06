/**
 * Composer 加号：宽栏保留快捷入口，窄栏将输入功能与模式收进分类菜单。
 * 分类在同一个向上弹窗内逐级展开，避免窄窗口横向飞出。
 *
 * 层 1 会话模式单选（Plan / Goal / Vibe）。
 * 层 2 magic keyword 单选（Ultrathink / Orchestrate / Workflowz）——粘性，发送时注入正文。
 * 层 3 Loop / Fast / Prewalk 多选，侧边二级弹窗（同「更多模型」）。
 *
 * 预览开：层 1/3 纯本地演示，不调 Host。预览关：跟 snapshot / capability；
 * keyword 始终是渲染进程粘性状态。
 * 流式 / 压缩中：加号仍可点出 Plan / Goal / Vibe 胶囊（本地乐观态），
 * Host 切模式等本轮结束后再生效。
 */

import { AppSelect } from "./AppSelect";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";

import type { CommandInput, CommandName } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { MenuItem } from "./menus";
import { usePreviewMode } from "./preview/PreviewContext";
import type { MagicKeyword } from "./composerMode";

type SessionMode = "plan" | "goal" | "vibe";
type LoopLimitKind = "none" | "turns" | "minutes";
type MenuSection = "root" | "content" | "session" | "orchestration" | "automation" | "all";

type ComposerActions = {
  onAttachFiles: () => void;
  onMention: () => void;
  onCommands: () => void;
};

type PreviewLayer3 = {
  session: SessionMode | null;
  loop: boolean;
  loopKind: LoopLimitKind;
  loopValue: string;
  loopConditionMode: "none" | "while" | "until";
  loopConditionCommand: string;
  fast: boolean;
  prewalk: boolean;
  prewalkTarget: string;
};

const PREVIEW_OFF: PreviewLayer3 = {
  session: null,
  loop: false,
  loopKind: "none",
  loopValue: "10",
  loopConditionMode: "none",
  loopConditionCommand: "",
  fast: false,
  prewalk: false,
  prewalkTarget: "",
};

const DEFAULT_GOAL_OBJECTIVE = "Continue current work";
const TOGGLE_FLYOUT_WIDTH = 280;
const FLYOUT_CLOSE_GRACE_MS = 200;

function loopLimitOf(kind: LoopLimitKind, value: string): { turns?: number; minutes?: number } | undefined {
  if (kind === "none") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return kind === "turns" ? { turns: parsed } : { minutes: parsed };
}

function loopSummary(kind: LoopLimitKind, value: string): string | undefined {
  const limit = loopLimitOf(kind, value);
  if (limit?.turns !== undefined) return `· ${limit.turns}t`;
  if (limit?.minutes !== undefined) return `· ${limit.minutes}m`;
  return undefined;
}

function labelInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "—";
}

/** Keep composer :focus-within while clicking labels/checkboxes in the popup.
 *  Otherwise mousedown on a non-focusable label blurs the plus button before
 *  the checkbox focuses, and the composer glow (and the menus in that layer)
 *  fade out and back in. Text fields still need default focus. */
function retainComposerFocus(event: ReactMouseEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest("input:not([type='checkbox']):not([type='radio']), select, textarea")) return;
  event.preventDefault();
}

function snapshotSession(snapshot: OperatorStateSnapshot | undefined): SessionMode | null {
  if (snapshot?.activeMode === "plan" || snapshot?.activeMode === "goal" || snapshot?.activeMode === "vibe") {
    return snapshot.activeMode;
  }
  return null;
}

function enterCapability(mode: SessionMode): string {
  if (mode === "plan") return "mode.plan.enter";
  if (mode === "vibe") return "mode.vibe.enter";
  return "goal.create";
}

function exitCapability(mode: SessionMode): string {
  if (mode === "plan") return "mode.plan.exit";
  if (mode === "vibe") return "mode.vibe.exit";
  return "goal.drop";
}

export function ComposerModePicker({
  preview,
  snapshot,
  can,
  busy: _busy,
  disabled: _disabled,
  keyword,
  onKeywordChange,
  onRun,
  openNonce = 0,
  openToggles = false,
  onInteract,
  onCapsulesChange,
  speedControl,
  composerActions,
}: {
  preview: boolean;
  speedControl?: ReactNode;
  composerActions?: ComposerActions;
  snapshot?: OperatorStateSnapshot;
  can: (id: string) => boolean;
  busy: boolean;
  disabled: boolean;
  keyword: MagicKeyword | null;
  onKeywordChange: (keyword: MagicKeyword | null) => void;
  onRun: <T extends CommandName>(name: T, input: CommandInput<T>) => Promise<boolean>;
  /** Increment to open the mode menu from `/plan` and friends. */
  openNonce?: number;
  openToggles?: boolean;
  onInteract?: () => void;
  onCapsulesChange?: (hasCapsules: boolean) => void;
}) {
  const hasComposerActions = composerActions !== undefined;
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);
  const unifiedTools = hasComposerActions && collapsed;
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<MenuSection>("all");
  const [togglesOpen, setTogglesOpen] = useState(false);
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left">("right");
  const [local, setLocal] = useState<PreviewLayer3>(PREVIEW_OFF);
  /** Overlay while streaming: snapshot.activeMode lags or Host is blocked by resync. */
  const [optimistic, setOptimistic] = useState<SessionMode | null | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!hasComposerActions) return;
    const bar = buttonRef.current?.closest<HTMLElement>(".composer-bar");
    if (!bar) return;
    const sync = () => {
      const next = bar.dataset.collapse !== undefined && bar.dataset.collapse !== "full";
      if (next === collapsedRef.current) return;
      collapsedRef.current = next;
      setCollapsed(next);
      setSection(next ? "root" : "all");
      setTogglesOpen(false);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(bar, { attributes: true, attributeFilter: ["data-collapse"] });
    return () => observer.disconnect();
  }, [hasComposerActions]);
  const [menuHeight, setMenuHeight] = useState(380);
  const [menuInset, setMenuInset] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const menu = menuRef.current;
      if (!menu) return;
      setMenuHeight(Math.max(100, menu.getBoundingClientRect().bottom - 44));
      if (unifiedTools && buttonRef.current) {
        setMenuInset(Math.min(0, window.innerWidth - 8 - buttonRef.current.getBoundingClientRect().left - menu.offsetWidth));
      }
    };
    measure();
    window.addEventListener("resize", measure);
    const bar = unifiedTools ? buttonRef.current?.closest(".composer-bar") : null;
    const resizeObserver = bar ? new ResizeObserver(measure) : undefined;
    const collapseObserver = bar ? new MutationObserver(measure) : undefined;
    if (bar) {
      resizeObserver?.observe(bar);
      collapseObserver?.observe(bar, { attributes: true, attributeFilter: ["data-collapse"] });
    }
    return () => {
      window.removeEventListener("resize", measure);
      resizeObserver?.disconnect();
      collapseObserver?.disconnect();
    };
  }, [open, section, unifiedTools]);
  const flyoutTimer = useRef<number | undefined>(undefined);
  const hostFailedRef = useRef(false);
  const wasStreamingRef = useRef(false);

  useEffect(() => () => window.clearTimeout(flyoutTimer.current), []);
  useEffect(() => {
    if (openNonce <= 0) return;
    const grouped = hasComposerActions && collapsedRef.current;
    setOpen(true);
    setSection(grouped && openToggles ? "automation" : "all");
    setTogglesOpen(!grouped && openToggles);
  }, [openNonce, openToggles]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTogglesOpen(false);
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => {
    if (!preview) setLocal(PREVIEW_OFF);
  }, [preview]);
  useEffect(() => {
    if (!open) setTogglesOpen(false);
  }, [open]);
  useEffect(() => {
    const target = snapshot?.prewalk?.target;
    if (preview || !target) return;
    setLocal((current) => (current.prewalkTarget.trim() ? current : { ...current, prewalkTarget: target }));
  }, [preview, snapshot?.prewalk?.target]);
  useEffect(() => {
    if (preview) return;
    const condition = snapshot?.loop?.condition;
    setLocal(current => ({
      ...current,
      loopConditionMode: condition === undefined ? "none" : condition.until ? "until" : "while",
      loopConditionCommand: condition?.command ?? "",
    }));
  }, [preview, snapshot?.sessionId, snapshot?.loop?.condition?.command, snapshot?.loop?.condition?.until]);
  useLayoutEffect(() => {
    if (!togglesOpen) return;
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setFlyoutSide(rect.right + 8 + TOGGLE_FLYOUT_WIDTH <= window.innerWidth - 8 ? "right" : "left");
  }, [togglesOpen]);

  const committed = preview ? local.session : snapshotSession(snapshot);
  const session = !preview && optimistic !== undefined ? optimistic : committed;
  const loopOn = preview ? local.loop : snapshot?.loop !== undefined;
  const fastOn = preview ? local.fast : snapshot?.fast?.enabled === true;
  const prewalkOn = preview
    ? local.prewalk
    : snapshot?.prewalk?.status === "armed" || snapshot?.prewalk?.status === "active";
  const loopKind = local.loopKind;
  const loopValue = local.loopValue;
  const loopConditionInvalid = local.loopConditionMode !== "none" && !local.loopConditionCommand.trim();
  const loopLimitInvalid = loopKind !== "none" && loopLimitOf(loopKind, loopValue) === undefined;
  const prewalkTarget = local.prewalkTarget || (!preview ? (snapshot?.prewalk?.target ?? "") : "");

  const nextTurnOnly = !preview && (snapshot?.isStreaming === true || snapshot?.isCompacting === true);
  const planReady = preview || nextTurnOnly || can("mode.plan.enter");
  const goalReady = preview || nextTurnOnly || can("goal.create");
  const vibeReady = preview || nextTurnOnly || can("mode.vibe.enter");
  const loopReady = preview || can("loop.enable");
  const fastReady = preview || can("session.fast.set");
  const prewalkReady = preview || can("session.prewalk.arm");

  useEffect(() => {
    setOptimistic(undefined);
    hostFailedRef.current = false;
  }, [snapshot?.sessionId]);
  useEffect(() => {
    if (preview || optimistic === undefined) return;
    if (optimistic === committed) {
      setOptimistic(undefined);
      hostFailedRef.current = false;
    }
  }, [preview, optimistic, committed]);
  useEffect(() => {
    const ended = wasStreamingRef.current && !nextTurnOnly;
    wasStreamingRef.current = nextTurnOnly;
    if (!ended || preview || optimistic === undefined || optimistic === committed || !hostFailedRef.current) return;
    hostFailedRef.current = false;
    void (async () => {
      if (optimistic === null) {
        if (committed === "plan") await onRun("mode.plan.exit", { discardDraft: true });
        else if (committed === "goal") await onRun("goal.drop", {});
        else if (committed === "vibe") await onRun("mode.vibe.exit", {});
        return;
      }
      if (committed === optimistic) return;
      if (committed === "plan" && !(await onRun("mode.plan.exit", { discardDraft: true }))) return;
      if (committed === "goal" && !(await onRun("goal.drop", {}))) return;
      if (committed === "vibe" && !(await onRun("mode.vibe.exit", {}))) return;
      if (optimistic === "plan") await onRun("mode.plan.enter", {});
      else if (optimistic === "vibe") await onRun("mode.vibe.enter", {});
      else await onRun("goal.create", { objective: DEFAULT_GOAL_OBJECTIVE });
    })();
  }, [committed, nextTurnOnly, onRun, optimistic, preview]);

  const close = () => {
    window.clearTimeout(flyoutTimer.current);
    setTogglesOpen(false);
    setOpen(false);
  };

  const scheduleFlyoutClose = () => {
    window.clearTimeout(flyoutTimer.current);
    flyoutTimer.current = window.setTimeout(() => setTogglesOpen(false), FLYOUT_CLOSE_GRACE_MS);
  };
  const keepFlyoutOpen = () => {
    window.clearTimeout(flyoutTimer.current);
    setTogglesOpen(true);
  };

  const exitSession = async (): Promise<boolean> => {
    if (session === "plan") return onRun("mode.plan.exit", { discardDraft: true });
    if (session === "goal") return onRun("goal.drop", {});
    if (session === "vibe") return onRun("mode.vibe.exit", {});
    return true;
  };

  const enterSession = async (next: SessionMode): Promise<boolean> => {
    if (next === "plan") return onRun("mode.plan.enter", {});
    if (next === "vibe") return onRun("mode.vibe.enter", {});
    return onRun("goal.create", { objective: DEFAULT_GOAL_OBJECTIVE });
  };

  const selectSession = (next: SessionMode, ready: boolean) => {
    if (!ready) return;
    onInteract?.();
    if (preview) {
      setLocal((current) => ({ ...current, session: current.session === next ? null : next }));
      return;
    }
    const turningOff = session === next;
    setOptimistic(turningOff ? null : next);
    const needed = turningOff ? exitCapability(next) : enterCapability(next);
    if (!can(needed)) {
      hostFailedRef.current = true;
      return;
    }
    void (async () => {
      let ok = true;
      if (turningOff) {
        ok = await exitSession();
      } else {
        if (session !== null) ok = await exitSession();
        if (ok) ok = await enterSession(next);
      }
      hostFailedRef.current = !ok;
    })();
  };

  const toggleKeyword = (next: MagicKeyword) => {
    onInteract?.();
    onKeywordChange(keyword === next ? null : next);
  };

  const toggleLoop = () => {
    if (!loopReady) return;
    if (!loopOn && (loopConditionInvalid || loopLimitInvalid)) return;
    onInteract?.();
    if (preview) {
      setLocal((current) => ({ ...current, loop: !current.loop }));
      return;
    }
    if (loopOn) {
      void onRun("loop.disable", {});
      return;
    }
    const limit = loopLimitOf(loopKind, loopValue);
    const condition = local.loopConditionMode === "none" ? undefined : {
      command: local.loopConditionCommand.trim(),
      until: local.loopConditionMode === "until",
    };
    void onRun("loop.enable", { ...(limit === undefined ? {} : { limit }), ...(condition === undefined ? {} : { condition }) });
  };

  const toggleFast = () => {
    if (!fastReady) return;
    onInteract?.();
    if (preview) {
      setLocal((current) => ({ ...current, fast: !current.fast }));
      return;
    }
    void onRun("session.fast.set", { enabled: !fastOn });
  };

  const togglePrewalk = () => {
    if (!prewalkReady) return;
    onInteract?.();
    if (preview) {
      setLocal((current) => ({ ...current, prewalk: !current.prewalk }));
      return;
    }
    if (prewalkOn) {
      void onRun("session.prewalk.disarm", {});
      return;
    }
    const target = prewalkTarget.trim();
    void onRun("session.prewalk.arm", target.length === 0 ? {} : { target });
  };

  const applyLoopParams = (kind: LoopLimitKind, value: string) => {
    onInteract?.();
    setLocal((current) => ({ ...current, loopKind: kind, loopValue: value }));
    if (preview || !loopOn || !loopReady) return;
    const limit = loopLimitOf(kind, value);
    if (kind !== "none" && limit === undefined) return;
    void onRun("loop.enable", limit === undefined ? {} : { limit });
  };

  const applyPrewalkTarget = (value: string) => {
    onInteract?.();
    setLocal((current) => ({ ...current, prewalkTarget: value }));
    if (preview || !prewalkOn || !prewalkReady) return;
    const target = value.trim();
    void onRun("session.prewalk.arm", target.length === 0 ? {} : { target });
  };

  const capsules: ReadonlyArray<{
    id: string;
    label: string;
    tint: "blue" | "purple" | "amber" | "green" | "cyan";
    onClear: () => void;
  }> = [
    ...(session === "plan" ? [{ id: "plan", label: "Plan", tint: "blue" as const, onClear: () => selectSession("plan", planReady) }] : []),
    ...(session === "goal" ? [{ id: "goal", label: "Goal", tint: "blue" as const, onClear: () => selectSession("goal", goalReady) }] : []),
    ...(session === "vibe" ? [{ id: "vibe", label: "Vibe", tint: "blue" as const, onClear: () => selectSession("vibe", vibeReady) }] : []),
    ...(keyword === "ultrathink"
      ? [{ id: "ultrathink", label: "Ultrathink", tint: "purple" as const, onClear: () => toggleKeyword("ultrathink") }]
      : []),
    ...(keyword === "orchestrate"
      ? [{ id: "orchestrate", label: "Orchestrate", tint: "purple" as const, onClear: () => toggleKeyword("orchestrate") }]
      : []),
    ...(keyword === "workflowz"
      ? [{ id: "workflowz", label: "Workflowz", tint: "purple" as const, onClear: () => toggleKeyword("workflowz") }]
      : []),
    ...(loopOn
      ? [{
          id: "loop",
          label: `Loop${loopSummary(loopKind, loopValue) ? ` ${loopSummary(loopKind, loopValue)}` : ""}`,
          tint: "amber" as const,
          onClear: toggleLoop,
        }]
      : []),
    ...(!speedControl && fastOn ? [{ id: "fast", label: "Fast", tint: "green" as const, onClear: toggleFast }] : []),
    ...(prewalkOn
      ? [{
          id: "prewalk",
          label: prewalkTarget.trim() ? `Prewalk · ${prewalkTarget.trim()}` : "Prewalk",
          tint: "cyan" as const,
          onClear: togglePrewalk,
        }]
      : []),
  ];

  useEffect(() => {
    onCapsulesChange?.(capsules.length > 0);
  }, [capsules.length, onCapsulesChange]);

  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const showAll = !unifiedTools || section === "all";
  const showSession = showAll || section === "session";
  const showOrchestration = showAll || section === "orchestration";
  const showAutomation = unifiedTools && section === "automation";
  const runComposerAction = (action: () => void) => {
    close();
    action();
  };

  return (
    <>
      <span className={`approval-pill-wrap${hasComposerActions ? " cmp-tools-wrap" : ""}`}>
        <button
          ref={buttonRef}
          type="button"
          className="icon-btn small"
          onClick={() => {
            onInteract?.();
            setSection(unifiedTools ? "root" : "all");
            setOpen((value) => !value);
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t(unifiedTools ? "composer.moreTools" : "composer.sessionMode")}
          aria-description={capsules.length ? capsules.map(capsule => capsule.label).join(", ") : undefined}
          data-tip={t(unifiedTools ? "composer.moreTools" : "composer.mode")}
        >
          <Icon name="plus" extra="sm" />
          {unifiedTools && capsules.length > 0 ? <span className="cmp-tools-active" aria-hidden="true" /> : null}
        </button>
        {open ? (
          <>
            <div className="approval-menu-backdrop" onClick={close} />
            <div
              className={`approval-menu cmp-mode-menu${unifiedTools ? " cmp-tools-menu" : ""}`}
              style={{ "--cmp-menu-max-height": `${menuHeight}px`, ...(unifiedTools ? { left: menuInset } : {}) } as CSSProperties}
              role="menu"
              aria-label={t(unifiedTools ? "composer.moreTools" : "composer.sessionMode")}
              ref={menuRef}
              onMouseDown={retainComposerFocus}
            >
              <div className="cmp-mode-menu-scroll">
              {preview && marks ? <p className="cmp-menu-note"><span className="chip gray xs">{t("common.demo")}</span>{t("composer.previewModelNote")}</p> : null}
              {unifiedTools && section !== "root" ? (
                <>
                  <MenuItem icon="chevron-l" onClick={() => { setSection("root"); setTogglesOpen(false); }}>{t("composer.backToTools")}</MenuItem>
                  <div className="cmp-menu-sep" />
                </>
              ) : null}
              {unifiedTools && composerActions && section === "root" ? (
                <>
                  <button type="button" className="menu-item cmp-tools-category" role="menuitem" aria-haspopup="menu" onClick={() => setSection("content")}>
                    <Icon name="attach" extra="sm" /><span>{t("composer.addContent")}</span><Icon name="chevron-r" extra="sm" />
                  </button>
                  <MenuItem icon="slash" onClick={() => runComposerAction(composerActions.onCommands)}>{t("composer.commands")}</MenuItem>
                  <div className="cmp-menu-sep" />
                  <button type="button" className="menu-item cmp-tools-category" role="menuitem" aria-haspopup="menu" onClick={() => setSection("session")}>
                    <Icon name="message" extra="sm" /><span>{t("composer.sessionMode")}</span><Icon name="chevron-r" extra="sm" />
                  </button>
                  <button type="button" className="menu-item cmp-tools-category" role="menuitem" aria-haspopup="menu" onClick={() => setSection("orchestration")}>
                    <Icon name="branch" extra="sm" /><span>{t("composer.orchestration")}</span><Icon name="chevron-r" extra="sm" />
                  </button>
                  <button type="button" className="menu-item cmp-tools-category" role="menuitem" aria-haspopup="menu" onClick={() => setSection("automation")}>
                    <Icon name="zap" extra="sm" /><span>{t("composer.moreModes")}</span><Icon name="chevron-r" extra="sm" />
                  </button>
                </>
              ) : null}
              {unifiedTools && composerActions && section === "content" ? (
                <>
                  <p className="menu-label">{t("composer.addContent")}</p>
                  <MenuItem icon="attach" onClick={() => runComposerAction(composerActions.onAttachFiles)}>{t("composer.attachFilesAria")}</MenuItem>
                  <MenuItem icon="at" onClick={() => runComposerAction(composerActions.onMention)}>{t("composer.mentionAria")}</MenuItem>
                </>
              ) : null}
              {nextTurnOnly && (showSession || showOrchestration || showAutomation) ? <p className="cmp-menu-note">{t("composer.modeNoteNextTurn")}</p> : null}
              {showSession ? <>
              <p className="menu-label">{t("composer.sessionMode")}</p>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={session === "plan"}
                className={`approval-menu-item${session === "plan" ? " selected" : ""}`}
                disabled={!planReady}
                data-tip={planReady ? undefined : t("common.notImplemented")}
                onClick={() => selectSession("plan", planReady)}
              >
                <span className="am-label">Plan</span>
                <span className="am-desc">{t("composer.modePlanDesc")}</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={session === "goal"}
                className={`approval-menu-item${session === "goal" ? " selected" : ""}`}
                disabled={!goalReady}
                data-tip={goalReady ? undefined : t("common.notImplemented")}
                onClick={() => selectSession("goal", goalReady)}
              >
                <span className="am-label">Goal</span>
                <span className="am-desc">{t("composer.modeGoalDesc")}</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={session === "vibe"}
                className={`approval-menu-item${session === "vibe" ? " selected" : ""}`}
                disabled={!vibeReady}
                data-tip={vibeReady ? undefined : t("common.notImplemented")}
                onClick={() => selectSession("vibe", vibeReady)}
              >
                <span className="am-label">Vibe</span>
                <span className="am-desc">{t("composer.modeVibeDesc")}</span>
              </button>

              </> : null}
              {showSession && showOrchestration ? <div className="cmp-menu-sep" /> : null}
              {showOrchestration ? <>
              <p className="menu-label">{t("composer.orchestration")}</p>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={keyword === "ultrathink"}
                className={`approval-menu-item${keyword === "ultrathink" ? " selected" : ""}`}
                onClick={() => toggleKeyword("ultrathink")}
              >
                <span className="am-label">Ultrathink</span>
                <span className="am-desc">{t("composer.ultrathinkDesc")}</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={keyword === "orchestrate"}
                className={`approval-menu-item${keyword === "orchestrate" ? " selected" : ""}`}
                onClick={() => toggleKeyword("orchestrate")}
              >
                <span className="am-label">Orchestrate</span>
                <span className="am-desc">{t("composer.orchestrateDesc")}</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={keyword === "workflowz"}
                className={`approval-menu-item${keyword === "workflowz" ? " selected" : ""}`}
                onClick={() => toggleKeyword("workflowz")}
              >
                <span className="am-label">Workflowz</span>
                <span className="am-desc">{t("composer.workflowzDesc")}</span>
              </button>
              </> : null}
              </div>
              {showAll ? <>
              <div className="cmp-menu-sep" />
              <span
                className={`cmp-more-zone${togglesOpen ? " is-open" : ""}`}
                onMouseEnter={unifiedTools ? undefined : keepFlyoutOpen}
                onMouseLeave={unifiedTools ? undefined : scheduleFlyoutClose}
              >
                <button
                  type="button"
                  className="cmp-more"
                  aria-haspopup="menu"
                  aria-expanded={togglesOpen}
                  aria-label={t("composer.moreModes")}
                  onClick={() => unifiedTools ? setSection("automation") : setTogglesOpen(true)}
                >
                  <span>{t("composer.moreModes")}</span>
                  <span className="spacer" />
                  <Icon name={flyoutSide === "right" ? "chevron-r" : "chevron-l"} extra="sm" />
                </button>
              </span>
              </> : null}
              {togglesOpen || showAutomation ? (
                <div
                  className={showAutomation ? "cmp-tools-options" : `menu rms-pop cmp-flyout cmp-mode-flyout side-${flyoutSide}`}
                  role="menu"
                  aria-label={t("composer.moreModesFlyoutAria")}
                  onMouseDown={retainComposerFocus}
                  onMouseEnter={showAutomation ? undefined : keepFlyoutOpen}
                  onMouseLeave={showAutomation ? undefined : scheduleFlyoutClose}
                >
                  <p className="menu-label">{t("composer.multipleSelectable")}</p>
                  <label className={`cmp-mode-check${loopOn ? " selected" : ""}`}>
                    <input type="checkbox" checked={loopOn} disabled={!loopReady || (!loopOn && (loopConditionInvalid || loopLimitInvalid))} onChange={toggleLoop} />
                    <span>
                      <span className="am-label">Loop</span>
                      <span className="am-desc">{t("composer.loopDesc")}</span>
                    </span>
                  </label>
                  <div className="cmp-mode-params">
                    <AppSelect
                      aria-label={t("composer.loopLimitType")}
                      value={loopKind}
                      disabled={!loopReady}
                      onChange={(event) => applyLoopParams(event.target.value as LoopLimitKind, loopValue)}
                    >
                      <option value="none">{t("composer.loopUnlimited")}</option>
                      <option value="turns">turns</option>
                      <option value="minutes">minutes</option>
                    </AppSelect>
                    {loopKind !== "none" ? (
                      <input
                        type="number"
                        min={1}
                        aria-label={t("composer.loopLimitValue")}
                        value={loopValue}
                        disabled={!loopReady}
                        onChange={(event) => setLocal((current) => ({ ...current, loopValue: event.target.value }))}
                        onBlur={() => applyLoopParams(loopKind, loopValue)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") applyLoopParams(loopKind, (event.target as HTMLInputElement).value);
                        }}
                      />
                    ) : null}
                  </div>
                  <div className="cmp-mode-params">
                    <AppSelect aria-label={t("composer.loopCondition")} value={local.loopConditionMode} disabled={!loopReady || loopOn} onChange={event => setLocal(current => ({ ...current, loopConditionMode: event.target.value as PreviewLayer3["loopConditionMode"] }))}>
                      <option value="none">{t("composer.loopNoCondition")}</option>
                      <option value="while">while</option>
                      <option value="until">until</option>
                    </AppSelect>
                  </div>
                  {local.loopConditionMode !== "none" ? (
                    <div className="cmp-mode-params">
                      <input type="text" aria-label={t("composer.loopConditionCommand")} placeholder="test -f done" value={local.loopConditionCommand} disabled={!loopReady || loopOn} onChange={event => setLocal(current => ({ ...current, loopConditionCommand: event.target.value }))} />
                    </div>
                  ) : null}
                  <p className="am-desc">{!preview && snapshot?.loop?.evaluatingCondition ? t("composer.loopChecking") : t("composer.loopConditionHint")}</p>
                  {speedControl ?? (<label className={`cmp-mode-check${fastOn ? " selected" : ""}`} data-tip={fastReady ? undefined : t("common.notImplemented")}>
                    <input type="checkbox" checked={fastOn} disabled={!fastReady} onChange={toggleFast} />
                    <span>
                      <span className="am-label">Fast</span>
                      <span className="am-desc">{t("composer.fastDesc")}</span>
                    </span>
                  </label>)}
                  <label className={`cmp-mode-check${prewalkOn ? " selected" : ""}`} data-tip={prewalkReady ? undefined : t("common.notImplemented")}>
                    <input type="checkbox" checked={prewalkOn} disabled={!prewalkReady} onChange={togglePrewalk} />
                    <span>
                      <span className="am-label">Prewalk</span>
                      <span className="am-desc">{t("composer.prewalkDesc")}</span>
                    </span>
                  </label>
                  <div className="cmp-mode-params">
                    <input
                      type="text"
                      aria-label={t("composer.prewalkInto")}
                      placeholder="@smol"
                      value={prewalkTarget}
                      disabled={!prewalkReady}
                      onChange={(event) => setLocal((current) => ({ ...current, prewalkTarget: event.target.value }))}
                      onBlur={(event) => applyPrewalkTarget(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") applyPrewalkTarget((event.target as HTMLInputElement).value);
                      }}
                    />
                    <button type="button" className="btn small outline" disabled={!preview && (!can("session.prewalk.restart") || nextTurnOnly)} onClick={() => {
                      onInteract?.();
                      if (preview) setLocal(current => ({ ...current, prewalk: true, prewalkTarget: "@smol" }));
                      else void onRun("session.prewalk.restart", {});
                    }}>{t("composer.prewalkRestart")}</button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </span>
      {capsules.length > 0 ? (
        <span className="cmp-mode-cluster">
          {capsules.map((capsule) => (
            <span key={capsule.id} className={`mode-chip tint-${capsule.tint}`} data-tip={capsule.label}>
              <span className="mode-chip-label mode-chip-label-full">{capsule.label}</span>
              <span className="mode-chip-label mode-chip-label-initial" aria-hidden="true">{labelInitial(capsule.label)}</span>
              <button
                type="button"
                className="mode-chip-clear"
                aria-label={`${t("common.cancel")} ${capsule.label}`}
                onClick={capsule.onClear}
              >
                <Icon name="x" extra="sm" />
              </button>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}
