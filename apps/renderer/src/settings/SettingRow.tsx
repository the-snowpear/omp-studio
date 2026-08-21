/**
 * 设置页共享行组件：来源徽标 + 分节标题 + 受控开关 / 占位枚举。
 *
 * 来源徽标是本轮采纳的「逐行来源」模型：每行标注 当前值来自哪里
 * （默认值 / 用户 / 项目 / 运行时覆盖），尚未接入 Host 的行统一
 * 「尚未接入」并在悬停时给出原因。Runtime 设置接入 settings contract
 * 后（Phase 2+），同一条 Row 换 source 与真实控件即可，不再改版式。
 */

import type { ReactNode } from "react";
import { useI18n } from "../i18n";

export type SettingSource = "default" | "user" | "project" | "runtime" | "unavailable";

export function SourceBadge({ source, reason }: { source: SettingSource; reason?: string | undefined }) {
  const { t } = useI18n();
  const label = t(`settings.sources.${source}`);
  return (
    <span
      className={`src-badge${source === "unavailable" ? " is-unavailable" : ""}`}
      data-source={source}
      data-tip={source === "unavailable" ? (reason ?? `（${t("common.notImplemented")}）`) : undefined}
    >
      {label}
    </span>
  );
}

export function SettingSection({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <h4>{title}</h4>
      {desc ? <p className="set-section-desc">{desc}</p> : null}
      {children}
    </section>
  );
}

export function SettingRow({
  label,
  desc,
  source = "user",
  reason,
  children,
}: {
  label: string;
  desc?: string;
  source?: SettingSource;
  reason?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={`set-row${source === "unavailable" ? " is-unavailable" : ""}`} data-tip={source === "unavailable" ? (reason ?? `（${t("common.notImplemented")}）`) : undefined}>
      <div>
        <div className="sr-label">
          {label} <SourceBadge source={source} reason={reason} />
        </div>
        {desc ? <div className="sr-desc">{desc}</div> : null}
      </div>
      <div className="sr-control">{children}</div>
    </div>
  );
}

/** 受控开关；沿用全局 `.switch` 样式，禁用态由 CSS 淡化。 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`switch${checked ? " on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/**
 * 枚举占位：显示未来接入后的真实取值（OMP settings-schema 的枚举），
 * 接入前始终禁用。不做可交互的假控件。
 */
export function StaticSelect({
  value,
  options,
  label,
  title,
}: {
  value: string;
  options: ReadonlyArray<string | readonly [string, string]>;
  label: string;
  title?: string;
}) {
  const { t } = useI18n();
  return (
    <select className="select" value={value} disabled aria-label={label} data-tip={title ?? `（${t("common.notImplemented")}）`}>
      {options.map((option) => {
        const [optVal, optLabel] = Array.isArray(option) ? option : [option, option];
        return (
          <option key={optVal} value={optVal}>{optLabel}</option>
        );
      })}
    </select>
  );
}

