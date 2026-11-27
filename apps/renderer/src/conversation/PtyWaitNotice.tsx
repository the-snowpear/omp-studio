import { useState } from "react";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import type { StudioClient } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import "./ptyWaitNotice.css";
import { JobInspector } from "./JobInspector";
import { previewPtyInspection } from "../preview/ptyWaitPreview";

export type PtyInputWait = NonNullable<OperatorStateSnapshot["ptyInputWaits"]>[number];

/** A console can wait without a job or a shell trace; the native snapshot owns this status. */
export function PtyWaitNotice({ waits, sessionId, onReveal, client, available = true }: {
  waits: readonly PtyInputWait[] | undefined;
  sessionId: string | undefined;
  client?: StudioClient | undefined;
  available?: boolean;
  onReveal: (toolCallId: string, wait: PtyInputWait) => Promise<boolean>;
}) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const waiting = waits?.filter(row => row.waiting && row.sessionId === sessionId) ?? [];
  if (!waiting.length) return null;
  return <section className="pty-wait-notice" aria-label={zh ? "终端等待输入" : "Console waiting for input"}>
    {waiting.map(row => <PtyWaitRow key={`${preview}:${row.sessionId}:${row.toolCallId}:${row.jobId ?? ""}:${row.jobGeneration ?? ""}`} row={row} client={client} available={available} onReveal={onReveal} />)}
  </section>;
}

function PtyWaitRow({ row, client, available, onReveal }: { row: PtyInputWait; client: StudioClient | undefined; available: boolean; onReveal: (toolCallId: string, wait: PtyInputWait) => Promise<boolean> }) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const [locating, setLocating] = useState(false), [missing, setMissing] = useState(false), [expanded, setExpanded] = useState(false);
  return <div className="pty-wait-entry"><div className="pty-wait-row">
        <Icon name="terminal" extra="sm" />
        <div className="pty-wait-copy">
          <div className="pty-wait-label" role="status"><strong>{zh ? "终端正在等待输入" : "Console waiting for input"}</strong>
            {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
          </div>
          <code>{row.command}</code>
          {missing ? <p role="status">{zh ? "对应命令尚未载入当前对话。" : "The source command is not loaded in this conversation yet."}</p> : null}
        </div>
        <div className="pty-wait-actions"><button type="button" className="btn small outline" disabled={locating} onClick={async () => {
          setLocating(true); setMissing(false);
          const found = await onReveal(row.toolCallId, row);
          setMissing(!found); setLocating(false);
        }}>{locating ? zh ? "正在定位…" : "Locating…" : zh ? "查看命令" : "View command"}</button>
        {row.jobId ? <button type="button" className="btn small primary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? zh ? "关闭终端" : "Close console" : zh ? "打开终端" : "Open console"}</button> : null}</div>
      </div>
      {expanded && row.jobId ? <JobInspector job={{ id: row.jobId, label: row.command, status: "running", generation: row.jobGeneration ?? 0 }} client={client} sessionId={row.sessionId} available={available} onClose={() => setExpanded(false)} embedded presentation="process" scopeKey={`${row.sourceSessionId ?? row.sessionId}:${row.ownerAgentId ?? ""}`} {...(preview ? { previewInspection: previewPtyInspection(row.jobId, row.jobGeneration) } : {})} /> : null}
  </div>;
}
