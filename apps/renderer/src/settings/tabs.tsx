import { AppSelect } from "../AppSelect";
/** Shared controls for Runtime and desktop preferences. */

import { useEffect, useState } from "react";
import type { AppSettings } from "./appSettings";
import { DEFAULT_APP_SETTINGS } from "./appSettings";
import { SettingRow, SettingSection, Switch, type SettingSource } from "./SettingRow";
import { useUpdates, type UpdatePrefs } from "./updates";
import { DesktopUpdateRecovery } from "./DesktopUpdateRecovery";
import { PREVIEW_UPDATE_PREFS } from "../preview/settingsPreview";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { useSettingsScope } from "./SettingsScope";
import type {
  RuntimeSettingsReadModel,
  StudioCompactionSpeculation,
  StudioRuntimeCompactionMethod,
  StudioRuntimeSettingKey,
  StudioRuntimeSettingValue,
  StudioRuntimeSettingsActivation,
} from "@omp-studio/client-contract";

export type ApprovalModeId = "always-ask" | "always-ask-cached" | "write" | "yolo";

/** 由 SettingsPage 提供的控制器；预览模式替换为演示实现。 */
export interface SettingsCtl {
  readonly preview: boolean;
  readonly app: AppSettings;
  readonly updateApp: (patch: Partial<AppSettings>) => void;
  readonly resetApp: (keys: readonly (keyof AppSettings)[]) => void;
  readonly approvalMode: ApprovalModeId | undefined;
  readonly setApprovalMode: (mode: ApprovalModeId) => void;
  /** Clears every remembered approval (`/forget-approvals`); absent without a Runtime session. */
  readonly forgetApprovals?: () => Promise<void>;
}

/** Runtime 设置的预览读写面。 */
export interface RuntimeDemoApi {
  value(key: string): string;
  setValue(key: string, value: string): void;
  flag(key: string): boolean;
  toggle(key: string): void;
}

/** Runtime settings seam supplied by SettingsPage; absent values stay disabled. */
export interface RuntimeSettingsCtl {
  readonly preview: boolean;
  readonly previewValues?: Partial<RuntimeSettingsReadModel>;
  readonly snapshot?: RuntimeSettingsReadModel;
  readonly activation?: StudioRuntimeSettingsActivation;
  readonly compactionSpeculation?: StudioCompactionSpeculation;
  readonly pendingKey?: StudioRuntimeSettingKey;
  readonly error?: string;
  readonly set?: (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue, persist?: boolean) => void;
}

const RUNTIME_DEFAULTS: RuntimeSettingsReadModel = {
  "modelRoles.judge": "",
  "claudeResets.autoRedeem": "unset",
  "claudeResets.minBlockedMinutes": 60,
  "claudeResets.keepCredits": 0,
  "claudeResets.salvageHorizonHours": 12,
  "mcp.startupTimeoutMs": 250,
  "ttsr.judge": "auto",
  "edit.autoRepair.enabled": false,
  "features.unexpectedStopDetection": "mechanical",
  "providers.unexpectedStopModel": "online",
  extendedContext: true,
  "compaction.asyncEnabled": true,
  "compaction.methodOrder": ["remote", "snapcompact", "handoff", "shake", "soft"],
  "providers.openai-codex.codeMode": "off",
  "plan.autosave": false,
  "plan.autosaveDir": "",
  "retry.waitForUsageReset": false,
  "compaction.experimentalContextManagement": false,
  "task.enableEffort": false,
  "task.maxEffort": "max",
  "task.agentServiceTierOverrides": {},
  "providers.autoThinkingMaxEffort": "xhigh",
  "providers.judgmentProvider": "auto",
  "images.describeForTextModels": true,
  "images.questionTimeoutMs": 300000,
  "tools.speculativeExecution.enabled": false,
};

export function appSource<K extends keyof AppSettings>(app: AppSettings, key: K): SettingSource {
  return app[key] === DEFAULT_APP_SETTINGS[key] ? "default" : "user";
}

