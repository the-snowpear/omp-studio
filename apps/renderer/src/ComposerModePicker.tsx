/**
 * Composer「Full Access」右侧的模式加号：三层弹窗 + 彩色胶囊。
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

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { CommandInput, CommandName } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import { Icon } from "./icons";
import type { MagicKeyword } from "./composerMode";

type SessionMode = "plan" | "goal" | "vibe";
type LoopLimitKind = "none" | "turns" | "minutes";

type PreviewLayer3 = {
  session: SessionMode | null;
  loop: boolean;
  loopKind: LoopLimitKind;
  loopValue: string;
  fast: boolean;
  prewalk: boolean;
  prewalkTarget: string;
};

const PREVIEW_OFF: PreviewLayer3 = {
  session: null,
  loop: false,
  loopKind: "none",
  loopValue: "10",
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
}: {
  preview: boolean;
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
}) {
  const [open, setOpen] = useState(false);
  const [togglesOpen, setTogglesOpen] = useState(false);
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left">("right");
  const [local, setLocal] = useState<PreviewLayer3>(PREVIEW_OFF);
  /** Overlay while streaming: snapshot.activeMode lags or Host is blocked by resync. */
  const [optimistic, setOptimistic] = useState<SessionMode | null | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const flyoutTimer = useRef<number | undefined>(undefined);
  const hostFailedRef = useRef(false);
  const wasStreamingRef = useRef(false);

  useEffect(() => () => window.clearTimeout(flyoutTimer.current), []);
  useEffect(() => {
    if (openNonce <= 0) return;
    setOpen(true);
    setTogglesOpen(openToggles);
  }, [openNonce, openToggles]);
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
    onKeywordChange(keyword === next ? null : next);
  };

  const toggleLoop = () => {
    if (!loopReady) return;
    if (preview) {
      setLocal((current) => ({ ...current, loop: !current.loop }));
      return;
    }
    if (loopOn) {
      void onRun("loop.disable", {});
      return;
    }
    const limit = loopLimitOf(loopKind, loopValue);
    void onRun("loop.enable", limit === undefined ? {} : { limit });
  };

  const toggleFast = () => {
    if (!fastReady) return;
    if (preview) {
      setLocal((current) => ({ ...current, fast: !current.fast }));
      return;
    }
    void onRun("session.fast.set", { enabled: !fastOn });
  };

  const togglePrewalk = () => {
    if (!prewalkReady) return;
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
    setLocal((current) => ({ ...current, loopKind: kind, loopValue: value }));
    if (preview || !loopOn || !loopReady) return;
    const limit = loopLimitOf(kind, value);
    if (kind !== "none" && limit === undefined) return;
    void onRun("loop.enable", limit === undefined ? {} : { limit });
  };

  const applyPrewalkTarget = (value: string) => {
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
      ? [{ id: "ultrathink", label: "Ultrathink", tint: "purple" as const, onClear: () => onKeywordChange(null) }]
      : []),
    ...(keyword === "orchestrate"
      ? [{ id: "orchestrate", label: "Orchestrate", tint: "purple" as const, onClear: () => onKeywordChange(null) }]
      : []),
    ...(keyword === "workflowz"
      ? [{ id: "workflowz", label: "Workflowz", tint: "purple" as const, onClear: () => onKeywordChange(null) }]
      : []),
    ...(loopOn
      ? [{
          id: "loop",
          label: `Loop${loopSummary(loopKind, loopValue) ? ` ${loopSummary(loopKind, loopValue)}` : ""}`,
          tint: "amber" as const,
          onClear: toggleLoop,
        }]
      : []),
    ...(fastOn ? [{ id: "fast", label: "Fast", tint: "green" as const, onClear: toggleFast }] : []),
    ...(prewalkOn
      ? [{
          id: "prewalk",
          label: prewalkTarget.trim() ? `Prewalk · ${prewalkTarget.trim()}` : "Prewalk",
          tint: "cyan" as const,
          onClear: togglePrewalk,
        }]
      : []),
  ];

  return (
    <>
      <span className="approval-pill-wrap">
        <button
          type="button"
          className="icon-btn small"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="会话模式"
          data-tip="模式"
        >
          <Icon name="plus" extra="sm" />
        </button>
        {open ? (
          <>
            <div className="approval-menu-backdrop" onClick={close} />
            <div
              className="approval-menu cmp-mode-menu"
              role="menu"
              aria-label="会话模式"
              ref={menuRef}
              onMouseDown={retainComposerFocus}
            >
              {preview ? <p className="cmp-menu-note"><span className="chip gray xs">演示</span>预览下不调用 Host</p> : null}
              {nextTurnOnly ? <p className="cmp-menu-note">当前轮次仍用原模式，下一轮对话（含插入信息）才生效</p> : null}
              <p className="menu-label">会话模式</p>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={session === "plan"}
                className={`approval-menu-item${session === "plan" ? " selected" : ""}`}
                disabled={!planReady}
                data-tip={planReady ? undefined : "Plan（暂未实现）"}
                onClick={() => selectSession("plan", planReady)}
              >
                <span className="am-label">Plan</span>
                <span className="am-desc">只读规划，审批后再改代码</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={session === "goal"}
                className={`approval-menu-item${session === "goal" ? " selected" : ""}`}
                disabled={!goalReady}
                data-tip={goalReady ? undefined : "Goal（暂未实现）"}
                onClick={() => selectSession("goal", goalReady)}
              >
                <span className="am-label">Goal</span>
                <span className="am-desc">目标驱动，可设 token 预算</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={session === "vibe"}
                className={`approval-menu-item${session === "vibe" ? " selected" : ""}`}
                disabled={!vibeReady}
                data-tip={vibeReady ? undefined : "Vibe（暂未实现）"}
                onClick={() => selectSession("vibe", vibeReady)}
              >
                <span className="am-label">Vibe</span>
                <span className="am-desc">持久 director，与 Plan、Goal 互斥</span>
              </button>

              <div className="cmp-menu-sep" />
              <p className="menu-label">编排</p>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={keyword === "ultrathink"}
                className={`approval-menu-item${keyword === "ultrathink" ? " selected" : ""}`}
                onClick={() => toggleKeyword("ultrathink")}
              >
                <span className="am-label">Ultrathink</span>
                <span className="am-desc">该轮拉到最高思考档；胶囊取消前每次发送都注入</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={keyword === "orchestrate"}
                className={`approval-menu-item${keyword === "orchestrate" ? " selected" : ""}`}
                onClick={() => toggleKeyword("orchestrate")}
              >
                <span className="am-label">Orchestrate</span>
                <span className="am-desc">该轮并行拆任务；胶囊取消前每次发送都注入</span>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={keyword === "workflowz"}
                className={`approval-menu-item${keyword === "workflowz" ? " selected" : ""}`}
                onClick={() => toggleKeyword("workflowz")}
              >
                <span className="am-label">Workflowz</span>
                <span className="am-desc">确定性多子代理工作流 keyword</span>
              </button>

              <div className="cmp-menu-sep" />
              <span
                className={`cmp-more-zone${togglesOpen ? " is-open" : ""}`}
                onMouseEnter={keepFlyoutOpen}
                onMouseLeave={scheduleFlyoutClose}
              >
                <button
                  type="button"
                  className="cmp-more"
                  aria-haspopup="menu"
                  aria-expanded={togglesOpen}
                  aria-label="更多模式"
                  onClick={() => setTogglesOpen((value) => !value)}
                >
                  <span>更多模式</span>
                  <span className="spacer" />
                  <Icon name={flyoutSide === "right" ? "chevron-r" : "chevron-l"} extra="sm" />
                </button>
              </span>
              {togglesOpen ? (
                <div
                  className={`menu rms-pop cmp-flyout cmp-mode-flyout side-${flyoutSide}`}
                  role="menu"
                  aria-label="更多模式（可多选）"
                  onMouseDown={retainComposerFocus}
                  onMouseEnter={keepFlyoutOpen}
                  onMouseLeave={scheduleFlyoutClose}
                >
                  <p className="menu-label">可多选</p>
                  <label className={`cmp-mode-check${loopOn ? " selected" : ""}`}>
                    <input type="checkbox" checked={loopOn} disabled={!loopReady} onChange={toggleLoop} />
                    <span>
                      <span className="am-label">Loop</span>
                      <span className="am-desc">下一条消息循环重交</span>
                    </span>
                  </label>
                  <div className="cmp-mode-params">
                    <select
                      aria-label="Loop 限制类型"
                      value={loopKind}
                      disabled={!loopReady}
                      onChange={(event) => applyLoopParams(event.target.value as LoopLimitKind, loopValue)}
                    >
                      <option value="none">不限</option>
                      <option value="turns">turns</option>
                      <option value="minutes">minutes</option>
                    </select>
                    {loopKind !== "none" ? (
                      <input
                        type="number"
                        min={1}
                        aria-label="Loop 限制数值"
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
                  <label className={`cmp-mode-check${fastOn ? " selected" : ""}`} data-tip={fastReady ? undefined : "Fast（暂未实现）"}>
                    <input type="checkbox" checked={fastOn} disabled={!fastReady} onChange={toggleFast} />
                    <span>
                      <span className="am-label">Fast</span>
                      <span className="am-desc">当前会话打开 priority / speed=fast</span>
                    </span>
                  </label>
                  <label className={`cmp-mode-check${prewalkOn ? " selected" : ""}`} data-tip={prewalkReady ? undefined : "Prewalk（暂未实现）"}>
                    <input type="checkbox" checked={prewalkOn} disabled={!prewalkReady} onChange={togglePrewalk} />
                    <span>
                      <span className="am-label">Prewalk</span>
                      <span className="am-desc">规划完切到 into 模型（默认 @smol）</span>
                    </span>
                  </label>
                  <div className="cmp-mode-params">
                    <input
                      type="text"
                      aria-label="Prewalk into"
                      placeholder="@smol"
                      value={prewalkTarget}
                      disabled={!prewalkReady}
                      onChange={(event) => setLocal((current) => ({ ...current, prewalkTarget: event.target.value }))}
                      onBlur={(event) => applyPrewalkTarget(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") applyPrewalkTarget((event.target as HTMLInputElement).value);
                      }}
                    />
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
                aria-label={`取消 ${capsule.label}`}
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
