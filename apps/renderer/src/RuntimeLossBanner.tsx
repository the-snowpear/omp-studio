import { useCallback, useState } from "react";
import type { RuntimeConnection, StudioClient } from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { ActionProgressBar, type ActionProgress } from "./ActionProgressBar";
import {
  formatRuntimeAutoRespawnCopy,
  formatRuntimeDisconnectCopy,
  formatRuntimeUnavailableCopy,
  runtimeCanReconnect,
} from "./diagnosticsModel";
import { ensureRuntimeConnection } from "./runtimeEnsure";
import { usePreviewMode } from "./preview/PreviewContext";

export function RuntimeLossBanner({
  runtime,
  preview = false,
  client,
  variant = "workbench",
  floating = false,
  onOpenDiagnostics,
}: {
  runtime?: RuntimeConnection;
  preview?: boolean;
  client?: StudioClient;
  variant?: "workbench" | "hub";
  /** 工作台里浮在对话区顶部，不占布局高度。 */
  floating?: boolean;
  onOpenDiagnostics?: () => void;
}) {
  const { marks } = usePreviewMode();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ActionProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reconnect = useCallback(async () => {
    if (preview) {
      setMessage(marks ? "已重新连接 Runtime（演示）" : "Runtime 已重新连接");
      return;
    }
    if (client === undefined) {
      setMessage("当前环境无法重新连接 Runtime");
      return;
    }
    setBusy(true);
    setMessage(null);
    setProgress({ label: "正在请求连接", step: 1, steps: 2 });
    const result = await ensureRuntimeConnection(client, {}, setProgress);
    setMessage(result.ok ? "Runtime 已重新连接" : result.message);
    setBusy(false);
    setProgress(null);
  }, [client, marks, preview]);

  const floatClass = floating && variant === "workbench" ? " is-floating" : "";
  const status = runtime?.status ?? "unavailable";
  if (status === "connecting") {
    return <div className={`${variant === "hub" ? "hub-conn" : "banner"}${floatClass}`} role="status" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      <span>Runtime 正在准备，工作台已可用；连接完成后即可发送消息。</span>
    </div>;
  }
  if (status !== "disconnected" && status !== "unavailable") {
    return null;
  }

  // Every real failure records an unavailableCode. Unavailable with no facts is
  // a conversation that has not attached a Runtime yet (an opened history or
  // dormant project): it starts on the first send, so it is not a loss.
  const dormant = status === "unavailable" && runtime?.unavailableCode === undefined && runtime?.unavailableReason === undefined;
  const copy = dormant
    ? { title: "Runtime 未启动", detail: "发送消息时会自动连接，也可以现在连接。" }
    : status === "disconnected"
      ? formatRuntimeDisconnectCopy(runtime?.disconnectCode, runtime?.disconnectReason)
      : formatRuntimeUnavailableCopy(runtime?.unavailableCode, runtime?.unavailableReason);
  const actionMessage = message !== null && !copy.detail.includes(message) ? message : null;
  const auto = runtime?.autoRespawn === undefined ? undefined : formatRuntimeAutoRespawnCopy(runtime.autoRespawn);
  const canReconnect = runtimeCanReconnect(runtime);
  const tone = dormant ? "blue" : "red";
  const className = `${variant === "hub" ? `hub-conn ${tone}` : `banner ${tone}`}${busy ? " is-busy" : ""}${floatClass}`;
  const detailClass = variant === "hub" ? "hc-detail" : "banner-detail";
  const actionsClass = variant === "hub" ? "hc-actions" : "banner-actions";
  const copyClass = variant === "hub" ? "hc-copy" : undefined;

  return (
    <div className={className} role={dormant ? "status" : "alert"} aria-busy={busy || undefined}>
      <Icon name={dormant ? "info" : "alert"} extra="sm" />
      <span className={copyClass}>
        <b>{copy.title}</b>
        {" · "}
        <span className={detailClass}>
          {copy.detail}
          {auto === undefined ? "" : ` ${auto}。`}
          {actionMessage === null ? "" : ` ${actionMessage}`}
        </span>
      </span>
      <span className={actionsClass}>
        {canReconnect ? (
          <button type="button" className="btn small outline" disabled={busy} onClick={() => void reconnect()}>
            {busy ? "正在连接…" : dormant ? "立即连接" : "重新连接"}
          </button>
        ) : null}
        {onOpenDiagnostics ? (
          <button type="button" className="btn small outline" onClick={onOpenDiagnostics}>
            诊断中心
          </button>
        ) : null}
      </span>
      {progress !== null ? (
        <ActionProgressBar compact label={progress.label} step={progress.step} steps={progress.steps} />
      ) : null}
    </div>
  );
}
