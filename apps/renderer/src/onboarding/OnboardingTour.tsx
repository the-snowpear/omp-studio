import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons";
import { useI18n } from "../i18n";
import { PLATFORM } from "../platform";
import { OnboardingScene, overviewSlotDelay, SCENE_DURATION, type OnboardingSceneId } from "./scenes";
import { sceneKeyframes } from "./timelines";
import {
  type OnboardingMode,
} from "./onboardingState";
import "./onboarding.css";

interface StepSpec {
  readonly id: OnboardingSceneId;
  /** 每条提示前的小图标；概览用序号对应舞台上的五个区域。 */
  readonly tips: readonly (IconName | "num")[];
}

export const ONBOARDING_STEPS: readonly StepSpec[] = [
  { id: "overview", tips: ["num", "num", "num", "num", "num"] },
  { id: "windows", tips: ["message", "minimize", "x"] },
  { id: "snap", tips: ["columns", "split"] },
  { id: "dock", tips: ["plus", "menu"] },
  { id: "dragAll", tips: ["external", "message", "keyboard"] },
  { id: "toolRail", tips: ["chevron-d", "layers", "keyboard"] },
  { id: "pin", tips: ["monitor", "pin", "refresh"] },
  { id: "shortcuts", tips: ["keyboard", "arrow-r", "tool-list"] },
];

const STAGE_WIDTH = 640;

/** `[[Ctrl]]` → <kbd>Ctrl</kbd>；文案里的按键统一这样标。 */
function richText(text: string): ReactNode {
  const parts = text.split(/\[\[(.+?)\]\]/g);
  if (parts.length === 1) return text;
  return parts.map((part, index) => (index % 2 === 1 ? <kbd key={index}>{part}</kbd> : <Fragment key={index}>{part}</Fragment>));
}

function useStageScale(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = () => {
      const width = element.clientWidth;
      if (width > 0) setScale(width / STAGE_WIDTH);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, scale];
}

