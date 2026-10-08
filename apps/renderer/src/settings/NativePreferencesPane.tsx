import "../models/sessionOptions.css";
import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  CommandInput,
  StudioClient,
} from "@omp-studio/client-contract";
import type {
  NativePreference,
  NativePreferenceKey,
  NativePreferenceResultMap,
  NativePreferenceValue,
} from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { SettingRow, SettingSection, Switch } from "./SettingRow";
import { WorkspaceEmpty } from "../workspaces/Workspace";
export interface NativePreferencesContext {
  sessionId?: string | undefined;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}
const descriptions: Record<NativePreferenceKey, [string, string]> = {
  "advisor.enabled": [
    "启用 Advisor",
    "按所选 Advisor 模型审查任务，可能产生额外模型调用。",
  ],
  "advisor.reviewMode": [
    "审查时机",
    "选择审查每次更新，或只审查最终结果；WATCHDOG 配置优先。",
  ],
  "advisor.reviewInterval": [
    "审查间隔",
    "每多少次符合条件的更新进行一次审查；未审查内容会随下次一起送出。",
  ],
  "advisor.syncBacklog": [
    "等待审查的策略",
    "数字档位最多等待 30 秒；严格模式等待全部已安排的审查。中止和失败会释放等待。",
  ],
  "advisor.immuneTurns": [
    "重复提醒冷却",
    "Advisor 提醒后，在指定轮次内降低重复打断；阻断级问题不受影响。",
  ],
  "advisor.maxNotesPerUpdate": [
    "每次审查最多提醒",
    "限制普通提醒数量，阻断级问题不受限制。",
  ],
  "advisor.evictStaleResults": [
    "整理旧审查上下文",
    "用简短占位说明替换旧审查的工具结果，保留最新结果。",
  ],
  "title.icons": ["标题图标", "选择标题图标与短码的显示方式。"],
  "title.generator": [
    "标题生成方式",
    "使用当前模型的旁路调用，或标题角色模型。",
  ],
  "title.refreshOnReplan": [
    "重新规划时刷新标题",
    "待办计划重新初始化时更新自动标题；手动命名不受影响。",
  ],
  "telemetry.otlpExportEnabled": [
    "OTLP 导出",
    "控制是否向已配置的 OTEL 目标导出追踪、日志和指标；保存后下次启动生效。",
  ],
};
const englishDescriptions: Record<NativePreferenceKey, [string, string]> = {
  "advisor.enabled": [
    "Enable Advisor",
    "Review tasks with the Advisor model. Additional model calls may be billed.",
  ],
  "advisor.reviewMode": [
    "Review timing",
    "Review each eligible update or the final result. WATCHDOG configuration takes precedence.",
  ],
  "advisor.reviewInterval": [
    "Review interval",
    "Review every N eligible updates, including accumulated changes.",
  ],
  "advisor.syncBacklog": [
    "Wait for reviews",
    "Numeric thresholds wait up to 30 seconds; strict mode waits for all scheduled reviews.",
  ],
  "advisor.immuneTurns": [
    "Reminder cooldown",
    "Reduce repeated interruptions for this many turns. Blockers are exempt.",
  ],
  "advisor.maxNotesPerUpdate": [
    "Notes per review",
    "Limit ordinary review notes. Blockers are exempt.",
  ],
  "advisor.evictStaleResults": [
    "Compact review context",
    "Replace old review tool results with short placeholders.",
  ],
  "title.icons": ["Title icons", "Choose title icons and short codes."],
  "title.generator": [
    "Title generation",
    "Use a side call to the current model or the title model role.",
  ],
  "title.refreshOnReplan": [
    "Refresh title on replan",
    "Update automatic titles when a plan is reinitialized. Manual titles are preserved.",
  ],
  "telemetry.otlpExportEnabled": [
    "OTLP export",
    "Export to configured OTEL destinations. Takes effect on the next launch.",
  ],
};
const demo = (): NativePreference[] =>
  [
    ["advisor.enabled", false, undefined],
    ["advisor.reviewMode", "turn", ["turn", "agent-end"]],
    ["advisor.reviewInterval", 1, undefined],
    ["advisor.syncBacklog", "off", ["off", "1", "2", "3", "strict"]],
    ["advisor.immuneTurns", 3, undefined],
    ["advisor.maxNotesPerUpdate", 4, undefined],
    ["advisor.evictStaleResults", true, undefined],
    ["title.icons", "emoji", ["nf+emoji", "emoji", "boring"]],
    ["title.generator", "fork", ["fork", "tiny"]],
    ["title.refreshOnReplan", true, undefined],
    ["telemetry.otlpExportEnabled", true, undefined],
  ].map(([key, value, choices]) => ({
    key: key as NativePreferenceKey,
    group: String(key).startsWith("advisor.")
      ? "advisor"
      : String(key).startsWith("title.")
        ? "titles"
        : "diagnostics",
    label: englishDescriptions[key as NativePreferenceKey][0],
    description: englishDescriptions[key as NativePreferenceKey][1],
    value: value as NativePreferenceValue,
    effective: value as NativePreferenceValue,
    source: "default",
    type:
      typeof value === "boolean"
        ? "boolean"
        : typeof value === "number"
          ? "number"
          : "enum",
    ...(choices ? { choices: choices as string[] } : {}),
    restartRequired: false,
  }));
