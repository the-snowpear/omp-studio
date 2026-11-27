import { useState } from "react";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import "./ptyWaitNotice.css";

export type PtyInputWait = NonNullable<OperatorStateSnapshot["ptyInputWaits"]>[number];

/** A console can wait without a job or a shell trace; the native snapshot owns this status. */
export function PtyWaitNotice({ waits, sessionId, onReveal }: {
  waits: readonly PtyInputWait[] | undefined;
  sessionId: string | undefined;
  onReveal: (toolCallId: string) => Promise<boolean>;
}) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const [locating, setLocating] = useState<string>();
  const [missing, setMissing] = useState<string>();
  const waiting = waits?.filter(row => row.waiting && row.sessionId === sessionId) ?? [];
  if (!waiting.length) return null;
  return <section className="pty-wait-notice" aria-label={zh ? "终端等待输入" : "Console waiting for input"}>
    {waiting.map(row => {
      const key = `${row.sessionId}:${row.toolCallId}`;
      return <div className="pty-wait-row" key={key}>
        <Icon name="terminal" extra="sm" />
        <div className="pty-wait-copy">
          <div className="pty-wait-label" role="status"><strong>{zh ? "终端正在等待输入" : "Console waiting for input"}</strong>
            {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
          </div>
          <code>{row.command}</code>
          {missing === key ? <p role="status">{zh ? "对应命令尚未载入当前对话。" : "The source command is not loaded in this conversation yet."}</p> : null}
        </div>
        <button type="button" className="btn small outline" disabled={locating === key} onClick={async () => {
          setLocating(key); setMissing(undefined);
          const found = await onReveal(row.toolCallId);
          setMissing(found ? undefined : key); setLocating(undefined);
        }}>{locating === key ? zh ? "正在定位…" : "Locating…" : zh ? "查看命令" : "View command"}</button>
      </div>;
    })}
  </section>;
}
