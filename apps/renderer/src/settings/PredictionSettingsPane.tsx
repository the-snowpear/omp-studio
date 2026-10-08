import { useEffect, useRef, useState } from "react";
import type { StudioClient, CommandInput } from "@omp-studio/client-contract";
import type {
  PredictionSettings,
  PredictionMethod,
  PredictionResultMap,
  PredictionChannel,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { waitReceipt, hostErrorMessage } from "../hostError";
import type { NativePreferencesContext } from "./NativePreferencesPane";
import { SettingSection, SettingRow } from "./SettingRow";
import { PLATFORM } from "../platform";
export function PredictionSettingsPane({
  client,
  context,
  visible,
}: {
  client?: StudioClient | undefined;
  context?: NativePreferencesContext | undefined;
  visible: boolean;
}) {
  const { preview } = usePreviewMode(),
    { resolvedLanguage } = useI18n(),
    zh = resolvedLanguage === "zh";
  const [data, setData] = useState<PredictionSettings>(),
    [method, setMethod] = useState<PredictionMethod>("auto"),
    [scope, setScope] = useState<"session" | "global">("session");
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState<PredictionMethod>();
  const epoch = useRef(0),
    dirty = useRef(false),
    lock = useRef(false),
    channel = useRef<PredictionChannel | undefined>(undefined);
  const has = (kind: string) =>
    preview ||
    !!(
      context?.available &&
      client &&
      context.sessionId &&
      context.capabilities?.capabilities.some(
        (row) => row.id === kind && row.grade !== "unavailable",
      )
    );
  const enabled = has("prediction.status");
  async function call<K extends keyof PredictionResultMap>(
    kind: K,
    input: CommandInput<K>,
  ): Promise<PredictionResultMap[K]> {
    const handle = await client!.command(kind, input);
    return (
      await waitReceipt<{ result: PredictionResultMap[K] }>(
        client!,
        handle.requestId,
      )
    ).result;
  }
  async function refresh(current = epoch.current) {
    if (!enabled || preview || lock.current) return;
    try {
      const next = await call("prediction.status", {
        sessionId: context!.sessionId!,
      });
      if (current === epoch.current) {
        setData(next);
        if (!dirty.current) setMethod(next.method);
      }
    } catch (cause) {
      if (current === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "预测状态读取失败" : "Prediction status unavailable",
          ),
        );
    }
  }
  useEffect(() => {
    const current = ++epoch.current;
    setError("");
    setNotice("");
    setConfirm(undefined);
    lock.current = false;
    setBusy("");
    dirty.current = false;
    setData(undefined);
    if (preview) {
      const next: PredictionSettings = {
        method: "auto",
        effective: "ngram",
        source: "default",
        download: { state: "idle", bytes: 0, total: 146915724 },
      };
      setData(next);
      setMethod(next.method);
    } else if (visible && enabled) void refresh(current);
    return () => {
      epoch.current++;
      const previous = channel.current;
      channel.current = undefined;
      if (previous)
        void globalThis.ompStudioChrome
          ?.detachPrediction?.({ channelId: previous.channelId })
          .catch(() => {});
    };
  }, [client, context?.sessionId, context?.available, preview, enabled]);
  useEffect(() => {
    if (visible) {
      void refresh();
      return;
    }
    epoch.current++;
    lock.current = false;
    setBusy("");
    setConfirm(undefined);
    const previous = channel.current;
    channel.current = undefined;
    if (previous)
      void globalThis.ompStudioChrome
        ?.detachPrediction?.({ channelId: previous.channelId })
        .catch(() => {});
  }, [visible]);
  useEffect(() => {
    if (!visible || preview || data?.download.state !== "downloading") return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [visible, preview, data?.download.state]);
  async function save(next: PredictionMethod) {
    if (lock.current) return;
    lock.current = true;
    setBusy("save");
    setError("");
    setConfirm(undefined);
    const current = epoch.current;
    try {
      const value = preview
        ? ({
            method: next,
            effective:
              next === "off"
                ? "off"
                : next === "auto" || next === "smollm"
                  ? "ngram"
                  : next,
            source: scope === "session" ? "runtime" : "global",
            download:
              next === "smollm"
                ? { state: "downloading", bytes: 73457862, total: 146915724 }
                : (data?.download ?? {
                    state: "idle",
                    bytes: 0,
                    total: 146915724,
                  }),
          } as PredictionSettings)
        : await call("prediction.configure", {
            sessionId: context!.sessionId!,
            scope,
            method: next,
          });
      if (current === epoch.current) {
        setData(value);
        setMethod(value.method);
        dirty.current = false;
        setNotice(
          preview
            ? zh
              ? "演示设置已更新，不会下载模型。"
              : "Demo settings updated; no model was downloaded."
            : value.method !== next
              ? zh
                ? "已保存，但本会话的临时覆盖仍优先。"
                : "Saved; a session override still takes precedence."
              : zh
                ? "预测设置已保存。"
                : "Prediction settings saved.",
        );
      }
    } catch (cause) {
      if (current === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "保存预测设置失败" : "Cannot save prediction settings",
          ),
        );
    } finally {
      if (current === epoch.current) {
        lock.current = false;
        setBusy("");
      }
    }
  }
  async function clearOverride() {
    if (lock.current) return;
    lock.current = true;
    setBusy("clear");
    const current = epoch.current;
    try {
      const next = preview
        ? ({
            method: "auto",
            effective: "ngram",
            source: "default",
            download: data!.download,
          } as PredictionSettings)
        : await call("prediction.clearOverride", {
            sessionId: context!.sessionId!,
          });
      if (current === epoch.current) {
        setData(next);
        setMethod(next.method);
        dirty.current = false;
      }
    } catch (cause) {
      if (current === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "清除覆盖失败" : "Cannot clear override",
          ),
        );
    } finally {
      if (current === epoch.current) {
        lock.current = false;
        setBusy("");
      }
    }
  }
  async function cancelDownload() {
    if (lock.current) return;
    lock.current = true;
    setBusy("cancel");
    setError("");
    const current = epoch.current;
    try {
      const next = preview
        ? ({
            ...data!,
            download: { ...data!.download, state: "cancelled" },
          } as PredictionSettings)
        : await call("prediction.download.cancel", {
            sessionId: context!.sessionId!,
          });
      if (current === epoch.current) setData(next);
    } catch (cause) {
      if (current === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "取消下载失败" : "Cannot cancel download",
          ),
        );
    } finally {
      if (current === epoch.current) {
        lock.current = false;
        setBusy("");
      }
    }
  }
  async function importHistory() {
    if (lock.current) return;
    if (preview) {
      setNotice(
        zh
          ? "演示：已识别 158 条提示词，未读取真实历史。"
          : "Demo: 158 prompt records recognized; real history was not read.",
      );
      return;
    }
    const chrome = globalThis.ompStudioChrome;
    if (!chrome?.attachPrediction || !chrome.importPredictionHistory) return;
    lock.current = true;
    setBusy("import");
    setError("");
    const current = epoch.current;
    let prepared: PredictionChannel | undefined;
    try {
      prepared = await call("prediction.prepare", {
        sessionId: context!.sessionId!,
      });
      if (current !== epoch.current) return;
      channel.current = prepared;
      const attached = await chrome.attachPrediction(prepared);
      if (!attached.ok) throw new Error(attached.message);
      if (current !== epoch.current) return;
      const result = await chrome.importPredictionHistory({
        channelId: prepared.channelId,
      });
      if (current !== epoch.current) return;
      if (!result.ok) throw new Error(result.message);
      if (!result.cancelled)
        setNotice(
          zh
            ? `已学习 ${result.count ?? 0} 条提示词。${result.truncated ? "已达到导入限制。" : ""}`
            : `Learned ${result.count ?? 0} prompts.${result.truncated ? " Import limit reached." : ""}`,
        );
    } catch (cause) {
      if (current === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "导入历史失败" : "History import failed",
          ),
        );
    } finally {
      if (prepared) {
        void chrome
          .detachPrediction?.({ channelId: prepared.channelId })
          .catch(() => {});
        void client!
          .command("prediction.release", {
            sessionId: prepared.sessionId,
            channelId: prepared.channelId,
          })
          .catch(() => {});
      }
      if (current === epoch.current) {
        lock.current = false;
        setBusy("");
        channel.current = undefined;
      }
    }
  }
  const methods: Array<[PredictionMethod, string]> = [
    ["off", zh ? "关闭" : "Off"],
    ["auto", zh ? "自动 · 本地轻量引擎" : "Auto · lightweight local engine"],
    ["ngram", zh ? "本地轻量引擎" : "Local n-gram"],
    ["smollm", "SmolLM2-135M"],
    ...(PLATFORM === "darwin"
      ? [
          ["apple", zh ? "Apple 系统词典" : "Apple system dictionary"] as [
            PredictionMethod,
            string,
          ],
        ]
      : []),
  ];
  return (
    <SettingSection title={zh ? "预测输入" : "Predictive input"}>
      <p className="tiny muted">
        {zh
          ? "在输入框内显示词语补全。Tab 接受并添加空格，右方向键仅接受补全文字。"
          : "Show inline word completion. Tab accepts with a space; Right Arrow accepts the word only."}
        {preview ? (zh ? " · 演示" : " · Demo") : ""}
      </p>
      {!enabled ? (
        <p className="tiny muted">
          {zh
            ? "连接支持预测输入的 Runtime 后可配置。"
            : "Connect a Runtime with prediction support to configure it."}
        </p>
      ) : null}
      <div className="prediction-settings-form">
        <label>
          {zh ? "引擎" : "Engine"}
          <select
            className="select"
            value={method}
            disabled={!enabled || !!busy}
            onChange={(event) => {
              dirty.current = true;
              setMethod(event.target.value as PredictionMethod);
            }}
          >
            {methods.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? "保存范围" : "Scope"}
          <select
            className="select"
            value={scope}
            disabled={!!busy}
            onChange={(event) =>
              setScope(event.target.value as "session" | "global")
            }
          >
            <option value="session">{zh ? "仅本会话" : "This session"}</option>
            <option value="global">
              {zh ? "OMP 全局设置" : "Global OMP setting"}
            </option>
          </select>
        </label>
        <button
          className="btn outline"
          disabled={!has("prediction.configure") || !!busy}
          onClick={() =>
            method === "smollm" && data?.download.state !== "ready"
              ? setConfirm(method)
              : void save(method)
          }
        >
          {zh ? "保存" : "Save"}
        </button>
        <button
          className="btn small ghost"
          disabled={
            !has("prediction.clearOverride") ||
            !!busy ||
            data?.source !== "runtime"
          }
          onClick={() => void clearOverride()}
        >
          {zh ? "清除本会话覆盖" : "Clear session override"}
        </button>
      </div>
      {data ? (
        <p className="tiny muted">
          {zh ? "当前生效" : "Effective"}:{" "}
          {methods.find(([id]) => id === data.effective)?.[1] ?? data.effective}{" "}
          · {zh ? "来源" : "Source"}:{" "}
          {(
            {
              default: zh ? "默认值" : "Default",
              global: zh ? "OMP 全局" : "Global OMP",
              project: zh ? "项目" : "Project",
              runtime: zh ? "本会话" : "This session",
              env: zh ? "环境" : "Environment",
              overlay: zh ? "应用默认" : "Application default",
            } as Record<string, string>
          )[data.source] ?? data.source}
        </p>
      ) : null}
      {data?.download.state === "downloading" ? (
        <div className="prediction-download">
          <progress max={data.download.total} value={data.download.bytes} />
          <span>
            {(data.download.bytes / 1048576).toFixed(1)} /{" "}
            {(data.download.total / 1048576).toFixed(1)} MiB
          </span>
          <button
            className="btn small outline"
            disabled={!has("prediction.download.cancel") || !!busy}
            onClick={() => void cancelDownload()}
          >
            {zh ? "取消下载" : "Cancel download"}
          </button>
        </div>
      ) : null}
      {data?.download.error ? <p role="alert">{data.download.error}</p> : null}
      <SettingRow
        source={null}
        label={zh ? "外部提示词历史" : "External prompt history"}
        desc={
          zh
            ? "仅导入你手动选择的 Claude Code / Codex JSONL 文件，最多 8 MiB、2,000 条。只用于 Studio 本地预测，不写入 OMP 会话历史。"
            : "Import only a Claude Code / Codex JSONL file you select, up to 8 MiB and 2,000 prompts. Used for local Studio prediction without changing OMP session history."
        }
      >
        <button
          className="btn outline"
          disabled={
            !has("prediction.prepare") ||
            !!busy ||
            (!preview && !globalThis.ompStudioChrome?.importPredictionHistory)
          }
          onClick={() => void importHistory()}
        >
          {busy === "import"
            ? zh
              ? "导入中…"
              : "Importing…"
            : zh
              ? "选择历史文件…"
              : "Choose history file…"}
        </button>
      </SettingRow>
      {error ? (
        <p className="prediction-settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="tiny muted">
          {notice}
        </p>
      ) : null}
      {confirm ? (
        <div className="modal-backdrop" onClick={() => setConfirm(undefined)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              zh ? "下载本地预测模型" : "Download local prediction model"
            }
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">SmolLM2-135M</header>
            <div className="modal-body">
              <p>
                {zh
                  ? "选择后下载约 140 MiB 的模型文件，预测在本机执行。下载期间继续使用本地轻量引擎。"
                  : "Download about 140 MiB of model files for local prediction. The lightweight engine remains available during download."}
              </p>
            </div>
            <footer className="modal-foot">
              <button
                className="btn outline"
                onClick={() => setConfirm(undefined)}
              >
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                className="btn primary"
                onClick={() => void save(confirm)}
              >
                {zh ? "确认并下载" : "Confirm and download"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </SettingSection>
  );
}
