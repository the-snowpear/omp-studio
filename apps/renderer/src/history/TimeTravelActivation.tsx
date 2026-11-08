import { useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { TimeTravelDialog } from "./TimeTravelDialog";
import { useTimeTravelSettings } from "./useTimeTravelSettings";

export function TimeTravelEnableDialog({
  client,
  onClose,
}: {
  client?: StudioClient | undefined;
  onClose: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const { busy, error, update } = useTimeTravelSettings(client);
  return (
    <TimeTravelDialog
      title={zh ? "开启前，了解代价与风险" : "Before you enable Time Travel"}
      description={
        zh
          ? "为接下来的每轮对话保存代码检查点，并从历史位置继续。"
          : "Save code checkpoints for future turns and continue from earlier positions."
      }
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="btn outline"
            disabled={busy}
            onClick={onClose}
          >
            {zh ? "暂不开启" : "Not now"}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void update({ enabled: true }).then((ok) => {
                if (ok) onClose();
              })
            }
          >
            {busy
              ? zh
                ? "正在开启…"
                : "Enabling…"
              : zh
                ? "了解风险并开启"
                : "Enable Time Travel"}
          </button>
        </>
      }
    >
      <div className="tt-risk-list">
        <div>
          <Icon name="package" />
          <div>
            <h3>
              {zh ? "占用磁盘，也需要等待" : "Disk space and processing time"}
            </h3>
            <p>
              {zh
                ? "每轮前后读取工作区并压缩保存。大项目和大文件会增加磁盘占用、CPU 开销和等待时间；默认永久保留，可在设置中调整期限与排除规则。"
                : "Reading and compressing the workspace before and after each turn uses disk space and CPU, and can delay large projects. Snapshots are kept forever by default; adjust retention and exclusions in Settings."}
            </p>
          </div>
        </div>
        <div>
          <Icon name="folder" />
          <div>
            <h3>{zh ? "记录整个工作区" : "The whole workspace is captured"}</h3>
            <p>
              {zh
                ? "包括手动修改和其他会话的改动。遵循 Git 忽略规则，普通文件夹默认排除 node_modules；未被排除的敏感文件也会被保存。快照留在执行环境中。"
                : "Manual edits and changes from other sessions are included. Git ignore rules apply; node_modules is excluded in ordinary folders. Sensitive files are saved unless excluded. Snapshots stay on the execution host."}
            </p>
          </div>
        </div>
        <div>
          <Icon name="alert" />
          <div>
            <h3>
              {zh ? "恢复会覆盖当前文件" : "Restoring changes current files"}
            </h3>
            <p>
              {zh
                ? "恢复可能新增、覆盖或删除文件，也可能影响同工作区的其他会话。操作前会展示文件列表并创建备份；对话后续内容保留为分支。外部服务、数据库和已发送操作无法回退。"
                : "A restore may add, overwrite or delete files and affect other sessions in this workspace. You review changes and get a backup first; later messages remain on their branch. External services, databases and sent actions cannot be undone."}
            </p>
          </div>
        </div>
      </div>
      <div className="tt-note">
        <Icon name="info" extra="sm" />
        <p>
          {zh
            ? "开启对本机与已连接远程环境生效，离线环境重连后同步。关闭会停止新快照、隐藏恢复入口，并保留旧快照。开启前的代码无法补录。"
            : "Applies locally and to connected remotes; offline hosts sync on reconnect. Turning it off stops capture and hides restore actions while keeping snapshots. Earlier code cannot be recovered retroactively."}
        </p>
      </div>
      {preview && marks ? (
        <p className="tt-muted">
          {zh
            ? "演示：此次开启只影响预览界面。"
            : "Demo: this only changes the preview interface."}
        </p>
      ) : null}
      {error ? (
        <p className="tt-error" role="alert">
          {error}
        </p>
      ) : null}
    </TimeTravelDialog>
  );
}

export function TimeTravelEntry({
  client,
  onOpen,
  expanded = false,
}: {
  client?: StudioClient | undefined;
  onOpen?: () => void;
  expanded?: boolean;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { settings, error } = useTimeTravelSettings(client);
  const [confirm, setConfirm] = useState(false);
  const enabled = settings?.enabled === true;
  return (
    <>
      {expanded ? (
        <section className="tt-intro" aria-label="Time Travel">
          <span className="tt-intro-icon">
            <Icon name="history" />
          </span>
          <span className="tt-eyebrow">Time Travel</span>
          <h2>
            {zh ? "为接下来的改动保留恢复点" : "Keep a point to return to"}
          </h2>
          <p>
            {zh
              ? "沿时间线查看请求、工具执行与代码检查点，选择恢复代码、对话或两者。"
              : "Follow requests, tool activity and checkpoints. Restore code, conversation, or both."}
          </p>
          <div className="tt-intro-flow" aria-hidden="true">
            <span>
              <Icon name="message" />
              {zh ? "请求" : "Request"}
            </span>
            <i />
            <span>
              <Icon name="code" />
              {zh ? "改动" : "Changes"}
            </span>
            <i />
            <span>
              <Icon name="history" />
              {zh ? "检查点" : "Checkpoint"}
            </span>
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={!settings}
            onClick={() => setConfirm(true)}
          >
            {zh ? "了解并开启" : "Review & enable"}
            <Icon name="arrow-r" extra="sm" />
          </button>
          <small>
            {zh
              ? "默认关闭 · 开启前可查看代价与风险"
              : "Off by default · Review costs and risks first"}
          </small>
          {error ? (
            <p className="tt-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : (
        <button
          type="button"
          className={`tt-entry${enabled ? " is-enabled" : ""}`}
          disabled={!settings}
          data-tip={
            error ??
            (enabled
              ? zh
                ? "查看 Time Travel 时间线"
                : "View Time Travel timeline"
              : zh
                ? "了解并开启 Time Travel"
                : "Review & enable Time Travel")
          }
          onClick={() => {
            if (enabled) onOpen?.();
            else setConfirm(true);
          }}
        >
          <Icon name="history" extra="sm" />
          <span>Time Travel</span>
          <span className="tt-entry-state">
            {enabled ? (zh ? "已开启" : "On") : zh ? "开启" : "Enable"}
          </span>
        </button>
      )}
      {confirm ? (
        <TimeTravelEnableDialog
          client={client}
          onClose={() => setConfirm(false)}
        />
      ) : null}
    </>
  );
}