type RuntimeBooleanKey = "task.enableEffort" | "images.describeForTextModels" | "tools.speculativeExecution.enabled" | "edit.autoRepair.enabled" | "extendedContext" | "compaction.asyncEnabled" | "plan.autosave" | "retry.waitForUsageReset" | "compaction.experimentalContextManagement";
type RuntimeScalarKey =
  | "claudeResets.autoRedeem"
  | "ttsr.judge"
  | "task.maxEffort"
  | "providers.autoThinkingMaxEffort"
  | "providers.judgmentProvider"
  | "features.unexpectedStopDetection"
  | "providers.unexpectedStopModel"
  | "providers.openai-codex.codeMode";

export function runtimeHasValue<K extends StudioRuntimeSettingKey>(runtime: RuntimeSettingsCtl | undefined, demo: RuntimeDemoApi | undefined, key: K): boolean {
  if (runtime?.preview === true) return demo !== undefined;
  return runtime?.snapshot?.[key] !== undefined;
}

export function runtimeSource(available: boolean, runtime?: RuntimeSettingsCtl, key?: StudioRuntimeSettingKey): SettingSource {
  if (!available) return "unavailable";
  const source = key ? runtime?.activation?.sources?.[key] : undefined;
  return source === "global" ? "user" : source ?? "runtime";
}

export function RuntimePending({ runtime }: { runtime?: RuntimeSettingsCtl | undefined }) {
  const { t } = useI18n();
  return runtime?.pendingKey === undefined ? null : (
    <span className="small muted" role="status" aria-live="polite" aria-atomic="true">
      {t("settings.runtime.pending")}
    </span>
  );
}

export function RuntimeBooleanRow({
  runtime,
  demo,
  keyName,
  label,
  desc,
}: {
  runtime?: RuntimeSettingsCtl | undefined;
  demo?: RuntimeDemoApi | undefined;
  keyName: RuntimeBooleanKey;
  label: string;
  desc: string;
}) {
  const { t } = useI18n();
  const [scope] = useSettingsScope();
  const available = runtimeHasValue(runtime, demo, keyName);
  const preview = runtime?.preview === true && demo !== undefined;
  const snapshotValue = runtime?.activation?.configured[keyName] ?? runtime?.snapshot?.[keyName];
  const checked = preview ? demo.flag(keyName) : (snapshotValue ?? RUNTIME_DEFAULTS[keyName]) === true;
  const disabled = !available || runtime?.set === undefined || runtime.pendingKey !== undefined || (keyName === "compaction.experimentalContextManagement" && scope === "session");
  return (
    <SettingRow
      label={label}
      desc={desc}
      source={runtimeSource(available, runtime, keyName)}
      {...(available ? {} : { reason: t("settings.runtime.unavailable") })}
    >
      <Switch
        checked={checked}
        disabled={disabled}
        onChange={(next) => {
          runtime?.set?.(keyName, next);
        }}
        label={label}
      />
      <RuntimePending runtime={runtime} />
      {keyName === "compaction.experimentalContextManagement" && scope === "session" ? <span className="small muted">{t("settings.runtime.globalOnly")}</span> : null}
      {keyName === "compaction.experimentalContextManagement" && !preview && available ? (
        <span className="small muted" role="status">
          {runtime?.snapshot?.[keyName] ? t("settings.runtime.notesActive") : t("settings.runtime.notesInactive")}
          {runtime?.activation?.restartRequired.includes(keyName) ? " · " + t("settings.runtime.restartRequired") : ""}
        </span>
      ) : null}
    </SettingRow>
  );
}

