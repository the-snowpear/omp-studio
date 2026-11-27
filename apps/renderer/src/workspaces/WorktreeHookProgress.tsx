import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { WorktreeHookStatus } from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewWorktreeHook } from "../preview/sessionWorktreesPreview";
import { Callout, StatePill } from "./StatusBits";

export function WorktreeHookProgress({ client, sessionId, supported, visible, busy }: {
  client?: StudioClient | undefined; sessionId?: string | undefined; supported: boolean; visible: boolean; busy: boolean;
}) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [status, setStatus] = useState<WorktreeHookStatus>();
  useEffect(() => {
    setStatus(undefined);
    if (!visible) return;
    if (preview) { setStatus(previewWorktreeHook(zh)); return; }
    if (!supported || !client || !sessionId) return;
    let alive = true, reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const command = await client.command("worktrees.session.hookStatus", { sessionId });
        const result = (await waitReceipt<{ result: WorktreeHookStatus }>(client, command.requestId)).result;
        if (alive) setStatus(result);
      } catch { /* The worktree action reports its own failure. */ }
      finally { reading = false; }
    };
    void read(); const timer = busy ? setInterval(() => void read(), 750) : undefined;
    return () => { alive = false; clearInterval(timer); };
  }, [client, sessionId, supported, visible, busy, preview, zh]);
  if (!status || status.state === "idle") return null;
  const running = status.state === "running", succeeded = status.state === "succeeded";
  const added = [...(status.refreshed?.addedSkills ?? []).map(item => ({ ...item, kind: "skill" as const })), ...(status.refreshed?.addedCommands ?? []).map(item => ({ ...item, kind: "command" as const }))];
  return <section className="worktree-hook" data-state={status.state} aria-live="polite" aria-label={zh ? "工作树初始化" : "Worktree initialization"}>
    <span className="worktree-hook-mark" aria-hidden>{running ? <i className="worktree-hook-spinner" /> : <Icon name={succeeded ? "check" : "alert"} extra="sm" />}</span>
    <div className="worktree-hook-body">
      <div className="worktree-hook-title">
        <strong>{zh ? "初始化 Worktree" : "Worktree setup"}</strong>
        <code>post-checkout</code>
        <StatePill tone={running ? "active" : succeeded ? "ready" : "warn"}>{running ? zh ? "正在运行" : "Running" : succeeded ? zh ? "已完成" : "Completed" : zh ? "有警告" : "Warning"}</StatePill>
        {status.durationMs !== undefined ? <span className="worktree-hook-time">{(status.durationMs / 1000).toFixed(1)} s</span> : null}
      </div>
      {running ? <div className="worktree-hook-track" role="progressbar" aria-label={zh ? "运行 post-checkout 钩子并刷新能力" : "Running post-checkout and refreshing capabilities"}><i /></div> : null}
      {status.refreshed ? <p className="worktree-hook-summary">{status.branch ? <><Icon name="branch" extra="sm" /><code>{status.branch}</code><span aria-hidden>·</span></> : null}{zh ? `已发现 ${status.refreshed.skillsCount} 个 Skills · ${status.refreshed.commandsCount} 个命令` : `${status.refreshed.skillsCount} skills · ${status.refreshed.commandsCount} commands discovered`}</p> : null}
      {added.length ? <div className="worktree-hook-items" aria-label={zh ? "此 Worktree 新增" : "New in this worktree"}>
        <span className="worktree-hook-items-label">{zh ? "新增" : "New"}</span>
        {added.map(item => <span className="worktree-hook-item" key={`${item.kind}:${item.source}:${item.name}`} data-kind={item.kind} data-tip={item.description || item.source}><Icon name={item.kind === "skill" ? "sparkles" : "command"} extra="sm" />{item.name}</span>)}
      </div> : null}
      {status.warnings.map((warning, index) => <Callout tone="warn" key={index} className="worktree-hook-warning">{warning}</Callout>)}
    </div>
  </section>;
}
