import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { RemoteConnectionProfile } from "../../../desktop/src/remote/shared";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import "./ssh.css";

export function SshPasswordDialog({ profile, demo = false, onSubmit, onCancel }: { profile: RemoteConnectionProfile; demo?: boolean; onSubmit(password: string): void; onCancel(): void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  const dialog = useRef<HTMLDialogElement>(null);
  const password = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const input = password.current;
    dialog.current?.showModal();
    input?.focus();
    return () => { if (input) input.value = ""; previous?.focus(); };
  }, []);
  const cancel = () => { if (password.current) password.current.value = ""; onCancel(); };
  return createPortal(<dialog ref={dialog} className="ssh-dialog" aria-labelledby="ssh-password-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <div className="ssh-dialog-head"><h2 id="ssh-password-title">{zh ? "连接 SSH" : "Connect SSH"} · {profile.name}</h2><button type="button" className="icon-btn" aria-label={zh ? "取消连接" : "Cancel connection"} onClick={cancel}><Icon name="x" /></button></div>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      let value = password.current?.value ?? "";
      if (!value) return;
      if (password.current) password.current.value = "";
      onSubmit(value);
      value = "";
    }}>
      <p className="muted small">{profile.user}@{profile.host}{profile.port ? `:${profile.port}` : ""}</p>
      <label>{zh ? "SSH 密码" : "SSH password"}<input ref={password} type="password" required autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={4096} /></label>
      <p className="muted small">{demo && marks ? (zh ? "演示模式：不连接服务器，请勿输入真实密码。" : "Preview mode: does not connect to any server. Do not enter a real password.") : (zh ? "只在本次连接期间保留于主进程内存，断开后清除。不会保存到连接配置、写入命令行或复制到远端文件。" : "Kept only in main-process memory during this connection and cleared on disconnect. Never saved to connection profiles, command lines, or remote files.")}</p>
      <p className="muted small">{zh ? "首次主机信任仍需在系统 SSH 完成。暂不支持密码变更、验证码或多因素登录。" : "First-time host trust must still be accepted via system SSH. Password changes, one-time codes, and MFA are not supported yet."}</p>
      <div className="ssh-dialog-actions"><button type="button" className="btn outline" onClick={cancel}>{zh ? "取消" : "Cancel"}</button><button className="btn primary">{zh ? "连接" : "Connect"}</button></div>
    </form>
  </dialog>, document.body);
}
