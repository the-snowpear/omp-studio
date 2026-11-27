import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { WorktreeHookStatus } from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewWorktreeHook } from "../preview/sessionWorktreesPreview";

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
  return <section className="worktree-hook" aria-live="polite" aria-label={zh ? "工作树初始化" : "Worktree initialization"}>
    <div className="feature-actions"><strong>post-checkout</strong><span className={`chip xs ${status.state === "running" ? "blue" : status.state === "succeeded" ? "green" : "amber"}`}>
      {status.state === "running" ? zh ? "正在运行" : "Running" : status.state === "succeeded" ? zh ? "已完成" : "Completed" : zh ? "有警告" : "Warning"}
    </span>{status.durationMs !== undefined ? <span className="small muted">{(status.durationMs / 1000).toFixed(1)} s</span> : null}</div>
    {status.state === "running" ? <progress aria-label={zh ? "运行 post-checkout 钩子并刷新能力" : "Running post-checkout and refreshing capabilities"} /> : null}
    {status.refreshed ? <p className="small muted">{zh ? `已发现 ${status.refreshed.skillsCount} 个 Skills · ${status.refreshed.commandsCount} 个命令` : `${status.refreshed.skillsCount} skills · ${status.refreshed.commandsCount} commands discovered`}</p> : null}
    {status.refreshed?.addedSkills.length || status.refreshed?.addedCommands.length ? <div className="worktree-hook-items">{[...status.refreshed.addedSkills, ...status.refreshed.addedCommands].map(item => <span className="chip gray xs" key={`${item.source}:${item.name}`} data-tip={item.description}>{item.name}</span>)}</div> : null}
    {status.warnings.map((warning, index) => <p className="worktree-hook-warning" key={index}>{warning}</p>)}
  </section>;
}
