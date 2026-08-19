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

export function RuntimeLossBanner({
  runtime,
  preview = false,
  client,
  variant = "workbench",
  onOpenDiagnostics,
}: {
  runtime?: RuntimeConnection;
  preview?: boolean;
  client?: StudioClient;
  variant?: "workbench" | "hub";
  onOpenDiagnostics?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ActionProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reconnect = useCallback(async () => {
    if (preview) {
      setMessage("已重新连接 Runtime（演示）");
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
  }, [client, preview]);

  const status = runtime?.status ?? "unavailable";
  if (status !== "disconnected" && status !== "unavailable") {
    return null;
  }

  const copy = status === "disconnected"
    ? formatRuntimeDisconnectCopy(runtime?.disconnectCode, runtime?.disconnectReason)
    : formatRuntimeUnavailableCopy(runtime?.unavailableCode, runtime?.unavailableReason);
  const auto = runtime?.autoRespawn === undefined ? undefined : formatRuntimeAutoRespawnCopy(runtime.autoRespawn);
  const canReconnect = runtimeCanReconnect(runtime);
  const className = `${variant === "hub" ? "hub-conn red" : "banner red"}${busy ? " is-busy" : ""}`;
  const detailClass = variant === "hub" ? "hc-detail" : "banner-detail";
  const actionsClass = variant === "hub" ? "hc-actions" : "banner-actions";
  const copyClass = variant === "hub" ? "hc-copy" : undefined;

  return (
    <div className={className} role="alert" aria-busy={busy || undefined}>
      <Icon name="alert" extra="sm" />
      <span className={copyClass}>
        <b>{copy.title}</b>
        {" · "}
        <span className={detailClass}>
          {copy.detail}
          {auto === undefined ? "" : ` ${auto}。`}
          {message === null ? "" : ` ${message}`}
        </span>
      </span>
      <span className={actionsClass}>
        {canReconnect ? (
          <button type="button" className="btn small outline" disabled={busy} onClick={() => void reconnect()}>
            {busy ? "正在连接…" : "重新连接"}
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
