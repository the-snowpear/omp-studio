import { AppSelect } from "../AppSelect";
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
import { useHasSettingsScope, useSettingsScope } from "./SettingsScope";
export interface NativePreferencesContext {
  sessionId?: string | undefined;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}
export const nativePreferenceDescriptions: Record<NativePreferenceKey, [string, string]> = {
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
  "advisor.continueSeverity": [
    "继续阈值",
    "Agent 给出最终回答后，达到该级别的 Advisor 提醒会唤醒它继续；更低级别的提醒留在对话末尾，随你的下一条消息送达。",
  ],
  "lsp.requestTimeout": [
    "LSP 请求超时（秒）",
    "Agent 未指定超时时，等待语言服务器诊断、悬停等结果的秒数；冷启动慢的服务器可调大。",
  ],
  "sharpshooter.minPromptLength": [
    "Sharpshooter 最短提示长度",
    "短于该字符数的提示不触发 Sharpshooter。",
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
export const nativePreferenceEnglishDescriptions: Record<NativePreferenceKey, [string, string]> = {
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
  "advisor.continueSeverity": [
    "Continue severity",
    "Minimum severity of an Advisor note that wakes the agent after its final answer; lower notes wait for your next message.",
  ],
  "lsp.requestTimeout": [
    "LSP request timeout (seconds)",
    "Seconds to wait for language-server answers when the agent sets no timeout; raise it for slow cold starts.",
  ],
  "sharpshooter.minPromptLength": [
    "Sharpshooter minimum prompt length",
    "Prompts shorter than this many characters do not trigger Sharpshooter.",
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
    ["advisor.continueSeverity", "concern", ["nit", "concern", "blocker"]],
    ["lsp.requestTimeout", 10, undefined],
    ["sharpshooter.minPromptLength", 16, undefined],
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
        : String(key).startsWith("telemetry.")
          ? "diagnostics"
          : "tools",
    label: nativePreferenceEnglishDescriptions[key as NativePreferenceKey][0],
    description: nativePreferenceEnglishDescriptions[key as NativePreferenceKey][1],
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
  groups,
}: {
  client?: StudioClient | undefined;
  context?: NativePreferencesContext | undefined;
  visible: boolean;
  groups?: readonly NativePreference["group"][] | undefined;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [rows, setRows] = useState<NativePreference[]>([]);
  const [drafts, setDrafts] = useState<
    Partial<Record<NativePreferenceKey, NativePreferenceValue>>
  >({});
  const [scope, setScope] = useSettingsScope("session");
  const sharedScope = useHasSettingsScope();
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
  const save = async (pending: { row: NativePreference; value: NativePreferenceValue; scope: "session" | "global"; clear: boolean }) => {
    if (saveLock.current || !can(pending.clear ? "preferences.native.clearOverride" : "preferences.native.set")) return;
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
        if (!preview || marks) setNotice(
          preview && marks
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
      }
    } catch (cause) {
      if (current === epoch.current) {
        setDrafts((values) => ({ ...values, [pending.row.key]: pending.row.value }));
        setError(
          hostErrorMessage(
            cause,
            zh
              ? "保存失败，请刷新生效状态后重试。"
              : "Save failed. Refresh the effective state before retrying.",
          ),
        );
      }
    } finally {
      if (current === epoch.current) {
        saveLock.current = false;
        setBusy(false);
      }
    }
  };
  const label = (row: NativePreference) =>
    zh ? nativePreferenceDescriptions[row.key][0] : nativePreferenceEnglishDescriptions[row.key][0];
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
          nit: "细节（nit）",
          concern: "关注（concern）",
          blocker: "阻断（blocker）",
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
      {preview && marks ? (
        <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
      ) : null}
      {!sharedScope ? <div className="session-options-row">
        <label>
          {zh ? "保存范围" : "Save scope"}{" "}
          <AppSelect
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
          </AppSelect>
        </label>
      </div> : null}
      {error ? (
        <p role="alert" className="session-options-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {(["advisor", "tools", "titles", "diagnostics"] as const).filter(group => !groups || groups.includes(group)).map((group) => (
        <SettingSection
          key={group}
          title={
            group === "advisor"
              ? "Advisor"
              : group === "tools"
                ? zh
                  ? "工具"
                  : "Tools"
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
                desc={zh ? nativePreferenceDescriptions[row.key][1] : row.description || nativePreferenceEnglishDescriptions[row.key][1]}
                source={row.source === "global" ? "user" : row.source}
              >
                <div className="native-preference-controls">
                  {row.type === "boolean" ? (
                    <Switch
                      checked={Boolean(drafts[row.key] ?? row.value)}
                      onChange={(value) => { setDrafts((drafts) => ({ ...drafts, [row.key]: value })); void save({ row, value, scope: row.key === "telemetry.otlpExportEnabled" ? "global" : scope, clear: false }); }}
                      label={label(row)}
                      disabled={busy || !can("preferences.native.set") || (row.key === "telemetry.otlpExportEnabled" && scope === "session")}
                    />
                  ) : row.type === "enum" ? (
                    <AppSelect
                      className="select"
                      aria-label={label(row)}
                      value={JSON.stringify(drafts[row.key] ?? row.value)}
                      disabled={busy || !can("preferences.native.set")}
                      onChange={(event) => { const value = JSON.parse(event.target.value) as NativePreferenceValue; setDrafts((values) => ({ ...values, [row.key]: value })); void save({ row, value, scope, clear: false }); }}
                    >
                      {row.choices?.map((value) => (
                        <option
                          key={String(value)}
                          value={JSON.stringify(value)}
                        >
                          {choice(value)}
                        </option>
                      ))}
                    </AppSelect>
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
                  {row.type === "number" ? <button
                    className="btn small outline"
                    disabled={busy || !can("preferences.native.set")}
                    onClick={() =>
                      void save({
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
                  </button> : null}
                  {row.source === "runtime" ? (
                    <button
                      className="btn small"
                      disabled={
                        busy || !can("preferences.native.clearOverride")
                      }
                      onClick={() =>
                        void save({
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
                  {row.key === "telemetry.otlpExportEnabled" && scope === "session" ? <span className="small muted">{zh ? "此项只能保存到用户配置" : "Only user configuration is supported"}</span> : null}
                  {row.source !== "default" || row.restartRequired || row.value !== row.effective ? <details>
                    <summary>{zh ? "生效信息" : "Effective value"}</summary>
                    <span className="small mono">
                      {row.key} · {row.source} · {String(row.effective)}
                    </span>
                  </details> : null}
                </div>
              </SettingRow>
            ))}
        </SettingSection>
      ))}
    </div>
  );
}
