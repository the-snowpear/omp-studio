import "./shellView.css";
import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { PromptCacheStatus } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_PROMPT_CACHE } from "../preview/runtimeViewsPreview";
import { useI18n } from "../i18n";

export function PromptCachePanel({ client, sessionId, visible }: { client: StudioClient; sessionId?: string | undefined; visible: boolean }) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [cache, setCache] = useState<PromptCacheStatus | null>();
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    setCache(preview ? PREVIEW_PROMPT_CACHE : undefined);
    const read = async () => {
      if (document.hidden) { if (alive) timer = setTimeout(() => void read(), 5000); return; }
      try { const result = await client.query("session.cache.get", { sessionId: sessionId! }); if (alive) setCache(result.cache); }
      catch { if (alive) setCache(null); }
      finally { if (alive) timer = setTimeout(() => void read(), 5000); }
    };
    if (visible && sessionId && !preview) void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [client, sessionId, visible, preview]);
  if (!cache) return null;
  const reasons: Record<string, string> = zh ? { expired: "已到期", model: "模型改变", thinking: "推理档位改变", tools: "工具定义改变", "system-prompt": "系统提示词改变", retention: "保留策略改变", compaction: "上下文已压缩", "refresh-missed": "保温未命中" } : {};
  const resent = cache.state === "cold" ? cache.nextTokens : Math.max(0, cache.nextTokens - cache.cachedTokens);
  return <details className="context-cache"><summary><span className={`chip ${cache.state === "warm" ? "green" : "gray"} xs`}>{cache.state === "warm" ? zh ? "缓存可用" : "Cache warm" : zh ? "缓存未命中" : "Cache cold"}</span><span>{cache.cachedTokens.toLocaleString()} tokens</span></summary><p>{cache.reason ? reasons[cache.reason.kind] ?? cache.reason.kind : zh ? "下次请求可复用前缀" : "The next request can reuse its prefix"}{cache.inferred ? zh ? " · 从历史估计" : " · Inferred from history" : ""}</p><p>{zh ? "预计重发" : "Estimated resend"} · {resent.toLocaleString()} tokens{cache.ttlMs !== undefined ? ` · ${zh ? "有效期" : "Retention"} ${Math.round(cache.ttlMs / 60000)} min` : ""}</p></details>;
}
