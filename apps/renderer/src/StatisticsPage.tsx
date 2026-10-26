import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_STATS_TOTALS } from "./preview/fixtures";
import { useI18n } from "./i18n";
import { hostErrorMessage } from "./hostError";

type Phase = "loading" | "ready" | "unavailable";

/**
 * Native statistics page.
 *
 * Everything below the shell's tab bar is the upstream `omp stats` dashboard
 * itself, embedded from its loopback origin. It already ships every section,
 * drill-down and trace view, and it carries its own range switcher and sync
 * button, so this page deliberately adds no toolbar of its own: a second set of
 * controls would drift from the panel and duplicate what is already on screen.
 *
 * Studio only owns the two states the embed cannot express — while the panel is
 * starting, and when no panel could be reached at all.
 *
 * Preview mode never fakes the embed: an iframe pointed at a fabricated URL
 * would claim a local service exists when it does not. Preview shows demo
 * aggregates and says so.
 */
export function StatisticsPage({ client }: { client: StudioClient }) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [phase, setPhase] = useState<Phase>("loading");
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState(0);
  const framedRef = useRef(false);

  useEffect(() => {
    if (preview) return;
    let active = true;
    setPhase("loading");
    setReason("");
    framedRef.current = false;
    void (async () => {
      try {
        const result = await client.query("stats.dashboard", {});
        if (!active) return;
        if (result.available && result.url !== undefined) {
          setUrl(result.url);
          return;
        }
        setPhase("unavailable");
        setReason(result.reason ?? (zh ? "本机统计面板不可用。" : "The local statistics panel is unavailable."));
      } catch (cause) {
        if (!active) return;
        setPhase("unavailable");
        setReason(hostErrorMessage(cause, zh ? "统计面板不可用" : "Statistics panel unavailable"));
      }
    })();
    return () => {
      active = false;
    };
  }, [client, preview, attempt, zh]);

  // A load event also fires for the panel's own error document, so the frame is
  // only trusted once a probe confirms the server still answers.
  const onFrameLoad = useCallback(() => {
    if (framedRef.current) return;
    framedRef.current = true;
    void (async () => {
      try {
        const result = await client.query("stats.dashboard", {});
        setPhase(result.available ? "ready" : "unavailable");
        if (!result.available) setReason(result.reason ?? "");
      } catch {
        setPhase("unavailable");
      }
    })();
  }, [client]);

  const openExternal = useCallback(() => {
    void client.command("usage.openDashboard", {});
  }, [client]);

  if (preview) {
    const demo = PREVIEW_STATS_TOTALS;
    return (
      <div className="stats-page">
        <p className="stats-demo-note">
          {zh
            ? "统计面板由本机 OMP Runtime 提供，需关闭预览后查看；下面是演示汇总。"
            : "The statistics panel is served by the local OMP Runtime. Turn preview off to view it; demo aggregates follow."}
        </p>
        <div className="stats-demo">
          <div className="stats-demo-cell"><span className="l">Tokens</span><span className="v">{demo.tokens.toLocaleString()}</span></div>
          <div className="stats-demo-cell"><span className="l">{zh ? "请求" : "Requests"}</span><span className="v">{demo.requests.toLocaleString()}</span></div>
          <div className="stats-demo-cell"><span className="l">{zh ? "错误" : "Errors"}</span><span className="v">{demo.errors.toLocaleString()}</span></div>
          <div className="stats-demo-cell"><span className="l">{zh ? "API 等价估算" : "API-equivalent"}</span><span className="v">{`$${demo.costEstimate.toFixed(2)}`}</span></div>
        </div>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className="stats-page">
        <div className="stats-fallback">
          <p className="stats-fallback-title">{zh ? "无法连接本机统计面板" : "Cannot reach the local statistics panel"}</p>
          <p className="stats-fallback-detail">{reason}</p>
          <div className="stats-fallback-actions">
            <button type="button" className="btn small" onClick={() => setAttempt(n => n + 1)}>{zh ? "重试" : "Retry"}</button>
            <button type="button" className="btn small outline" onClick={openExternal}>{zh ? "在浏览器打开" : "Open in browser"}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stats-page">
      <div className="stats-frame">
        <iframe
          className="stats-frame-body"
          src={url}
          title={zh ? "OMP 统计面板" : "OMP statistics panel"}
          onLoad={onFrameLoad}
        />
        {phase === "loading" ? (
          <div className="stats-overlay">
            <span className="stats-spinner" aria-hidden="true" />
            <p className="stats-overlay-title">{zh ? "正在连接本机统计面板" : "Connecting to the local statistics panel"}</p>
            <p className="stats-overlay-detail">
              {zh ? "首次进入需要启动统计数据服务，通常几秒内完成。" : "The first visit starts the statistics service; this usually takes a few seconds."}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