const FOCUSABLE = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function OnboardingTour({ mode, onClose }: { readonly mode: OnboardingMode; readonly onClose: (completed: boolean) => void }): ReactNode {
  const { t } = useI18n();
  const last = ONBOARDING_STEPS.length - 1;
  const [index, setIndex] = useState(0);
  const [maxSeen, setMaxSeen] = useState(0);
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const [replay, setReplay] = useState(0);
  const [stageRef, scale] = useStageScale();
  const dialogRef = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  const allSeen = maxSeen >= last;
  const canClose = mode === "replay" || allSeen;
  const step = ONBOARDING_STEPS[index]!;
  const duration = SCENE_DURATION[step.id];
  const mod = PLATFORM === "darwin" ? "⌘" : "Ctrl";
  const params = { mod, shift: PLATFORM === "darwin" ? "⇧" : "Shift", total: ONBOARDING_STEPS.length };

  const goTo = useCallback((next: number) => {
    const target = Math.max(0, Math.min(last, next));
    if (target === index) return;
    setDir(target > index ? "forward" : "back");
    setIndex(target);
    setMaxSeen((seen) => Math.max(seen, target));
  }, [index, last]);

  const close = useCallback(() => {
    if (!canClose) return;
    onClose(allSeen);
  }, [allSeen, canClose, onClose]);

  const primary = useCallback(() => {
    if (index < last) goTo(index + 1);
    else onClose(true);
  }, [goTo, index, last, onClose]);

  // 焦点：打开时进入主按钮，关闭时还给原来的元素。
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryRef.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);

  // 键盘在捕获阶段截住：教程打开时工作台快捷键不应在背后生效。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (dialog === null) return;
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowRight" && !event.altKey) {
        event.preventDefault();
        goTo(index + 1);
        return;
      }
      if (event.key === "ArrowLeft" && !event.altKey) {
        event.preventDefault();
        goTo(index - 1);
        return;
      }
      if (event.key === "Tab") {
        const nodes = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (nodes.length === 0) return;
        const first = nodes[0]!;
        const lastNode = nodes[nodes.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault();
          lastNode.focus();
        } else if (!event.shiftKey && (active === lastNode || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, goTo, index]);

  // 换步后主按钮保持焦点，连按 Enter 即可一路看完。
  useEffect(() => { primaryRef.current?.focus(); }, [index]);

  const titleId = "obTourTitle";
  const bodyId = "obTourBody";
  const stepKey = `onboarding.steps.${step.id}`;
  const primaryLabel = index < last ? t("onboarding.next") : mode === "first-run" ? t("onboarding.start") : t("onboarding.done");
  const sceneStyle = { "--ob-d": `${duration}s` } as CSSProperties;

  return createPortal(
    <div className="ob-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="ob-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-mode={mode}
      >
        <div className="ob-visual">
          <div className="ob-stage-wrap" ref={stageRef} aria-hidden="true">
            <div className="ob-stage" style={{ "--ob-scale": scale } as CSSProperties}>
              <div key={`${step.id}:${replay}`} className="ob-scene" data-scene={step.id} data-dir={dir} style={sceneStyle}>
                <style>{sceneKeyframes(step.id)}</style>
                <OnboardingScene id={step.id} mod={mod} />
              </div>
            </div>
          </div>
          <div className="ob-visual-foot">
            <div className="ob-loop" style={sceneStyle} aria-hidden="true"><i key={`${step.id}:${replay}`} /></div>
            <button type="button" className="ob-replay" aria-label={t("onboarding.replay")} data-tip={t("onboarding.replay")} onClick={() => setReplay((value) => value + 1)}>
              <Icon name="rotate" />
            </button>
          </div>
        </div>
        <div className="ob-copy">
          <div className="ob-top">
            <span className="ob-kicker"><Icon name="sparkles" />{t("onboarding.kicker")}</span>
            {canClose ? (
              <button type="button" className="ob-close" aria-label={t("onboarding.close")} data-tip={t("onboarding.close")} onClick={close}>
                <Icon name="x" />
              </button>
            ) : null}
          </div>
          <div className="ob-segments" role="tablist" aria-label={t("onboarding.progress")}>
            {ONBOARDING_STEPS.map((item, itemIndex) => {
              const reachable = mode === "replay" || itemIndex <= maxSeen;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={itemIndex === index}
                  aria-label={`${itemIndex + 1}. ${t(`onboarding.steps.${item.id}.title`)}`}
                  className={`ob-seg${itemIndex === index ? " is-current" : itemIndex <= maxSeen ? " is-seen" : ""}`}
                  disabled={!reachable}
                  tabIndex={-1}
                  onClick={() => goTo(itemIndex)}
                />
              );
            })}
          </div>
          <div key={step.id} className="ob-text" data-dir={dir} style={sceneStyle}>
            <div className="ob-step-no">{t("onboarding.stepOf", { current: index + 1, total: ONBOARDING_STEPS.length })}</div>
            <h2 className="ob-title" id={titleId}>{t(`${stepKey}.title`)}</h2>
            <p className="ob-body" id={bodyId}>{richText(t(`${stepKey}.body`, params))}</p>
            <ul className="ob-tips">
              {step.tips.map((mark, tipIndex) => (
                <li
                  key={`${step.id}:${replay}:${tipIndex}`}
                  className={`ob-tip${step.id === "overview" ? " is-legend" : ""}`}
                  style={step.id === "overview" ? { animationDelay: overviewSlotDelay(tipIndex) } : undefined}
                >
                  <span className={`ob-tip-mark${mark === "num" ? " is-num" : ""}`}>{mark === "num" ? tipIndex + 1 : <Icon name={mark} />}</span>
                  <span>{richText(t(`${stepKey}.tips.t${tipIndex + 1}`, params))}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="ob-foot">
            <span className="ob-hint">{canClose ? (mode === "replay" ? t("onboarding.replayHint") : "") : t("onboarding.lockedHint", params)}</span>
            <button type="button" className="btn outline" disabled={index === 0} onClick={() => goTo(index - 1)}>
              {t("onboarding.back")}
            </button>
            <button ref={primaryRef} type="button" className="btn primary" onClick={primary}>
              {primaryLabel}
              {index < last ? <Icon name="arrow-r" /> : null}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

/**
 * 首启门控：先放教程，看完再放启动提示，避免两个模态叠在一起；
 * 「帮助 → 使用教程」重开时也挂在这里。
 */
export { OnboardingHost } from "./OnboardingHost";
