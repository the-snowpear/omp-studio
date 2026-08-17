import { useEffect, useId, useRef } from "react";
import { Icon } from "../icons";
import { ConvoTranscript } from "./ConvoTranscript";
import { useConversationScroll } from "./useConversationScroll";
import { useSubagentConversation } from "./useSubagentConversation";
import type { SubagentConversationClient } from "./subagentConversationEngine";
import type { SubagentHubTarget } from "./toolMeta";

function focusablesOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true");
}

export function SubagentInspectCard({
  target,
  preview,
  client,
  runtimeConnected,
  onClose,
  onOpenHub,
}: {
  readonly target: SubagentHubTarget;
  readonly preview: boolean;
  readonly client: SubagentConversationClient | null;
  readonly runtimeConnected: boolean;
  readonly onClose: () => void;
  readonly onOpenHub: (agentId: string) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const snapshot = useSubagentConversation({
    preview,
    client,
    target,
    runtimeConnected,
  });
  const scroll = useConversationScroll({
    scrollerRef,
    identityKey: snapshot.identityKey,
    itemCount: snapshot.rows.length,
    loadingOlder: snapshot.loadingOlder,
  });
  const prevLoading = useRef(snapshot.loadingOlder);
  useEffect(() => {
    if (!prevLoading.current && snapshot.loadingOlder) scroll.preparePrepend();
    prevLoading.current = snapshot.loadingOlder;
  }, [snapshot.loadingOlder, scroll]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, [target.agentId, target.toolCallId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (root === null) return;
      const nodes = focusablesOf(root);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { state } = snapshot;
  return (
    <div className="sa-inspect-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="sa-inspect"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sa-inspect-head">
          <div className="sa-inspect-title-wrap">
            <h2 id={titleId} className="sa-inspect-title">{target.task ?? target.agentId}</h2>
            <p className="muted small">{target.agentId}</p>
          </div>
          {preview ? <span className="chip gray xs">演示</span> : null}
          <button type="button" className="btn small outline" onClick={() => onOpenHub(target.agentId)}>
            前往 Agent Hub
          </button>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="关闭子 Agent 对话" onClick={onClose}>
            <Icon name="x" extra="sm" />
          </button>
        </header>
        <section
          className="sa-inspect-scroll"
          ref={scrollerRef}
          tabIndex={-1}
          aria-label="子 Agent 对话"
          onScroll={scroll.onScroll}
        >
          <div className="sa-inspect-doc" role="log" aria-live="off">
            {state.hydrateStatus === "error" && state.error !== undefined ? (
              <div className="convo-notice error" role="alert">{state.error.message}</div>
            ) : null}
            {state.hydrateStatus === "unavailable" && state.unavailableReason !== undefined ? (
              <div className="empty" style={{ paddingTop: 48 }}>
                <p>{state.unavailableReason}</p>
              </div>
            ) : null}
            {state.hasMoreBefore && state.hydrateStatus === "ready" ? (
              <div className="convo-load-earlier">
                <button type="button" className="btn small outline" disabled={snapshot.loadingOlder} onClick={snapshot.loadOlder}>
                  {snapshot.loadingOlder ? "正在加载更早消息…" : "加载更早消息"}
                </button>
              </div>
            ) : null}
            {snapshot.rows.length === 0 && state.hydrateStatus === "loading" ? (
              <div className="empty" style={{ paddingTop: 48 }}>
                <span className="spinner" aria-hidden="true" />
                <p>正在读取子 Agent 对话…</p>
              </div>
            ) : (
              <ConvoTranscript rows={snapshot.rows} {...(snapshot.demo ? { demo: true } : {})} />
            )}
            {state.hydrateStatus === "resyncing" ? (
              <div className="convo-notice info" role="status">正在同步</div>
            ) : null}
          </div>
        </section>
        {scroll.hasNewContent ? (
          <button type="button" className="new-content-pill" onClick={scroll.jumpToLatest}>
            有新内容 · 回到最新
          </button>
        ) : null}
      </div>
    </div>
  );
}
