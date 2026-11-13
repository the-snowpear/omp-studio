import { useEffect, useState } from "react";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { RuntimeSettingsReadModel } from "@omp-studio/client-contract";
import { SettingRow, SettingSection } from "./SettingRow";
import { runtimeHasValue, runtimeSource, RuntimeBooleanRow, RuntimeScalarRow, RuntimeNumberRow, RuntimeJudgeModelRow } from "./tabs";
import type { RuntimeDemoApi, RuntimeSettingsCtl } from "./tabs";

export function Runtime1830Rows({ runtime, demo }: { runtime?: RuntimeSettingsCtl | undefined; demo?: RuntimeDemoApi | undefined }) {
  const { resolvedLanguage } = useI18n();
  const label = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  return <SettingSection title={label("配额重置与启动", "Quota resets and startup")}>
    <RuntimeBooleanRow runtime={runtime} demo={demo} keyName="retry.waitForUsageReset" label={label("等待模型额度恢复", "Wait for quota reset")} desc={label("额度耗尽后等待恢复再继续。", "Wait for quota to reset before retrying.")} />
    <p className="small muted">{label("重置券授权已移入模型配置 → 账户，按原生 5 小时 / 每周 / Fable 窗口分别管理。刷新账户不会兑换重置券。", "Saved-reset consent is managed in Model configuration → Accounts, separately for native 5h / weekly / Fable windows. Refreshing accounts never redeems a reset.")}</p>
    {runtime?.snapshot?.["claudeResets.autoRedeem"] !== undefined ? <p className="small muted" aria-readonly="true">{label("旧单项设置（只读迁移来源）", "Legacy setting (read-only migration source)")} · claudeResets.autoRedeem = {runtime.snapshot["claudeResets.autoRedeem"]}. {label("不会扩大授权到 Fable。", "It does not extend consent to Fable.")}</p> : null}
    <RuntimeNumberRow runtime={runtime} demo={demo} keyName="claudeResets.minBlockedMinutes" label={label("最短配额阻塞（分钟）", "Minimum quota block (minutes)")} desc={label("阻塞达到此时长时才考虑使用。", "Consider redemption when the quota block lasts at least this long.")} fallback={60} />
    <RuntimeNumberRow runtime={runtime} demo={demo} keyName="claudeResets.keepCredits" label={label("保留券数", "Resets to keep")} desc={label("自动使用时至少保留此数量。", "Keep at least this many saved resets during automatic use.")} fallback={0} />
    <RuntimeNumberRow runtime={runtime} demo={demo} keyName="claudeResets.salvageHorizonHours" label={label("到期前考虑使用（小时）", "Consider expiring resets within (hours)")} desc={label("仍遵循自动使用策略和上游资格检查。", "Still subject to the redemption policy and upstream eligibility checks.")} fallback={12} />
    <RuntimeNumberRow runtime={runtime} demo={demo} keyName="mcp.startupTimeoutMs" label={label("MCP 启动等待（毫秒）", "MCP startup wait (ms)")} desc={label("下次 Runtime 启动时生效。默认 250；0 表示等待所有连接完成。", "Applies on the next Runtime startup. Default 250; 0 waits for all connections to settle.")} fallback={250} />
    <RuntimeScalarRow runtime={runtime} demo={demo} keyName="ttsr.judge" label={label("规则判断", "Rule judgment")} desc={label("使用 Judge 角色验证规则；auto 遵循上游自动策略。", "Use the Judge role to validate rules; auto follows upstream policy.")} fallback="auto" options={[["auto", label("自动", "Auto")], ["on", label("启用", "On")], ["off", label("禁用", "Off")]]} />
  </SettingSection>;
}

