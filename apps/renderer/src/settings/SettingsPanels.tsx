import { useState, type ReactNode } from "react";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { SettingRow, SettingSection, Switch } from "./SettingRow";
import { appSource, runtimeHasValue, RuntimeBooleanRow, RuntimePlanDirectoryRow, RuntimeScalarRow, RuntimeMethodOrderRow, RuntimeSpeculationRow } from "./tabs";
import type { SettingsCtl, RuntimeDemoApi, RuntimeSettingsCtl, ApprovalModeId } from "./tabs";

export function InteractionTab({ ctl, demo, prediction }: { ctl: SettingsCtl; demo?: RuntimeDemoApi | undefined; prediction?: ReactNode }) {
  const { t } = useI18n();
  const { app, updateApp } = ctl;
  return (
    <>

      {prediction}

      <SettingSection title={t("settings.interaction.sectionReply")}>

        <SettingRow label={t("settings.interaction.showThinkingSummary")} desc={t("settings.interaction.showThinkingSummaryDesc")} source={appSource(app, "showThinkingSummary")}>
          <Switch checked={app.showThinkingSummary} onChange={(showThinkingSummary) => updateApp({ showThinkingSummary })} label={t("settings.interaction.showThinkingSummary")} />
        </SettingRow>
        <SettingRow label={t("settings.interaction.showToolIntent")} desc={t("settings.interaction.showToolIntentDesc")} source={appSource(app, "showToolIntent")}>
          <Switch checked={app.showToolIntent} onChange={(showToolIntent) => updateApp({ showToolIntent })} label={t("settings.interaction.showToolIntent")} />
        </SettingRow>

      </SettingSection>
    </>
  );
}

