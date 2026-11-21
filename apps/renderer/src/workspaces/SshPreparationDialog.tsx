import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { RemoteConnectionProfile, RemoteConnectionStatus } from "../../../desktop/src/remote/shared";
import { SshDialogHead } from "./sshParts";
import "./ssh.css";

const STAGES = ["probe", "confirmation", "download", "upload", "install", "verify", "configure", "connect"];
const LABELS_ZH = ["识别系统", "确认准备", "下载运行包", "上传文件", "安装环境", "验证 Runtime", "同步模型", "连接工作区"];
const LABELS_EN = ["Detect OS", "Confirm setup", "Download package", "Upload files", "Install runtime env", "Verify Runtime", "Sync models", "Connect workspace"];
/** The stages after approval, drawn as the thin segment strip under the progress bar. */
const RUN_STAGES = STAGES.slice(2);
const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1);

export function SshPreparationDialog({ profile, kind = profile.kind, status, demo = false, onApprove, onCancel }: { profile: RemoteConnectionProfile; kind?: RemoteConnectionProfile["kind"]; status: RemoteConnectionStatus; demo?: boolean; onApprove(): void; onCancel(): void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const labels = zh ? LABELS_ZH : LABELS_EN;
  const { marks } = usePreviewMode();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  const wsl = kind === "wsl";
  const confirm = status.state === "awaiting-approval";
  const step = Math.max(0, STAGES.indexOf(status.stage ?? "probe"));
  const phase = step === 0 && !confirm ? 0 : 1;
  const percent = status.totalBytes ? Math.min(100, Math.round((status.receivedBytes ?? 0) / status.totalBytes * 100)) : undefined;
  const system = status.platform === "win32" ? "Windows" : status.platform === "darwin" ? "macOS" : status.platform === "linux" ? "Linux" : undefined;
  const network = profile.networkMode ?? "remote-first";
  const networkText = network === "remote-only" ? (zh ? "仅远端联网" : "Remote network only")
    : network === "local-only" ? (zh ? "仅通过本机联网" : "Through this computer only")
    : wsl ? (zh ? "WSL 网络优先，失败时经本机" : "WSL network first, falls back through this computer")
    : (zh ? "远端优先，失败时经本机" : "Remote first, falls back through this computer");
  const title = wsl ? (confirm ? (zh ? "准备 WSL 工作区" : "Prepare WSL workspace") : (zh ? "连接 WSL 工作区" : "Connect WSL workspace"))
    : confirm ? (zh ? "准备远端工作区" : "Prepare remote workspace") : (zh ? "连接 SSH 工作区" : "Connect SSH workspace");
  const phases = zh ? ["连接与体检", "准备运行环境", "选择项目"] : ["Connect & inspect", "Prepare runtime", "Choose project"];
  const runIndex = RUN_STAGES.indexOf(STAGES[step]!);
  const message = status.message && status.message !== labels[step] ? status.message : undefined;

  return createPortal(<dialog ref={dialog} className="ssh-dialog" aria-labelledby="ssh-preparation-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <SshDialogHead icon={wsl ? "layers" : "server"} titleId="ssh-preparation-title" title={title}
      badge={demo && marks ? <span className="chip xs">{zh ? "演示" : "Preview"}</span> : null}
      sub={<><strong>{profile.name}</strong>{system ? <span className="ssh-tag">{system}</span> : <span className="ssh-tag is-pending">{zh ? "识别中" : "Detecting"}</span>}{status.arch ? <span className="ssh-tag">{status.arch}</span> : null}</>}
      closeLabel={zh ? "取消连接" : "Cancel connection"} onClose={onCancel} />
    <ol className="ssh-steps" aria-label={zh ? "准备进度" : "Preparation progress"}>
      {phases.map((label, index) => {
        const state = index < phase ? "done" : index === phase ? "current" : "pending";
        return <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined} {...(state === "current" && confirm ? { "data-waiting": "" } : {})}>
          <span className="ssh-step-dot">{state === "done" ? <Icon name="check" /> : index + 1}</span><span>{label}</span>
        </li>;
      })}
    </ol>
    {confirm ? <div className="ssh-dialog-body">
      <div className="ssh-phase" key="confirm">
        <p className="ssh-lead">{wsl ? (zh ? `将在 ${profile.name} 中安装 OMP Studio 运行环境，不影响发行版自带的 Node。` : `Installs the OMP Studio runtime inside ${profile.name}, leaving the distribution’s own Node alone.`) : (zh ? "将在这台机器上安装 OMP Studio 运行环境，无需预装 Node。" : "Installs the OMP Studio runtime on this machine. No preinstalled Node needed.")}</p>
        <dl className="ssh-facts">
          <div><Icon name="package" extra="sm" /><dt>{zh ? "安装内容" : "Installs"}</dt><dd><span className="ssh-pills"><span>{zh ? "私有 Node" : "Private Node"}</span><span>Studio Host</span><span>{zh ? "签名 Runtime" : "Signed Runtime"}</span></span></dd></div>
          <div><Icon name="folder-open" extra="sm" /><dt>{zh ? "安装位置" : "Location"}</dt><dd><code>{status.installRoot}</code></dd></div>
          <div><Icon name="key" extra="sm" /><dt>{zh ? "模型配置" : "Models"}</dt><dd>{zh ? "从本机同步模型与 API Key" : "Models and API keys sync from this computer"}<small>{zh ? "OAuth 刷新令牌保留在本机" : "OAuth refresh tokens stay on this computer"}</small></dd></div>
          <div><Icon name="globe" extra="sm" /><dt>{zh ? "联网" : "Network"}</dt><dd>{networkText}</dd></div>
        </dl>
      </div>
    </div> : <div className="ssh-dialog-body">
      <div className="ssh-phase" key="run">
        <div className="ssh-stage" role="status" aria-live="polite">
          <div className="ssh-stage-head">
            <span className="spinner" aria-hidden="true" />
            <div><strong key={step}>{labels[step]}</strong>{message ? <small>{message}</small> : null}</div>
            {percent !== undefined ? <span className="ssh-stage-percent">{percent}%</span> : null}
          </div>
          <div className={percent === undefined ? "ssh-progress is-sweep" : "ssh-progress"} role="progressbar" aria-label={labels[step]} aria-valuemin={0} aria-valuemax={100} {...(percent !== undefined ? { "aria-valuenow": percent } : {})}>
            <span style={percent !== undefined ? { width: `${percent}%` } : undefined} />
          </div>
          {runIndex >= 0 ? <ol className="ssh-stage-list" aria-hidden="true">{RUN_STAGES.map((stage, index) => <li key={stage} data-state={index < runIndex ? "done" : index === runIndex ? "current" : "pending"} />)}</ol> : null}
          {percent !== undefined || runIndex >= 0 ? <div className="ssh-stage-meta">
            <span>{percent !== undefined ? `${megabytes(status.receivedBytes ?? 0)} / ${megabytes(status.totalBytes ?? 0)} MB` : ""}</span>
            {runIndex >= 0 ? <span>{runIndex + 1} / {RUN_STAGES.length}</span> : null}
          </div> : null}
        </div>
      </div>
    </div>}
    <footer className="ssh-dialog-foot">
      {confirm ? <>
        <button type="button" className="btn outline" onClick={onCancel}>{zh ? "取消" : "Cancel"}</button>
        <button type="button" className="btn primary" autoFocus onClick={onApprove}>{zh ? "安装并连接" : "Install & connect"}{demo && marks ? (zh ? "（演示）" : " (Preview)") : ""}</button>
      </> : <button type="button" className="btn outline" onClick={onCancel}>{zh ? "取消连接" : "Cancel connection"}</button>}
    </footer>
  </dialog>, document.body);
}
