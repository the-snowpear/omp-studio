import { useEffect, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { useTimeTravelSettings } from "../history/useTimeTravelSettings";
import { SettingRow, SettingSection, Switch } from "./SettingRow";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { usePreviewMode } from "../preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { timeTravelPreview } from "../preview/timeTravelPreview";
import { TimeTravelEnableDialog } from "../history/TimeTravelActivation";
import { TimeTravelDialog } from "../history/TimeTravelDialog";
import { Icon } from "../icons";

export function TimeTravelSettings({
  client,
  visible,
}: {
  client?: StudioClient | undefined;
  visible: boolean;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview } = usePreviewMode();
  const target = useExecutionTarget();
  const { settings, error, busy, update } = useTimeTravelSettings(
    target.localClient ?? client,
    visible,
  );
  const disconnected = target.inventory.statuses.filter(
    (status) => status.state !== "connected",
  ).length;
  const unsynced = target.inventory.statuses.filter(
    (status) =>
      status.state === "connected" && status.timeTravelSync !== "synced",
  );
  const [exclusions, setExclusions] = useState("");
  const [days, setDays] = useState("");
  const [storage, setStorage] = useState<{
    snapshots: number;
    bytes: number;
  }>();
  const [cleaning, setCleaning] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [cleanupError, setCleanupError] = useState<string>();
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [customRetention, setCustomRetention] = useState(false);
  useEffect(() => {
    setExclusions(settings?.exclusions.join("\n") ?? "");
    setDays(settings?.retentionDays?.toString() ?? "");
  }, [settings]);
  useEffect(() => {
    if (!visible) return;
    if (preview) {
      setStorage(timeTravelPreview.storage);
      return;
    }
    if (!client) return;
    void client
      .query("timeTravel.storage.get", {})
      .then(setStorage, (cause) =>
        setCleanupError(
          hostErrorMessage(cause, "Time Travel storage unavailable"),
        ),
      );
  }, [client, preview, visible]);
  const cleanup = async () => {
    if (preview) {
      setStorage({ snapshots: 0, bytes: 0 });
      setConfirmCleanup(false);
      return;
    }
    if (!client) return;
    setCleaning(true);
    setCleanupError(undefined);
    try {
      const handle = await client.command("timeTravel.cleanup", {
        scope: "all",
      });
      await waitReceipt(client, handle.requestId, null);
      setStorage(await client.query("timeTravel.storage.get", {}));
      setConfirmCleanup(false);
    } catch (cause) {
      setCleanupError(
        hostErrorMessage(cause, zh ? "清理失败" : "Cleanup failed"),
      );
    } finally {
      setCleaning(false);
    }
  };
  return (
    <SettingSection
      title="Time Travel"
      desc={
        zh
          ? "全局开关同步到各执行环境；快照分别保存在各环境中。"
          : "The global switch syncs across execution environments; each host stores its own snapshots."
      }
    >
      <SettingRow
        label={zh ? "启用 Time Travel" : "Enable Time Travel"}
        desc={
          zh
            ? "为每轮对话记录工作区检查点。关闭后保留已有快照。"
            : "Record workspace checkpoints for each turn. Existing snapshots are retained when disabled."
        }
        source={settings ? "user" : "unavailable"}
      >
        <Switch
          checked={settings?.enabled ?? false}
          disabled={!settings || busy}
          onChange={(enabled) => {
            if (enabled) setConfirmEnable(true);
            else void update({ enabled: false });
          }}
          label={zh ? "启用 Time Travel" : "Enable Time Travel"}
        />
      </SettingRow>
      <SettingRow label={zh ? "快照保留期限" : "Snapshot retention"}>
        <AppSelect
          className="select"
          disabled={!settings || busy}
          aria-label={zh ? "快照保留期限" : "Snapshot retention"}
          value={
            customRetention
              ? "custom"
              : settings?.retentionDays === null
                ? "forever"
                : [30, 90, 365].includes(settings?.retentionDays ?? 0)
                  ? String(settings?.retentionDays)
                  : "custom"
          }
          onChange={(event) => {
            setCustomRetention(event.target.value === "custom");
            if (event.target.value === "custom") return;
            void update({
              retentionDays:
                event.target.value === "forever"
                  ? null
                  : Number(event.target.value),
            });
          }}
        >
          <option value="forever">{zh ? "永久保留" : "Keep forever"}</option>
          <option value="30">30 {zh ? "天" : "days"}</option>
          <option value="90">90 {zh ? "天" : "days"}</option>
          <option value="365">365 {zh ? "天" : "days"}</option>
          <option value="custom">{zh ? "自定义" : "Custom"}</option>
        </AppSelect>
      </SettingRow>
      {customRetention ||
      (settings?.retentionDays != null &&
        ![30, 90, 365].includes(settings.retentionDays)) ? (
        <SettingRow label={zh ? "自定义保留天数" : "Custom retention days"}>
          <input
            className="input"
            type="number"
            min={1}
            value={days}
            disabled={!settings || busy}
            aria-label={zh ? "自定义保留天数" : "Custom retention days"}
            onChange={(event) => setDays(event.target.value)}
            onBlur={() => {
              const value = Number(days);
              if (
                Number.isInteger(value) &&
                value > 0 &&
                value !== settings?.retentionDays
              )
                void update({ retentionDays: value });
            }}
          />
        </SettingRow>
      ) : null}
      <SettingRow
        label={zh ? "额外排除规则" : "Additional exclusions"}
        desc={
          zh ? "每行一条 Git 忽略规则。" : "One Git ignore pattern per line."
        }
      >
        <textarea
          className="input tt-exclusions"
          rows={3}
          value={exclusions}
          placeholder={"dist/\n*.log\n.env*"}
          disabled={!settings || busy}
          aria-label={zh ? "额外排除规则" : "Additional exclusions"}
          onChange={(event) => setExclusions(event.target.value)}
          onBlur={() => {
            const values = exclusions.split("\n").filter(Boolean);
            if (JSON.stringify(values) !== JSON.stringify(settings?.exclusions))
              void update({ exclusions: values });
          }}
        />
      </SettingRow>
      <div className="tt-storage">
        <Icon name="archive" />
        <div>
          <strong>
            {storage ? `${(storage.bytes / 1024 / 1024).toFixed(1)} MiB` : "—"}
          </strong>
          <p>
            {storage?.snapshots ?? "—"} {zh ? "个检查点" : "checkpoints"} ·{" "}
            {target.name}
          </p>
        </div>
        <button
          type="button"
          className="btn small outline"
          disabled={!storage?.snapshots || cleaning}
          onClick={() => setConfirmCleanup(true)}
        >
          {zh ? "清除快照…" : "Clear snapshots…"}
        </button>
      </div>
      {error ? (
        <p className="small" role="alert">
          {error}
        </p>
      ) : null}
      {cleanupError ? (
        <p className="small" role="alert">
          {cleanupError}
        </p>
      ) : null}
      {!preview && disconnected ? (
        <p className="small muted">
          {zh
            ? `${disconnected} 个远程环境未连接，连接后同步设置。`
            : `${disconnected} remote environments will sync when connected.`}
        </p>
      ) : null}
      {!preview && unsynced.length ? (
        <p className="tt-muted" role="status">
          {zh
            ? `${unsynced.length} 个已连接环境尚未同步 Time Travel。同步失败时请重连；旧版本 Host 需要更新。`
            : `${unsynced.length} connected hosts have not synced Time Travel. Reconnect after a failure; older hosts need an update.`}
        </p>
      ) : null}
      {confirmEnable ? (
        <TimeTravelEnableDialog
          client={client}
          onClose={() => setConfirmEnable(false)}
        />
      ) : null}
      {confirmCleanup ? (
        <TimeTravelDialog
          title={zh ? "清除所有代码快照？" : "Clear all code snapshots?"}
          description={
            zh
              ? "此操作无法撤销。会话记录和当前工作区文件不受影响。"
              : "This cannot be undone. Conversation history and current workspace files are kept."
          }
          busy={cleaning}
          onClose={() => setConfirmCleanup(false)}
          actions={
            <>
              <button
                type="button"
                className="btn outline"
                disabled={cleaning}
                onClick={() => setConfirmCleanup(false)}
              >
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={cleaning}
                onClick={() => void cleanup()}
              >
                {cleaning
                  ? zh
                    ? "正在清除…"
                    : "Clearing…"
                  : zh
                    ? "清除代码快照"
                    : "Clear code snapshots"}
              </button>
            </>
          }
        >
          <div className="tt-note">
            <Icon name="alert" />
            <p>
              {target.name} · {storage?.snapshots}{" "}
              {zh
                ? "个检查点将被删除，包括恢复前备份。"
                : "checkpoints will be deleted, including backups made before restores."}
            </p>
          </div>
          {cleanupError ? (
            <p className="tt-error" role="alert">
              {cleanupError}
            </p>
          ) : null}
        </TimeTravelDialog>
      ) : null}
    </SettingSection>
  );
}
