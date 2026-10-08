import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type {
  SessionSpeedState,
  StudioSpeed,
} from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_SPEED } from "../preview/sessionOptionsPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import "./composerSpeed.css";
export function ComposerSpeedControl({
  client,
  sessionId,
  modelSelector,
  available, previewSelected, onPreviewChange,
}: {
  client: StudioClient;
  sessionId?: string | undefined;
  modelSelector?: string | undefined;
  available: boolean;
  previewSelected?: StudioSpeed;
  onPreviewChange?: (value: StudioSpeed) => void;
}) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [speed, setSpeed] = useState<SessionSpeedState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<StudioSpeed>();
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const epoch = ++generation.current;
    lock.current = false;
    setSpeed(
      preview
        ? { ...PREVIEW_SPEED, supported: [...PREVIEW_SPEED.supported], selected: previewSelected ?? "normal", fastActive: previewSelected === "fast" || previewSelected === "ultrafast", slowEnabled: previewSelected === "slow" }
        : undefined,
    );
    setBusy(false);
    setError("");
    setConfirm(undefined);
    if (!preview && available && sessionId)
      void (async () => {
        const handle = await client.command("session.speed.get", { sessionId });
        const response = await waitReceipt<{ result: SessionSpeedState }>(
          client,
          handle.requestId,
        );
        if (epoch === generation.current) setSpeed(response.result);
      })().catch((cause) => {
        if (epoch === generation.current)
          setError(
            hostErrorMessage(
              cause,
              zh ? "无法读取服务档位" : "Cannot read service speed",
            ),
          );
      });
    return () => {
      generation.current++;
    };
  }, [client, sessionId, modelSelector, available, preview, zh, previewSelected]);
  async function apply(value: StudioSpeed) {
    if (
      !speed?.model ||
      lock.current ||
      (!preview && (!available || !sessionId))
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    const epoch = generation.current;
    try {
      if (preview) {
        onPreviewChange?.(value);
        setSpeed({
          ...speed,
          selected: value,
          fastActive: value === "fast" || value === "ultrafast",
          slowEnabled: value === "slow",
        });
      } else {
        const handle = await client.command("session.speed.set", {
          sessionId: sessionId!,
          expectedModel: speed.model,
          speed: value,
        });
        const response = await waitReceipt<{ result: SessionSpeedState }>(
          client,
          handle.requestId,
        );
        if (epoch === generation.current) setSpeed(response.result);
      }
      if (epoch === generation.current) setConfirm(undefined);
    } catch (cause) {
      if (epoch === generation.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "服务档位未更改" : "Service speed was not changed",
          ),
        );
    } finally {
      if (epoch === generation.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const labels: Record<StudioSpeed, string> = {
    normal: "Normal",
    fast: "Fast",
    ultrafast: "Ultrafast",
    slow: "Slow",
  };
  return (
    <div className="composer-speed">
      <label className="composer-speed-row">
        <span className="am-label">{zh ? "服务档位" : "Service speed"}</span>
        <select
          className="select"
          aria-label={zh ? "服务档位" : "Service speed"}
          value={speed?.selected ?? "normal"}
          disabled={busy || !speed || (!preview && !available)}
          onChange={(event) => {
            const value = event.target.value as StudioSpeed;
            if (
              speed?.slowScope === "global" &&
              (value === "slow" || speed.slowEnabled)
            )
              setConfirm(value);
            else void apply(value);
          }}
        >
          {(speed?.supported ?? ["normal"]).map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </select>
      </label>
      <p className="am-desc">
        {zh
          ? "仅列出当前模型支持的档位；高优先级请求可能增加用量费用。"
          : "Only supported tiers are shown. Higher-priority requests may cost more."}
      </p>
      {speed?.usageLimit ? (
        <p role="status" className="am-desc">
          {speed.usageLimit.stage === "wrap_up"
            ? zh
              ? "额度接近耗尽，正在收尾"
              : "Quota reached: wrapping up"
            : zh
              ? "当前使用低优先级额度"
              : "Using low-priority allowance"}
          {speed.usageLimit.resetsAtSec
            ? " · " +
              new Date(speed.usageLimit.resetsAtSec * 1000).toLocaleString()
            : ""}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {confirm ? (
        <div
          role="dialog"
          aria-label={zh ? "确认账户速度策略" : "Confirm account speed policy"}
        >
          <p>
            {zh
              ? "此 Slow 策略作用于原生全局配置，确认切换到"
              : "This Slow policy changes native global configuration. Switch to"}{" "}
            {labels[confirm]}?
          </p>
          <button
            className="btn small primary"
            disabled={busy}
            onClick={() => void apply(confirm)}
          >
            {zh ? "确认" : "Confirm"}
          </button>
          <button
            className="btn small outline"
            disabled={busy}
            onClick={() => setConfirm(undefined)}
          >
            {zh ? "取消" : "Cancel"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
