import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { formAnswers } from "@oh-my-pi/pi-tui/html-form/data";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { PLATFORM } from "../platform";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { usePreviewMode } from "../preview/PreviewContext";
import { demoMark, PromptHead, QueueNav, type DeckQueue } from "./PromptHead";
import { FormFields } from "./FormFields";
import { formPages, type FormPage } from "./formPages";
import { QuestionHeightHandle } from "./QuestionHeightHandle";
import { FormSession, type FormResponder } from "./FormSession";
import { StepNode } from "../conversation/StepRail";
import "./form.css";

/** One Session and the same field DOM survive collapse, section navigation and queue/layout changes. */
export function FormCard({ session, title, summary, meta, demo, queue, disabled, active = true, onRespond }: {
  session: FormSession; title: string; summary: string; meta?: string | undefined; demo?: boolean | undefined;
  queue?: DeckQueue | undefined; disabled?: boolean | undefined; active?: boolean | undefined;
  onRespond: FormResponder;
}) {
  const document = useSurfaceDocument();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  const view = useSyncExternalStore(session.subscribeView, session.getView, session.getView);
  const loading = useSyncExternalStore(session.subscribeMeta, () => session.getMeta().phase === "loading" && !session.getMeta().error, () => true);
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const surface = useMemo(() => Symbol("form-card"), [session, document]);
  useEffect(() => { session.attach(surface, onRespond, disabled === true, active); return () => session.detach(surface); }, [session, surface]);
  useEffect(() => { session.updateSurface(surface, onRespond, disabled === true, active); }, [session, surface, onRespond, disabled, active]);
  useLayoutEffect(() => {
    if (!active) return;
    const deck = root.current?.closest(".deck");
    deck?.classList.toggle("is-form-expanded", view.expanded);
    return () => deck?.classList.remove("is-form-expanded");
  }, [view.expanded, active]);
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = 0; }, [view.page]);
  useLayoutEffect(() => {
    if (!active || view.collapsed || !view.focusVersion) return;
    if (!view.focusField) {
      root.current?.querySelector<HTMLElement>('.form-step[aria-current="step"]')?.focus();
      return;
    }
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(view.focusField)
      : view.focusField.replace(/["\\]/g, "\\$&");
    root.current?.querySelector<HTMLElement>(`[data-form-field-id="${escaped}"] [data-form-control]:not([disabled])`)?.focus();
  }, [view.focusVersion, view.collapsed, active]);
  useEffect(() => {
    if (!active || disabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || session.getMeta().phase === "closed") return;
      const isH = event.code ? event.code === "KeyH" : event.key.toLowerCase() === "h";
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isH && !event.repeat && !event.isComposing) {
        event.preventDefault(); session.setCollapsed(!session.getView().collapsed);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [session, active, disabled, document]);
  const form = session.form;
  const pages = useMemo(() => form ? formPages(form) : [], [form]);
  const tabbed = pages.length > 1;
  const current = view.page;
  const review = tabbed && current === pages.length;
  const jump = (index: number) => session.showPage(index, pages[index]?.firstControl?.id);
  return <div ref={root} className="ask-card form-card" onKeyDownCapture={() => session.touch()} onPointerDownCapture={() => session.touch()} onKeyDown={event => {
    if (disabled || !active || event.nativeEvent.isComposing || event.defaultPrevented) return;
    if (event.key === "Escape") { if (view.collapsed) return; event.preventDefault(); event.stopPropagation(); void session.cancel(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void session.submit(); }
    else if (tabbed && !view.collapsed && (event.key === "PageDown" || event.key === "PageUp")) {
      event.preventDefault();
      jump(Math.max(0, Math.min(pages.length, current + (event.key === "PageDown" ? 1 : -1))));
    }
  }}>
    <QuestionHeightHandle key={String(view.expanded)} visible={active && !view.collapsed} />
    <div className="ask-collapsed-bar form-compact" hidden={!view.collapsed}>
      {demoMark(demo, marks)}
      <FormSummary session={session} compact />
      <strong>{summary || title}</strong>
      <QueueNav {...(queue ? { queue } : {})} />
      <button type="button" className="btn small outline" onClick={() => jump(current)}>{zh ? "展开 / Show" : "Show"}</button>
    </div>
    <div className="form-head" hidden={view.collapsed}>
      <PromptHead icon="message" title={title || (zh ? "Agent 提问" : "Agent question")} {...(demo === true ? { demo: true } : {})} {...(meta ? { meta } : {})} {...(queue ? { queue } : {})} chips={<FormSummary session={session} />} end={<span className="form-head-actions">
        <button className="icon-btn small" type="button" aria-label={view.expanded ? (zh ? "收回表单" : "Restore form size") : (zh ? "放大表单" : "Expand form")} data-tip={view.expanded ? (zh ? "收回表单" : "Restore form size") : (zh ? "放大表单" : "Expand form")} onClick={() => session.setExpanded(!view.expanded)}><Icon name={view.expanded ? "contract" : "expand"} extra="sm" /></button>
        <button className="icon-btn small" type="button" aria-label={zh ? "收起表单" : "Collapse form"} data-tip={PLATFORM === "darwin" ? (zh ? "收起 · ⌥H" : "Hide · ⌥H") : (zh ? "收起 · Alt+H" : "Hide · Alt+H")} onClick={() => session.setCollapsed(true)}><Icon name="minimize" extra="sm" /></button>
      </span>} />
      {tabbed ? <FormSectionNav session={session} pages={pages} current={current} jump={jump} /> : null}
      <FormProgress session={session} />
    </div>
    <div ref={body} className="ask-body form-body" hidden={view.collapsed}>
      {loading ? <p className="muted small" role="status">{zh ? "正在读取表单…" : "Loading form…"}</p> : form ? <FormFields form={form} session={session} pages={pages} current={current} disabled={disabled} /> : null}
      {review && form ? <FormReview session={session} /> : null}
    </div>
    <FormError session={session} />
    <FormFooter session={session} disabled={disabled} hidden={view.collapsed} onNext={tabbed && !review ? () => jump(current + 1) : undefined} canSubmit={current >= pages.length - 1} />
  </div>;
}

/** Section stepper: each group shows whether every field in it holds an answer. Re-renders on the filled count only. */
function FormSectionNav({ session, pages, current, jump }: { session: FormSession; pages: FormPage[]; current: number; jump: (index: number) => void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  useSyncExternalStore(session.subscribeMeta, () => session.getMeta().filled, () => 0);
  const nav = useRef<HTMLElement>(null);
  const labels = pages.map((page, index) => page.label || (zh ? `问题 ${index + 1}` : `Question ${index + 1}`));
  labels.push(zh ? "核对答案" : "Review answers");
  useLayoutEffect(() => {
    nav.current?.querySelector('[aria-current="step"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  return <nav ref={nav} className="form-section-nav" aria-label={zh ? "表单题组" : "Form sections"} onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? pages.length : current + (event.key === "ArrowLeft" ? -1 : 1);
    jump(Math.max(0, Math.min(pages.length, index)));
  }}>{labels.map((label, index) => {
    const done = pages[index]?.fields.every(field => session.isFieldFilled(field.id)) ?? false;
    return <button key={index} type="button" className={`form-step${index === current ? " active" : ""}${done ? " is-done" : ""}`} aria-current={index === current ? "step" : undefined} onClick={() => jump(index)}>
      <StepNode tone={index === current ? "active" : done ? "done" : "pending"} label={index + 1} icon={index === pages.length ? "check" : undefined} />
      {index < pages.length ? <span className="sr-only">{index + 1}</span> : null}
      <span className="form-step-label">{label}</span>
    </button>;
  })}</nav>;
}

function FormReview({ session }: { session: FormSession }) {
  const form = session.form!;
  const named = form.fields.filter(field => field.name);
  // The DTO already carries native question captions. Use native answer formatting for the submitted names.
  const answers = formAnswers({ fields: named, sections: [], hidden: form.hidden }, session.payload().data);
  return <dl className="form-review">{answers.map(({ answer }, index) => {
    const field = named[index]!;
    const shown = field.kind === "text" && field.type === "password" ? "•".repeat(answer.length) : answer;
    return <div key={field.id}><dt>{field.question}</dt><dd>{shown || "—"}</dd></div>;
  })}</dl>;
}

/** A thin bar under the head: answered fields over all fields, as the native form reports them. */
function FormProgress({ session }: { session: FormSession }) {
  const { filled, total } = useSyncExternalStore(session.subscribeMeta, session.getMeta, session.getMeta);
  if (!total) return null;
  return <span className="form-progress" aria-hidden><i style={{ width: `${Math.min(100, (filled / total) * 100)}%` }} /></span>;
}

/** Countdown and filled count update only this leaf, never the input subtree or conversation. */
function FormSummary({ session, compact }: { session: FormSession; compact?: boolean | undefined }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const state = useSyncExternalStore(session.subscribeMeta, session.getMeta, session.getMeta);
  return <span className={`form-summary${compact ? " is-compact" : ""}`}>
    <span>{state.filled}/{state.total} {zh ? "已填" : "filled"}</span>
    {state.remaining === undefined ? null : <span className="form-countdown" data-tip={zh ? "输入会重置闲置倒计时；超时提交当前值" : "Typing resets the idle timer; submitting current values on timeout"}><Icon name="clock" extra="sm" />{state.remaining}s</span>}
    {state.phase === "submitting" ? <span role="status">{state.timedOut ? (zh ? "超时提交当前值…" : "Timed out; submitting current values…") : (zh ? "提交中…" : "Submitting…")}</span> : state.timedOut && !state.error && state.phase === "open" ? <span role="status">{zh ? "闲置超时，等待连接后提交当前值" : "Idle timeout; waiting to submit current values once connected"}</span> : null}
  </span>;
}
function FormError({ session }: { session: FormSession }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const state = useSyncExternalStore(session.subscribeMeta, session.getMeta, session.getMeta);
  return state.error ? <div className="ask-error"><p role="alert">{state.error}</p>{state.phase === "loading" ? <button type="button" className="btn small outline" onClick={() => session.retryRead()}>{zh ? "重试读取" : "Retry loading"}</button> : null}</div> : null;
}
function FormFooter({ session, disabled, hidden, onNext, canSubmit }: {
  session: FormSession; disabled?: boolean | undefined; hidden: boolean; onNext?: (() => void) | undefined; canSubmit: boolean;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const phase = useSyncExternalStore(session.subscribeMeta, () => session.getMeta().phase, () => "loading" as const);
  const locked = disabled || phase === "submitting" || phase === "closed";
  return <div className="dk-actions" hidden={hidden}>
    <button type="button" className="btn lg outline" disabled={locked} onClick={() => { void session.cancel(); }}>{zh ? "取消" : "Cancel"}</button>
    {onNext ? <button type="button" className={canSubmit ? "btn lg outline" : "btn lg primary"} disabled={locked} onClick={onNext}>{zh ? "下一页" : "Next"}</button> : null}
    {canSubmit ? <button type="button" className="btn lg primary" disabled={locked || phase === "loading"} onClick={() => { void session.submit(); }}>{zh ? "提交" : "Submit"}</button> : null}
  </div>;
}
