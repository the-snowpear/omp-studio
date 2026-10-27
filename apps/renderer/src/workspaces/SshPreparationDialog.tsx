import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import type { RemoteConnectionProfile, RemoteConnectionStatus } from "../../../desktop/src/remote/shared";
import "./ssh.css";

const STAGES = ["probe", "confirmation", "download", "upload", "install", "verify", "configure", "connect"];
const LABELS = ["识别系统", "确认准备", "下载运行包", "上传文件", "安装环境", "验证 Runtime", "同步模型", "连接工作区"];
export function SshPreparationDialog({ profile, status, demo = false, onApprove, onCancel }: { profile: RemoteConnectionProfile; status: RemoteConnectionStatus; demo?: boolean; onApprove(): void; onCancel(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  const confirm = status.state === "awaiting-approval";
  const step = Math.max(0, STAGES.indexOf(status.stage ?? "probe"));
  const percent = status.totalBytes ? Math.round((status.receivedBytes ?? 0) / status.totalBytes * 100) : undefined;
  const system = status.platform === "win32" ? "Windows" : status.platform === "darwin" ? "macOS" : status.platform === "linux" ? "Linux" : "自动识别中";
  return createPortal(<dialog ref={dialog} className="ssh-dialog ssh-preparation" aria-labelledby="ssh-preparation-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <div className="ssh-dialog-head"><h2 id="ssh-preparation-title">{confirm ? "准备远端工作区" : "连接 SSH 工作区"}{demo ? <span className="chip xs">演示</span> : null}</h2><button className="icon-btn" aria-label="取消连接" onClick={onCancel}><Icon name="x" /></button></div>
    <p className="ssh-preparation-target"><Icon name="terminal" /><strong>{profile.name}</strong><span>{system}{status.arch ? ` · ${status.arch}` : ""}</span></p>
    <ol className="ssh-preparation-steps">{["连接与体检", "准备运行环境", "选择项目"].map((label, index) => <li key={label} aria-current={index === (step < 2 ? 0 : 1) ? "step" : undefined}>{index + 1}<span>{label}</span></li>)}</ol>
    {confirm ? <>
      <p>将自动安装私有 Node、OMP Studio Host 和签名 Runtime，远端无需预装 Node。</p>
      <p className="muted small">安装位置</p><code className="ssh-install-path">{status.installRoot}</code>
      <p className="muted small">本机模型配置与 API Key 会同步到这台机器的私有配置中。OAuth 由本机统一刷新，刷新令牌保留本机。</p>
      <p className="muted small">默认由远端联网，网络连接失败时通过本机联网。文件、命令与构建在远端执行。</p>
      <div className="ssh-dialog-actions"><button className="btn outline" onClick={onCancel}>取消</button><button className="btn primary" autoFocus onClick={onApprove}>安装并连接{demo ? "（演示）" : ""}</button></div>
    </> : <>
      <p role="status"><span className="spinner" /> {status.message || LABELS[step]}</p>
      <progress className="ssh-preparation-progress" max={100} {...(percent !== undefined ? { value: percent } : {})} aria-label={LABELS[step]} />
      {percent !== undefined ? <p className="muted small">{percent}% · {((status.receivedBytes ?? 0) / 1048576).toFixed(1)} / {((status.totalBytes ?? 0) / 1048576).toFixed(1)} MB</p> : null}
      <p className="muted small">{LABELS[step]} · 已安装的环境会在后续连接中复用。</p>
      <div className="ssh-dialog-actions"><button className="btn outline" onClick={onCancel}>取消连接</button></div>
    </>}
  </dialog>, document.body);
}
