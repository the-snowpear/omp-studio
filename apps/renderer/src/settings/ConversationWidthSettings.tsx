import { useEffect, useId, useState } from "react";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { CONVERSATION_WIDTH_LIMITS, CONVERSATION_WIDTH_MODES, DEFAULT_APP_SETTINGS, type ConversationWidthMode } from "./appSettings";
import { useConversationWidth } from "./ConversationWidthContext";
import { SettingRow, SettingSection, Slider } from "./SettingRow";

export function ConversationWidthSettings() {
  const { t } = useI18n();
  const { mode, customWidth, preview, update } = useConversationWidth();
  const [draft, setDraft] = useState(customWidth);
  useEffect(() => setDraft(customWidth), [customWidth, preview, mode]);
  const commit = () => {
    if (mode === "custom" && draft !== customWidth) update({ conversationCustomWidth: draft });
  };
  const label = t("settings.conversationWidth.title");
  return (
    <SettingSection title={label} desc={t("settings.conversationWidth.desc")}>
      {preview ? <span className="chip amber xs demo-chip">{t("common.demo")}</span> : null}
      <SettingRow label={t("settings.conversationWidth.mode")} desc={t("settings.conversationWidth.modeDesc")} source={mode === DEFAULT_APP_SETTINGS.conversationWidthMode ? "default" : "user"}>
        <AppSelect className="select" aria-label={label} value={mode} onChange={event => update({ conversationWidthMode: event.target.value as ConversationWidthMode })}>
          {CONVERSATION_WIDTH_MODES.map(option => <option key={option} value={option}>{t(`settings.conversationWidth.options.${option}`)}</option>)}
        </AppSelect>
      </SettingRow>
      {mode === "custom" ? (
        <SettingRow label={t("settings.conversationWidth.customWidth")} desc={t("settings.conversationWidth.customDesc")} source={customWidth === DEFAULT_APP_SETTINGS.conversationCustomWidth ? "default" : "user"}>
          <Slider
            value={draft}
            min={CONVERSATION_WIDTH_LIMITS.min}
            max={CONVERSATION_WIDTH_LIMITS.max}
            step={CONVERSATION_WIDTH_LIMITS.step}
            label={t("settings.conversationWidth.customWidth")}
            display={`${draft} px`}
            onChange={setDraft}
            onCommit={commit}
          />
        </SettingRow>
      ) : null}
    </SettingSection>
  );
}

/** Contents of a display-only group inside the existing conversation menu. */
export function ConversationWidthMenu({ onSelect, onOpenSettings }: {
  onSelect?: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useI18n();
  const { mode, customWidth, preview, update } = useConversationWidth();
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={descriptionId}>
      <div className="menu-label" id={labelId}>
        {t("settings.conversationWidth.title")}
        {preview ? <span className="chip amber xs demo-chip">{t("common.demo")}</span> : null}
      </div>
      <div className="menu-label" id={descriptionId}>{t("settings.conversationWidth.globalDisplay")}</div>
      {CONVERSATION_WIDTH_MODES.map(option => (
        <button
          key={option}
          type="button"
          className="menu-item"
          role="menuitemradio"
          aria-checked={mode === option}
          aria-current={mode === option ? "true" : undefined}
          onClick={() => {
            update({ conversationWidthMode: option });
            onSelect?.();
          }}
        >
          <span>{option === "custom" ? t("settings.conversationWidth.customValue", { width: customWidth }) : t(`settings.conversationWidth.options.${option}`)}</span>
          {mode === option ? <Icon name="check" extra="sm" /> : null}
        </button>
      ))}
      {onOpenSettings ? (
        <button type="button" className="menu-item" role="menuitem" onClick={() => {
          onSelect?.();
          onOpenSettings();
        }}>
          <Icon name="settings" extra="sm" />
          <span>{t("settings.conversationWidth.openSettings")}</span>
        </button>
      ) : null}
    </div>
  );
}