export function NativePreferencesPane({
  client,
  context,
  visible,
}: {
  client?: StudioClient | undefined;
  context?: NativePreferencesContext | undefined;
  visible: boolean;
}) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [rows, setRows] = useState<NativePreference[]>([]);
  const [drafts, setDrafts] = useState<
    Partial<Record<NativePreferenceKey, NativePreferenceValue>>
  >({});
  const [scope, setScope] = useState<"session" | "global">("session");
  const [pending, setPending] = useState<{
    row: NativePreference;
    value: NativePreferenceValue;
    scope: "session" | "global";
    clear: boolean;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const saveLock = useRef(false);
  const demoGlobals = useRef<
    Partial<Record<NativePreferenceKey, NativePreference>>
  >({});
  const can = (kind: string) =>
    preview ||
    !!(
      client &&
      context?.available &&
      context.sessionId &&
      context.capabilities?.capabilities.some(
        (item) => item.id === kind && item.grade !== "unavailable",
      )
    );
  const invoke = async <K extends keyof NativePreferenceResultMap>(
    kind: K,
    input: CommandInput<K>,
  ): Promise<NativePreferenceResultMap[K]> => {
    const handle = await client!.command(kind, input);
    return (
      await waitReceipt<{ result: NativePreferenceResultMap[K] }>(
        client!,
        handle.requestId,
      )
    ).result;
  };
  useEffect(() => {
    epoch.current++;
    saveLock.current = false;
    demoGlobals.current = {};
    setBusy(false);
    setPending(undefined);
    setDrafts({});
    setRows(preview ? demo() : []);
    setError("");
    setNotice("");
    return () => {
      epoch.current++;
    };
  }, [client, preview, context?.sessionId]);
  useEffect(() => {
    if (!visible || preview || !can("preferences.native.get")) return;
    let active = true;
    void invoke("preferences.native.get", { sessionId: context!.sessionId! })
      .then((result) => {
        if (active) setRows(result.preferences);
      })
      .catch((cause) => {
        if (active)
          setError(
            hostErrorMessage(
              cause,
              zh ? "运行偏好读取失败" : "Cannot read Runtime preferences",
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [
    visible,
    preview,
    client,
    context?.sessionId,
    context?.available,
    context?.capabilities,
  ]);
  const save = async () => {
    if (!pending || saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    const current = epoch.current;
    try {
      let row: NativePreference;
      if (preview) {
        if (pending.clear)
          row =
            demoGlobals.current[pending.row.key] ??
            demo().find((row) => row.key === pending.row.key)!;
        else {
          row = {
            ...pending.row,
            value: pending.value,
            effective:
              pending.row.key === "telemetry.otlpExportEnabled"
                ? pending.row.effective
                : pending.value,
            source: pending.scope === "global" ? "global" : "runtime",
            restartRequired:
              pending.row.key === "telemetry.otlpExportEnabled" &&
              pending.value !== pending.row.effective,
          };
          if (pending.scope === "global") {
            demoGlobals.current[row.key] = row;
            if (pending.row.source === "runtime") row = pending.row;
          }
        }
      } else
        row = pending.clear
          ? await invoke("preferences.native.clearOverride", {
              sessionId: context!.sessionId!,
              key: pending.row.key,
            })
          : await invoke("preferences.native.set", {
              sessionId: context!.sessionId!,
              key: pending.row.key,
              value: pending.value,
              scope: pending.scope,
            });
      if (current === epoch.current) {
        setRows((values) =>
          values.map((value) => (value.key === row.key ? row : value)),
        );
        setDrafts((values) => ({ ...values, [row.key]: row.value }));
        setNotice(
          preview
            ? zh
              ? "演示：偏好已更新，真实配置未更改。"
              : "Demo: preferences updated locally."
            : row.restartRequired
              ? zh
                ? "已保存，下次启动生效。"
                : "Saved for the next launch."
              : zh
                ? "已处理，当前生效值与来源已更新。"
                : "Updated. Effective value and source are shown below.",
        );
        setPending(undefined);
      }
    } catch (cause) {
      if (current === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh
              ? "保存失败，请刷新生效状态后重试。"
              : "Save failed. Refresh the effective state before retrying.",
          ),
        );
    } finally {
      if (current === epoch.current) {
        saveLock.current = false;
        setBusy(false);
      }
    }
  };
  const label = (row: NativePreference) =>
    zh ? descriptions[row.key][0] : row.label;
  const choice = (value: NativePreferenceValue) =>
    zh
      ? ({
          turn: "每次更新",
          "agent-end": "最终结果",
          off: "关闭",
          strict: "等待全部",
          "nf+emoji": "字体图标与 Emoji",
          emoji: "Emoji",
          boring: "仅标题",
          fork: "当前模型的旁路调用",
          tiny: "标题角色模型",
        }[String(value)] ?? String(value))
      : String(value);
  if (!can("preferences.native.get"))
    return (
      <WorkspaceEmpty
        title={
          zh
            ? "此 Runtime 尚不支持这些运行偏好"
            : "Runtime preferences are unavailable"
        }
      />
    );
  return (
    <div>
      {preview ? (
        <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
      ) : null}
      <div className="session-options-row">
        <label>
          {zh ? "保存范围" : "Save scope"}{" "}
          <select
            className="select"
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as "session" | "global")
            }
          >
            <option value="session">
              {zh ? "本会话临时覆盖" : "This session"}
            </option>
            <option value="global">
              {zh ? "原生全局设置" : "Native global settings"}
            </option>
          </select>
        </label>
      </div>
      {error ? (
        <p role="alert" className="session-options-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {(["advisor", "titles", "diagnostics"] as const).map((group) => (
        <SettingSection
          key={group}
          title={
            group === "advisor"
              ? "Advisor"
              : group === "titles"
                ? zh
                  ? "标题"
                  : "Titles"
                : zh
                  ? "诊断导出"
                  : "Diagnostic export"
          }
        >
          {rows
            .filter((row) => row.group === group)
            .map((row) => (
              <SettingRow
                key={row.key}
                label={label(row)}
                desc={zh ? descriptions[row.key][1] : row.description}
                source={row.source === "global" ? "user" : row.source}
              >
                <div className="native-preference-controls">
                  {row.type === "boolean" ? (
                    <Switch
                      checked={Boolean(drafts[row.key] ?? row.value)}
                      onChange={(value) =>
                        setDrafts((drafts) => ({ ...drafts, [row.key]: value }))
                      }
                      label={label(row)}
                      disabled={busy}
                    />
                  ) : row.type === "enum" ? (
                    <select
                      className="select"
                      aria-label={label(row)}
                      value={JSON.stringify(drafts[row.key] ?? row.value)}
                      onChange={(event) =>
                        setDrafts((values) => ({
                          ...values,
                          [row.key]: JSON.parse(
                            event.target.value,
                          ) as NativePreferenceValue,
                        }))
                      }
                    >
                      {row.choices?.map((value) => (
                        <option
                          key={String(value)}
                          value={JSON.stringify(value)}
                        >
                          {choice(value)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input"
                      aria-label={label(row)}
                      type="number"
                      value={Number(drafts[row.key] ?? row.value)}
                      onChange={(event) =>
                        setDrafts((values) => ({
                          ...values,
                          [row.key]: Number(event.target.value),
                        }))
                      }
                    />
                  )}
                  <button
                    className="btn small outline"
                    disabled={busy || !can("preferences.native.set")}
                    onClick={() =>
                      setPending({
                        row,
                        value: drafts[row.key] ?? row.value,
                        scope:
                          row.key === "telemetry.otlpExportEnabled"
                            ? "global"
                            : scope,
                        clear: false,
                      })
                    }
                  >
                    {zh ? "应用" : "Apply"}
                  </button>
                  {row.source === "runtime" ? (
                    <button
                      className="btn small"
                      disabled={
                        busy || !can("preferences.native.clearOverride")
                      }
                      onClick={() =>
                        setPending({
                          row,
                          value: row.value,
                          scope: "session",
                          clear: true,
                        })
                      }
                    >
                      {zh ? "清除临时覆盖" : "Clear override"}
                    </button>
                  ) : null}
                  {row.restartRequired ? (
                    <span className="chip gray xs">
                      {zh ? "等待重启" : "Restart needed"}
                    </span>
                  ) : null}
                  <details>
                    <summary>{zh ? "生效信息" : "Effective value"}</summary>
                    <span className="small mono">
                      {row.key} · {row.source} · {String(row.effective)}
                    </span>
                  </details>
                </div>
              </SettingRow>
            ))}
        </SettingSection>
      ))}
      {pending ? (
        <div
          className="session-options-confirm"
          role="dialog"
          aria-label={zh ? "确认运行偏好" : "Confirm Runtime preference"}
        >
          <strong>{label(pending.row)}</strong>
          <p>
            {String(pending.row.value)} →{" "}
            {pending.clear
              ? zh
                ? "继承配置值"
                : "Inherit configured value"
              : String(pending.value)}
          </p>
          <p>
            {pending.scope === "global"
              ? zh
                ? "保存到原生全局配置，现有项目和临时覆盖仍优先。"
                : "Save to native global configuration. Existing project and session overrides keep precedence."
              : zh
                ? "仅更改本会话的临时覆盖。"
                : "Change only this session's temporary override."}
          </p>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {zh ? "确认" : "Confirm"}
          </button>
          <button
            className="btn outline"
            disabled={busy}
            onClick={() => setPending(undefined)}
          >
            {zh ? "取消" : "Cancel"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
