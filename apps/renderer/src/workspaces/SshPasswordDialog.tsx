import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { RemoteConnectionProfile } from "../../../desktop/src/remote/shared";
import { Icon } from "../icons";
import "./ssh.css";

export function SshPasswordDialog({ profile, demo = false, onSubmit, onCancel }: { profile: RemoteConnectionProfile; demo?: boolean; onSubmit(password: string): void; onCancel(): void }) {
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
    <div className="ssh-dialog-head"><h2 id="ssh-password-title">连接 SSH · {profile.name}</h2><button type="button" className="icon-btn" aria-label="取消连接" onClick={cancel}><Icon name="x" /></button></div>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      let value = password.current?.value ?? "";
      if (!value) return;
      if (password.current) password.current.value = "";
      onSubmit(value);
      value = "";
    }}>
      <p className="muted small">{profile.user}@{profile.host}{profile.port ? `:${profile.port}` : ""}</p>
      <label>SSH 密码<input ref={password} type="password" required autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={4096} /></label>
      <p className="muted small">{demo ? "演示模式：不连接服务器，请勿输入真实密码。" : "只在本次连接期间保留于主进程内存，断开后清除。不会保存到连接配置、写入命令行或复制到远端文件。"}</p>
      <p className="muted small">首次主机信任仍需在系统 SSH 完成。暂不支持密码变更、验证码或多因素登录。</p>
      <div className="ssh-dialog-actions"><button type="button" className="btn outline" onClick={cancel}>取消</button><button className="btn primary">连接</button></div>
    </form>
  </dialog>, document.body);
}
