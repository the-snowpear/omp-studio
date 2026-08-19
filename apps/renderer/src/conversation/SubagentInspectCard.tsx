import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SessionId } from "@omp-studio/client-contract";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import type { MentionCandidate } from "../composer/types";
import { Icon } from "../icons";
import { SubagentConversationPane } from "./SubagentConversationPane";
import { SubagentMetrics, resolveSubagentMetrics } from "./SubagentMetrics";
import { findSubagentComposerAgent, subagentComposerVisible } from "./subagentComposerGate";
import type { SubagentComposerClient } from "./useSubagentComposer";
import type { SubagentConversationClient } from "./subagentConversationEngine";
import type { SubagentHubTarget } from "./toolMeta";

function focusablesOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )].filter((node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true");
}

/** 与 `.sa-inspect.is-leave` 的 `--dur-dock-genie-leave` 对齐；超时略加缓冲以免末帧被卸掉。 */
export const SA_INSPECT_LEAVE_MS = 260;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SubagentInspectCard({
  target,
  preview,
  client,
  sendClient,
  agents,
  canSend,
  runtimeConnected,
  parentSessionId,
  liveSessionId,
  pendingInteraction,
  workspaceId,
  loadMentions,
  onClose,
  onOpenHub,
}: {
  readonly target: SubagentHubTarget;
  readonly preview: boolean;
  readonly client: SubagentConversationClient | null;
  readonly sendClient: SubagentComposerClient | null;
  readonly agents: readonly StudioAgentSnapshot[];
  readonly canSend: boolean;
  readonly runtimeConnected: boolean;
  readonly parentSessionId?: SessionId;
  readonly liveSessionId?: SessionId;
  readonly pendingInteraction?: boolean;
  readonly workspaceId?: string;
  readonly loadMentions?: (trigger: "@" | "/", query: string) => Promise<readonly MentionCandidate[]>;
  readonly onClose: () => void;
  readonly onOpenHub: (agentId: string) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const leavingRef = useRef(false);
  const leaveTimerRef = useRef<number | undefined>(undefined);
  const [leaving, setLeaving] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback((after?: () => void) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const finish = () => {
      leaveTimerRef.current = undefined;
      after?.();
      onCloseRef.current();
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    setLeaving(true);
    leaveTimerRef.current = window.setTimeout(finish, SA_INSPECT_LEAVE_MS + 24);
  }, []);
  useEffect(() => () => {
    if (leaveTimerRef.current !== undefined) window.clearTimeout(leaveTimerRef.current);
  }, []);
  const agent = findSubagentComposerAgent(agents, target.agentId);
  const composerAllowed = subagentComposerVisible({
    preview,
    runtimeConnected,
    hasClient: sendClient !== null,
    canSend,
    agent,
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!composerAllowed) closeRef.current?.focus({ preventScroll: true });
    return () => {
      previous?.focus({ preventScroll: true });
    };
  }, [composerAllowed, target.agentId, target.toolCallId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
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
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const onDown = (event: MouseEvent) => {
      const root = dialogRef.current;
      if (root === null) return;
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (root.contains(node)) return;
      if (node instanceof Element && node.closest(".img-preview-backdrop, .img-preview-dialog") !== null) return;
      requestClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [requestClose]);

  const metrics = resolveSubagentMetrics(agent?.usage, target);
  return (
    <>
      <div className={`sa-inspect-dim${leaving ? " is-leave" : ""}`} aria-hidden="true" />
      <div
        ref={dialogRef}
        className={`sa-inspect${composerAllowed ? " has-composer" : ""}${leaving ? " is-leave" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
      <header className="sa-inspect-head">
        <div className="sa-inspect-title-wrap">
          <h2 id={titleId} className="sa-inspect-title">{target.task ?? target.agentId}</h2>
          <p className="muted small">{target.agentId}</p>
        </div>
        <SubagentMetrics {...metrics} />
        {preview ? <span className="chip gray xs">演示</span> : null}
        <button type="button" className="btn small outline" onClick={() => requestClose(() => onOpenHub(target.agentId))}>
          前往 Agent Hub
        </button>
        <button ref={closeRef} type="button" className="icon-btn" aria-label="关闭子 Agent 对话" onClick={() => requestClose()}>
          <Icon name="x" extra="sm" />
        </button>
      </header>
      <SubagentConversationPane
        target={target}
        preview={preview}
        client={client}
        sendClient={sendClient}
        agents={agents}
        canSend={canSend}
        runtimeConnected={runtimeConnected}
        {...(parentSessionId === undefined ? {} : { parentSessionId })}
        {...(liveSessionId === undefined ? {} : { liveSessionId })}
        {...(pendingInteraction === undefined ? {} : { pendingInteraction })}
        composerId="saInspectComposer"
        autoFocusComposer={composerAllowed}
        {...(workspaceId === undefined ? {} : { workspaceId })}
        {...(loadMentions === undefined ? {} : { loadMentions })}
      />
      </div>
    </>
  );
}