export function RuntimePlanDirectoryRow({ runtime, demo }: { runtime?: RuntimeSettingsCtl | undefined; demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
  const available = runtimeHasValue(runtime, demo, "plan.autosaveDir");
  const value = runtime?.preview ? demo?.value("plan.autosaveDir") ?? "" : runtime?.snapshot?.["plan.autosaveDir"] ?? "";
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const disabled = !available || runtime?.set === undefined || runtime.pendingKey !== undefined;
  return (
    <SettingRow label={t("settings.runtime.planAutosaveDir")} desc={t("settings.runtime.planAutosaveDirDesc")} source={runtimeSource(available, runtime, "plan.autosaveDir")}>
      <input className="input" aria-label={t("settings.runtime.planAutosaveDir")} value={draft} disabled={disabled} maxLength={4096} placeholder=".omp/plans/" onChange={event => setDraft(event.target.value)} />
      <button type="button" className="btn small outline" disabled={disabled || draft === value} onClick={() => runtime?.set?.("plan.autosaveDir", draft.trim())}>{t("settings.runtime.saveDirectory")}</button>
      <RuntimePending runtime={runtime} />
    </SettingRow>
  );
}

export function RuntimeJudgeModelRow({ runtime, demo }: { runtime?: RuntimeSettingsCtl | undefined; demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
  const key = "modelRoles.judge";
  const preview = runtime?.preview === true && demo !== undefined;
  const available = runtimeHasValue(runtime, demo, key);
  const value = preview ? demo.value(key) : runtime?.snapshot?.[key] ?? "";
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const disabled = !available || (!preview && runtime?.set === undefined) || runtime?.pendingKey !== undefined;
  return <SettingRow label={t("runtimeUpgrade.judgeModel")} desc={t("runtimeUpgrade.judgeModelDesc")} source={runtimeSource(available, runtime, "modelRoles.judge")}>
    <input className="input" aria-label={t("runtimeUpgrade.judgeModel")} placeholder="typesafe/jev-latest" value={draft} maxLength={4096} disabled={disabled} onChange={event => setDraft(event.target.value)} />
    <button type="button" className="btn small outline" disabled={disabled || draft === value || /[\u0000-\u001f]/u.test(draft)} onClick={() => {
      if (preview) demo.setValue(key, draft.trim());
      else runtime?.set?.(key, draft.trim());
    }}>{t("common.save")}</button>
    <RuntimePending runtime={runtime} />
  </SettingRow>;
}

export function RuntimeScalarRow({
  runtime,
  demo,
  keyName,
  label,
  desc,
  fallback,
  options,
}: {
  runtime?: RuntimeSettingsCtl | undefined;
  demo?: RuntimeDemoApi | undefined;
  keyName: RuntimeScalarKey;
  label: string;
  desc: string;
  fallback: string;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  const { t } = useI18n();
  const available = runtimeHasValue(runtime, demo, keyName);
  const preview = runtime?.preview === true && demo !== undefined;
  const snapshotValue = runtime?.snapshot?.[keyName];
  const demoValue = preview ? demo.value(keyName) : "";
  const defaultValue = RUNTIME_DEFAULTS[keyName];
  const schemaFallback = typeof defaultValue === "string" ? defaultValue : fallback;
  const value = preview ? (demoValue || schemaFallback) : (typeof snapshotValue === "string" ? snapshotValue : schemaFallback);
  const disabled = !available || runtime?.set === undefined || runtime.pendingKey !== undefined;
  return (
    <SettingRow
      label={label}
      desc={desc}
      source={runtimeSource(available, runtime, keyName)}
      {...(available ? {} : { reason: t("settings.runtime.unavailable") })}
    >
      <AppSelect
        className="select"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => runtime?.set?.(keyName, event.target.value as StudioRuntimeSettingValue)}
      >
        {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
      </AppSelect>
      <RuntimePending runtime={runtime} />
    </SettingRow>
  );
}

export function RuntimeNumberRow({ runtime, demo, keyName, label, desc, fallback }: {
  runtime?: RuntimeSettingsCtl | undefined; demo?: RuntimeDemoApi | undefined;
  keyName: "claudeResets.minBlockedMinutes" | "claudeResets.keepCredits" | "claudeResets.salvageHorizonHours" | "mcp.startupTimeoutMs";
  label: string; desc: string; fallback: number;
}) {
  const { t } = useI18n();
  const available = runtimeHasValue(runtime, demo, keyName);
  const value = runtime?.preview ? demo?.value(keyName) || String(fallback) : String(runtime?.snapshot?.[keyName] ?? fallback);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const disabled = !available || runtime?.set === undefined || runtime.pendingKey !== undefined;
  const numeric = Number(draft);
  return <SettingRow label={label} desc={desc} source={runtimeSource(available, runtime, keyName)}>
    <input className="input" type="number" min={0} max={2147483647} step={1} aria-label={label} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} />
    <button type="button" className="btn small" disabled={disabled || !draft.trim() || !Number.isSafeInteger(numeric) || numeric < 0 || numeric > 2147483647} onClick={() => runtime?.set?.(keyName, numeric)}>{t("common.save")}</button>
    <RuntimePending runtime={runtime} />
  </SettingRow>;
}

export function RuntimeMethodOrderRow({ runtime, demo, label, desc }: {
  runtime?: RuntimeSettingsCtl | undefined;
  demo?: RuntimeDemoApi | undefined;
  label: string;
  desc: string;
}) {
  const { t } = useI18n();
  const keyName = "compaction.methodOrder" as const;
  const available = runtimeHasValue(runtime, demo, keyName);
  const preview = runtime?.preview === true && demo !== undefined;
  const snapshotValue = runtime?.snapshot?.[keyName];
  const defaultOrder: readonly StudioRuntimeCompactionMethod[] = RUNTIME_DEFAULTS["compaction.methodOrder"];
  const snapshotOrder = Array.isArray(snapshotValue) ? snapshotValue : undefined;
  const demoOrder = preview ? demo.value(keyName).split(",").filter(Boolean) as StudioRuntimeCompactionMethod[] : undefined;
  const selected = (preview ? (demoOrder?.length ? demoOrder : defaultOrder) : (snapshotOrder?.length ? snapshotOrder : defaultOrder)).join(",");
  const options: ReadonlyArray<readonly [string, string]> = [
    ["remote,snapcompact,handoff,shake,soft", t("settings.runtime.methodOrderRemoteFirst")],
    ["snapcompact,remote,handoff,shake,soft", t("settings.runtime.methodOrderSnapcompactFirst")],
    ["handoff,remote,snapcompact,shake,soft", t("settings.runtime.methodOrderHandoffFirst")],
    ["soft,remote,snapcompact,handoff,shake", t("settings.runtime.methodOrderSoftFirst")],
    ["shake,remote,snapcompact,handoff,soft", t("settings.runtime.methodOrderShakeFirst")],
  ];
  const displayOptions = options.some(([value]) => value === selected)
    ? options
    : [[selected, selected.split(",").join(" → ")], ...options] as ReadonlyArray<readonly [string, string]>;
  const disabled = !available || runtime?.set === undefined || runtime.pendingKey !== undefined;
  return (
    <SettingRow
      label={label}
      desc={desc}
      source={runtimeSource(available, runtime, keyName)}
      {...(available ? {} : { reason: t("settings.runtime.unavailable") })}
    >
      <AppSelect
        className="select"
        aria-label={label}
        value={selected}
        disabled={disabled}
        onChange={(event) => runtime?.set?.(keyName, event.target.value.split(",") as StudioRuntimeSettingValue)}
      >
        {displayOptions.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
      </AppSelect>
      <RuntimePending runtime={runtime} />
    </SettingRow>
  );
}

export function RuntimeSpeculationRow({ runtime, demo, label, desc }: {
  runtime?: RuntimeSettingsCtl | undefined;
  demo?: RuntimeDemoApi | undefined;
  label: string;
  desc: string;
}) {
  const { t } = useI18n();
  const speculationLabels: Record<StudioCompactionSpeculation, string> = {
    idle: t("settings.runtime.speculationIdle"),
    running: t("settings.runtime.speculationRunning"),
    armed: t("settings.runtime.speculationArmed"),
  };
  const demoState = runtime?.preview === true ? demo?.value("compaction.speculation") : undefined;
  const state = runtime?.compactionSpeculation ?? (
    demoState === "idle" || demoState === "running" || demoState === "armed" ? demoState : undefined
  );
  const available = state !== undefined;
  const value = state === undefined ? t("settings.runtime.unavailable") : speculationLabels[state];
  return (
    <SettingRow
      label={label}
      desc={desc}
      source={runtimeSource(available)}
      {...(available ? {} : { reason: t("settings.runtime.unavailable") })}
    >
      <span className="small muted">{value}</span>
    </SettingRow>
  );
}