export function RuntimeUpgradeRows({ runtime, demo }: { runtime?: RuntimeSettingsCtl | undefined; demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const tiersKey = "task.agentServiceTierOverrides";
  const preview = runtime?.preview === true;
  const available = runtimeHasValue(runtime, demo, tiersKey);
  const current = runtime?.snapshot?.[tiersKey] ?? {};
  const demoText = demo?.value(tiersKey);
  const serialized = preview ? demoText || "{}" : JSON.stringify(current);
  const [tiers, setTiers] = useState<Array<[string, string]>>([]);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    try { setTiers(Object.entries(JSON.parse(serialized) as Record<string, string>)); } catch { setTiers([]); }
    setInvalid(false);
  }, [serialized]);
  const disabled = !available || runtime?.set === undefined || runtime.pendingKey !== undefined;
  const timeoutKey = "images.questionTimeoutMs";
  const timeout = preview ? demo?.value(timeoutKey) || "300000" : String(runtime?.snapshot?.[timeoutKey] ?? 300000);
  const [timeoutDraft, setTimeoutDraft] = useState(timeout);
  useEffect(() => setTimeoutDraft(timeout), [timeout]);
  const saveTiers = () => {
    const names = tiers.map(([name]) => name.trim());
    if (names.some(name => !name || name.length > 256 || /[\u0000-\u001f]/u.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) || new Set(names).size !== names.length || names.length > 256) { setInvalid(true); return; }
    setInvalid(false);
    runtime?.set?.(tiersKey, Object.fromEntries(tiers.map(([, tier], i) => [names[i], tier])) as NonNullable<RuntimeSettingsReadModel[typeof tiersKey]>);
  };
  return <SettingSection title={t("runtimeUpgrade.section") + (runtime?.preview && marks ? " · " + t("common.demo") : "")}>
    <RuntimeBooleanRow runtime={runtime} demo={demo} keyName="task.enableEffort" label={t("runtimeUpgrade.effort")} desc={t("runtimeUpgrade.effortDesc")} />
    <RuntimeScalarRow runtime={runtime} demo={demo} keyName="task.maxEffort" label={t("runtimeUpgrade.maxEffort")} desc={t("runtimeUpgrade.maxEffortDesc")} fallback="max" options={["minimal","low","medium","high","xhigh","max"].map(value => [value, value] as const)} />
    <RuntimeScalarRow runtime={runtime} demo={demo} keyName="providers.autoThinkingMaxEffort" label={t("runtimeUpgrade.autoEffort")} desc={t("runtimeUpgrade.autoEffortDesc")} fallback="xhigh" options={[["xhigh","xhigh"],["max","max"]]} />
    {runtimeHasValue(runtime, demo, "modelRoles.judge") ? <RuntimeJudgeModelRow runtime={runtime} demo={demo} /> : runtime?.snapshot?.["providers.judgmentProvider"] !== undefined ? (
    <RuntimeScalarRow runtime={runtime} demo={demo} keyName="providers.judgmentProvider" label={t("runtimeUpgrade.judgment")} desc={t("runtimeUpgrade.judgmentDesc")} fallback="auto" options={[["auto","auto"],["typesafe","TypeSafe"],["llm","LLM"]]} />
    ) : <RuntimeJudgeModelRow runtime={runtime} demo={demo} />}
    <RuntimeBooleanRow runtime={runtime} demo={demo} keyName="images.describeForTextModels" label={t("runtimeUpgrade.describe")} desc={t("runtimeUpgrade.describeDesc")} />
    <SettingRow label={t("runtimeUpgrade.timeout")} desc={t("runtimeUpgrade.timeoutDesc")} source={runtimeSource(runtimeHasValue(runtime, demo, timeoutKey), runtime, timeoutKey)}>
      <input className="input" type="number" min={0} max={2147483647} aria-label={t("runtimeUpgrade.timeout")} value={timeoutDraft} disabled={disabled} onChange={event => setTimeoutDraft(event.target.value)} />
      <button className="btn small" disabled={disabled || timeoutDraft === "" || !Number.isSafeInteger(Number(timeoutDraft)) || Number(timeoutDraft) < 0 || Number(timeoutDraft) > 2147483647} onClick={() => runtime?.set?.(timeoutKey, Number(timeoutDraft))}>{t("common.save")}</button>
    </SettingRow>
    <SettingRow label={t("runtimeUpgrade.tiers")} desc={t("runtimeUpgrade.tiersDesc")} source={runtimeSource(available, runtime, tiersKey)} {...(available ? {} : { reason: t("settings.runtime.unavailable") })}>
      <div>
        {tiers.map(([name, tier], index) => <div key={index} className="row">
          <input className="input" aria-label={t("runtimeUpgrade.agent")} value={name} disabled={disabled} onChange={event => setTiers(rows => rows.map((row, i) => i === index ? [event.target.value, row[1]] : row))} />
          <AppSelect className="select" aria-label={t("runtimeUpgrade.tiers")} value={tier} disabled={disabled} onChange={event => setTiers(rows => rows.map((row, i) => i === index ? [row[0], event.target.value] : row))}>
            {["inherit","none","auto","default","flex","scale","priority","ultrafast"].map(value => <option key={value}>{value}</option>)}
          </AppSelect>
          <button className="btn small" disabled={disabled} onClick={() => setTiers(rows => rows.filter((_, i) => i !== index))}>{t("common.delete")}</button>
        </div>)}
        <button className="btn small" disabled={disabled || tiers.length >= 256} onClick={() => setTiers(rows => [...rows, ["", "inherit"]])}>{t("runtimeUpgrade.add")}</button>
        <button className="btn small" disabled={disabled} onClick={saveTiers}>{t("common.save")}</button>
        {invalid ? <p role="alert">{t("runtimeUpgrade.invalid")}</p> : null}
      </div>
    </SettingRow>
  </SettingSection>;
}