export function PermissionsTab({ ctl, demo }: { ctl: SettingsCtl; demo?: RuntimeDemoApi | undefined }) {
  const { t } = useI18n();
  const { approvalMode, setApprovalMode, forgetApprovals } = ctl;
  const [forgetState, setForgetState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const runForget = () => {
    if (!forgetApprovals || forgetState === "busy") return;
    setForgetState("busy");
    forgetApprovals().then(
      () => setForgetState("done"),
      () => setForgetState("failed"),
    );
  };

  return (
    <>

      <SettingSection title={t("settings.permissions.sectionDefaultMode")} desc={t("settings.permissions.sectionDefaultModeDesc")}>
        <SettingRow
          label={t("settings.permissions.approvalMode")}
          desc={t("settings.permissions.approvalModeDesc")}
          source={approvalMode === undefined ? "unavailable" : "runtime"}
          reason={t("settings.permissions.approvalModeReason")}
        >
          <AppSelect
            className={`select${approvalMode === "yolo" ? " danger" : ""}`}
            value={approvalMode === undefined ? "" : approvalMode}
            disabled={approvalMode === undefined}
            onChange={(event) => {
              const mode = event.target.value as ApprovalModeId;
              if (mode === approvalMode) return;
              setApprovalMode(mode);
            }}
            aria-label={t("settings.permissions.approvalMode")}
          >
            {approvalMode === undefined ? <option value="" disabled>{t("settings.permissions.noRuntime")}</option> : null}
            <option value="always-ask">Always ask</option>
            <option value="always-ask-cached">Ask and remember</option>
            <option value="write">Write</option>
            <option value="yolo">Yolo</option>
          </AppSelect>
        </SettingRow>
        <SettingRow
          label={t("settings.permissions.forgetApprovals")}
          desc={t("settings.permissions.forgetApprovalsDesc")}
          source={forgetApprovals === undefined ? "unavailable" : "runtime"}
          reason={t("settings.permissions.noRuntime")}
        >
          <button
            type="button"
            className="btn small outline"
            disabled={forgetApprovals === undefined || forgetState === "busy"}
            onClick={runForget}
          >
            {forgetState === "done"
              ? t("settings.permissions.forgetApprovalsDone")
              : forgetState === "failed"
                ? t("settings.permissions.forgetApprovalsFailed")
                : t("settings.permissions.forgetApprovalsAction")}
          </button>
        </SettingRow>
      </SettingSection>

    </>
  );
}

export function ContextTab({ demo, runtime }: { demo?: RuntimeDemoApi | undefined; runtime?: RuntimeSettingsCtl | undefined }) {
  const { t } = useI18n();
  return (
    <>

      <SettingSection title={t("settings.context.sectionCompaction")}>
        <RuntimeBooleanRow runtime={runtime} demo={demo} keyName="compaction.experimentalContextManagement" label={t("settings.runtime.notesContext")} desc={t("settings.runtime.notesContextDesc")} />
        <RuntimeBooleanRow
          runtime={runtime}
          demo={demo}
          keyName="extendedContext"
          label={t("settings.runtime.extendedContext")}
          desc={t("settings.runtime.extendedContextDesc")}
        />
        <RuntimeBooleanRow
          runtime={runtime}
          demo={demo}
          keyName="compaction.asyncEnabled"
          label={t("settings.runtime.asyncCompaction")}
          desc={t("settings.runtime.asyncCompactionDesc")}
        />
        <RuntimeMethodOrderRow
          runtime={runtime}
          demo={demo}
          label={t("settings.runtime.methodOrder")}
          desc={t("settings.runtime.methodOrderDesc")}
        />
        <RuntimeSpeculationRow
          runtime={runtime}
          demo={demo}
          label={t("settings.runtime.speculation")}
          desc={t("settings.runtime.speculationDesc")}
        />

      </SettingSection>

    </>
  );
}

export function FilesTab({ demo, runtime }: { demo?: RuntimeDemoApi | undefined; runtime?: RuntimeSettingsCtl | undefined }) {
  const { t } = useI18n();
  return (
    <>

      <SettingSection title={t("settings.files.sectionEdit")}>
        <RuntimeBooleanRow
          runtime={runtime}
          demo={demo}
          keyName="edit.autoRepair.enabled"
          label={t("settings.runtime.autoRepair")}
          desc={t("settings.runtime.autoRepairDesc")}
        />

      </SettingSection>
      <SettingSection title={t("settings.files.sectionRead")}>
        <RuntimeBooleanRow runtime={runtime} demo={demo} keyName="tools.speculativeExecution.enabled" label={t("runtimeUpgrade.speculative")} desc={t("runtimeUpgrade.speculativeDesc")} />

      </SettingSection>

    </>
  );
}

export function TasksTab({ demo, runtime }: { demo?: RuntimeDemoApi | undefined; runtime?: RuntimeSettingsCtl | undefined }) {
  const { t } = useI18n();
  return (
    <>

      <SettingSection title={t("settings.tasks.sectionWorkMode")}>
        <RuntimeBooleanRow runtime={runtime} demo={demo} keyName="plan.autosave" label={t("settings.runtime.planAutosave")} desc={t("settings.runtime.planAutosaveDesc")} />
        <RuntimePlanDirectoryRow runtime={runtime} demo={demo} />

      </SettingSection>
      <SettingSection title={t("settings.tasks.sectionExecution")}>
        <RuntimeScalarRow
          runtime={runtime}
          demo={demo}
          keyName="features.unexpectedStopDetection"
          label={t("settings.runtime.unexpectedStopMode")}
          desc={t("settings.runtime.unexpectedStopModeDesc")}
          fallback="mechanical"
          options={[
            ["none", t("settings.runtime.modeNone")],
            ["mechanical", t("settings.runtime.modeMechanical")],
            ["smart", t("settings.runtime.modeSmart")],
          ]}
        />
        {runtime?.snapshot?.["providers.unexpectedStopModel"] !== undefined && !runtimeHasValue(runtime, demo, "modelRoles.judge") ? (
        <RuntimeScalarRow
          runtime={runtime}
          demo={demo}
          keyName="providers.unexpectedStopModel"
          label={t("settings.runtime.unexpectedStopModel")}
          desc={t("settings.runtime.unexpectedStopModelDesc")}
          fallback="online"
          options={[
            ["online", t("settings.runtime.modelOnline")],
            ["qwen3-1.7b", "qwen3-1.7b"],
            ["llama3.2:3b", "llama3.2:3b"],
            ["gemma-3-1b", "gemma-3-1b"],
            ["qwen2.5-1.5b", "qwen2.5-1.5b"],
            ["lfm2-1.2b", "lfm2-1.2b"],
          ]}
        />
        ) : null}

      </SettingSection>

    </>
  );
}
