import {
  PREVIEW_SPEED,
  PREVIEW_WARMING,
} from "../preview/sessionOptionsPreview";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  CommandInput,
  StudioClient,
} from "@omp-studio/client-contract";
import type {
  SessionOptionsResultMap,
  SessionSpeedState,
  SessionWarmingState,
  StudioSpeed,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { SourceBadge } from "../settings/SettingRow";
import { WorkspaceStatus } from "../workspaces/Workspace";
import "./sessionOptions.css";

export type SessionOptionsProps = {
  client: StudioClient;
  sessionId?: string | undefined;
  available: boolean;
  visible?: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
};
export function SessionOptionsPane({
  client,
  sessionId,
  available,
  visible = true,
  capabilities,
}: SessionOptionsProps) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const warmingLabel = (mode: SessionWarmingState["mode"]) =>
    mode === "off"
      ? zh
        ? "关闭"
        : "Off"
      : mode === "streaming"
        ? zh
          ? "执行期间"
          : "During runs"
        : zh
          ? "执行与空闲期间"
          : "During runs and idle";
  const [speed, setSpeed] = useState<SessionSpeedState>();
  const [warming, setWarming] = useState<SessionWarmingState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [persist, setPersist] = useState(false);
  const [confirm, setConfirm] = useState<
    | { speed: StudioSpeed; expectedModel: string }
    | { mode: SessionWarmingState["mode"]; persist: boolean }
  >();
  const epoch = useRef(0);
  const lock = useRef(false);
  const supports = (id: string) =>
    preview ||
    capabilities?.capabilities.some(
      (item) => item.id === id && item.grade !== "unavailable",
    ) === true;
  const enabled =
    preview ||
    (available &&
      !!sessionId &&
      supports("session.speed.get") &&
      supports("session.warming.get"));
  const invoke = useCallback(
    async <K extends keyof SessionOptionsResultMap>(
      kind: K,
      input: CommandInput<K>,
    ): Promise<SessionOptionsResultMap[K]> => {
      const handle = await client.command(kind, input);
      return (
        await waitReceipt<{ result: SessionOptionsResultMap[K] }>(
          client,
          handle.requestId,
        )
      ).result;
    },
    [client],
  );
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setBusy(false);
    setError("");
    setConfirm(undefined);
    setSpeed(preview ? structuredClone(PREVIEW_SPEED) : undefined);
    setWarming(preview ? structuredClone(PREVIEW_WARMING) : undefined);
    return () => {
      epoch.current++;
    };
  }, [preview, sessionId]);
  useEffect(() => {
    if (preview || !visible || !enabled || !sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!document.hidden && !lock.current) {
          const [nextSpeed, nextWarming] = await Promise.all([
            invoke("session.speed.get", { sessionId }),
            invoke("session.warming.get", { sessionId }),
          ]);
          if (active) {
            setSpeed(nextSpeed);
            setWarming(nextWarming);
            setError("");
          }
        }
      } catch (cause) {
        if (active)
          setError(
            hostErrorMessage(
              cause,
              zh ? "会话选项读取失败" : "Session controls unavailable",
            ),
          );
      } finally {
        if (active) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [preview, visible, enabled, sessionId, invoke, zh]);
  const apply = async (change: NonNullable<typeof confirm>) => {
    if (lock.current || !enabled) return;
    const generation = epoch.current;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (preview) {
        if ("speed" in change)
          setSpeed((value) =>
            value
              ? {
                  ...value,
                  selected: change.speed,
                  fastActive: change.speed === "fast",
                  slowEnabled: change.speed === "slow",
                }
              : value,
          );
        else
          setWarming({
            mode: change.mode,
            source: change.persist ? "global" : "runtime",
            state: "inactive",
          });
      } else if ("speed" in change && speed?.model) {
        const next = await invoke("session.speed.set", {
          sessionId: sessionId!,
          expectedModel: change.expectedModel,
          speed: change.speed,
        });
        if (generation === epoch.current) setSpeed(next);
      } else if ("mode" in change) {
        const next = await invoke("session.warming.set", {
          sessionId: sessionId!,
          mode: change.mode,
          persist: change.persist,
        });
        if (generation === epoch.current) setWarming(next);
      }
      if (generation === epoch.current) setConfirm(undefined);
    } catch (cause) {
      if (generation === epoch.current)
        setError(
          hostErrorMessage(cause, zh ? "设置未保存" : "Setting was not saved"),
        );
    } finally {
      if (generation === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className="session-options">
      {!enabled ? (
        <p role="status" className="muted">
          {zh
            ? "连接支持会话选项的 Runtime 后可调整速度与缓存保温。"
            : "Connect a Runtime with session controls to adjust speed and cache warming."}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="session-options-error">
          {error}
        </p>
      ) : null}
      <section className="session-options-card">
        <h3>
          {zh ? "处理速度" : "Serving speed"}
          {preview ? (
            <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
          ) : null}
        </h3>
        <div className="session-options-row">
          <label>
            {zh ? "当前模型" : "Current model"}
            <span className="mono">{speed?.model ?? "—"}</span>
          </label>
          <label>
            {zh ? "服务档位" : "Service tier"}
            <select
              className="select"
              aria-label={zh ? "处理速度" : "Serving speed"}
              value={speed?.selected ?? "normal"}
              disabled={
                !enabled || !speed || busy || !supports("session.speed.set")
              }
              onChange={(event) => {
                const value = event.target.value as StudioSpeed;
                if (
                  speed?.slowScope === "global" &&
                  (value === "slow" || speed.slowEnabled)
                )
                  setConfirm({
                    speed: value,
                    expectedModel: speed?.model ?? "",
                  });
                else
                  void apply({
                    speed: value,
                    expectedModel: speed?.model ?? "",
                  });
              }}
            >
              {(speed?.supported ?? ["normal"]).map((value) => (
                <option key={value} value={value}>
                  {
                    {
                      normal: "Normal",
                      fast: "Fast",
                      ultrafast: "Ultrafast",
                      slow: "Slow",
                    }[value]
                  }
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          {zh
            ? "Fast / Ultrafast 可能增加费用。Slow 使用较低优先级，响应时间可能延长。"
            : "Fast / Ultrafast may cost more. Slow uses lower priority and may take longer."}
        </p>
        {speed?.slowScope === "global" ? (
          <p className="muted">
            {zh
              ? "此账户的 Slow 策略保存在全局配置，对共享该配置的会话生效。"
              : "This account's Slow policy is saved globally and applies to sessions sharing that configuration."}
          </p>
        ) : null}
        {speed?.usageLimit ? (
          <div className="session-options-note" role="status">
            <b>
              {speed.usageLimit.stage === "wrap_up"
                ? zh
                  ? "额度耗尽，正在收尾"
                  : "Limit reached · wrapping up"
                : zh
                  ? "当前使用低优先级额度"
                  : "Using low-priority allowance"}
            </b>
            {speed.usageLimit.resetsAtSec ? (
              <span>
                {zh ? "恢复时间" : "Resets"} ·{" "}
                {new Date(speed.usageLimit.resetsAtSec * 1000).toLocaleString()}
              </span>
            ) : null}
            {speed.usageLimit.allowanceLeftPercent !== undefined ? (
              <span>
                {speed.usageLimit.allowanceLeftPercent.toFixed(1)}%{" "}
                {zh ? "剩余" : "remaining"}
              </span>
            ) : null}
          </div>
        ) : null}
        {speed?.selected === "fast" && !speed.fastActive ? (
          <p role="status">
            {zh
              ? "已选择 Fast，当前请求未启用加速。"
              : "Fast is selected but is not active for the current request."}
          </p>
        ) : null}
      </section>
      <section className="session-options-card">
        <h3>{zh ? "缓存保温" : "Cache warming"}</h3>
        <div className="session-options-row">
          <label>
            {zh ? "模式" : "Mode"}
            <select
              className="select"
              aria-label={zh ? "缓存保温模式" : "Cache warming mode"}
              value={warming?.mode ?? "off"}
              disabled={
                !enabled || !warming || busy || !supports("session.warming.set")
              }
              onChange={(event) => {
                const mode = event.target.value as SessionWarmingState["mode"];
                if (mode !== "off" || persist) setConfirm({ mode, persist });
                else void apply({ mode, persist });
              }}
            >
              <option value="off">{zh ? "关闭" : "Off"}</option>
              <option value="streaming">
                {zh ? "执行期间" : "During runs"}
              </option>
              <option value="idle">
                {zh ? "执行与空闲期间" : "During runs and idle"}
              </option>
            </select>
          </label>
          <label className="session-options-check">
            <input
              type="checkbox"
              checked={persist}
              onChange={(event) => setPersist(event.target.checked)}
            />
            {zh ? "保存为全局配置" : "Save in global configuration"}
          </label>
        </div>
        <p className="muted">
          {zh
            ? "保温会发送少量额外请求并产生用量。未配置时 Studio 默认关闭；已有显式配置会保留。"
            : "Warming sends additional small requests and consumes usage. Studio defaults to off when unconfigured and preserves explicit settings."}
        </p>
        {warming ? (
          <div className="session-options-note">
            <WorkspaceStatus state={warming.state} />
            <SourceBadge
              source={warming.source === "global" ? "user" : warming.source}
            />
            {warming.nextWarmAt ? (
              <span>{new Date(warming.nextWarmAt).toLocaleString()}</span>
            ) : null}
            {warming.reason ? <span>{warming.reason}</span> : null}
          </div>
        ) : null}
        {warming?.decision?.economicsAvailable ? (
          <p className="small muted">
            {zh ? "本次预计费用" : "Estimated refresh cost"} $
            {warming.decision.warmCost.toFixed(5)} ·{" "}
            {zh ? "预计节省" : "Expected savings"} $
            {warming.decision.expectedSavings.toFixed(5)}
          </p>
        ) : null}
      </section>
      {confirm ? (
        <div
          className="session-options-confirm"
          role="dialog"
          aria-label={zh ? "确认会话设置" : "Confirm session setting"}
        >
          <strong>{zh ? "确认更改" : "Confirm change"}</strong>
          <p>
            {"speed" in confirm
              ? zh
                ? `将 Slow 账户策略切换到 ${confirm.speed}；此更改影响全局配置。`
                : `Change the account's Slow policy to ${confirm.speed}. This changes global configuration.`
              : zh
                ? `缓存保温：${warmingLabel(warming?.mode ?? "off")} → ${warmingLabel(confirm.mode)}。${confirm.persist ? "保存到全局配置。" : "仅当前会话生效。"}`
                : `Cache warming: ${warmingLabel(warming?.mode ?? "off")} → ${warmingLabel(confirm.mode)}. ${confirm.persist ? "Save globally." : "Current session only."}`}
          </p>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void apply(confirm)}
          >
            {zh ? "确认" : "Confirm"}
          </button>
          <button
            type="button"
            className="btn outline"
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
