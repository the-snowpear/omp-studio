import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RemoteConnectionProfile } from "../../../desktop/src/remote/shared";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { SshDialogHead, SshField } from "./sshParts";
import "./ssh.css";

export function SshPasswordDialog({ profile, demo = false, onSubmit, onCancel }: { profile: RemoteConnectionProfile; demo?: boolean; onSubmit(password: string): void; onCancel(): void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  const dialog = useRef<HTMLDialogElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const input = password.current;
    dialog.current?.showModal();
    input?.focus();
    return () => { if (input) input.value = ""; previous?.focus(); };
  }, []);
  const cancel = () => { if (password.current) password.current.value = ""; onCancel(); };
  const account = profile.user ? `${profile.user}@${profile.host}` : profile.host;
  return createPortal(<dialog ref={dialog} className="ssh-dialog is-compact" aria-labelledby="ssh-password-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      let value = password.current?.value ?? "";
      if (!value) return;
      if (password.current) password.current.value = "";
      onSubmit(value);
      value = "";
    }}>
      <SshDialogHead icon="lock" titleId="ssh-password-title" title={zh ? `连接 ${profile.name}` : `Connect to ${profile.name}`}
        sub={<><code>{account}</code>{profile.port ? <span className="ssh-tag">:{profile.port}</span> : null}</>}
        closeLabel={zh ? "取消连接" : "Cancel connection"} onClose={cancel} />
      <div className="ssh-dialog-body">
        <SshField label={zh ? "SSH 密码" : "SSH password"} htmlFor="ssh-password-input">
          <div className="ssh-input-affix">
            <Icon name="key" extra="sm" />
            <input id="ssh-password-input" ref={password} className="ssh-input has-action" type={visible ? "text" : "password"} required autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={4096} />
            <button type="button" className="icon-btn" aria-label={visible ? (zh ? "隐藏密码" : "Hide password") : (zh ? "显示密码" : "Show password")} aria-pressed={visible} onClick={() => { setVisible(value => !value); password.current?.focus(); }}><Icon name={visible ? "eye-off" : "eye"} extra="sm" /></button>
          </div>
        </SshField>
        {demo && marks
          ? <p className="ssh-alert is-warn"><Icon name="alert" extra="sm" />{zh ? "演示模式不会连接服务器，请勿输入真实密码。" : "Preview mode does not connect anywhere. Do not enter a real password."}</p>
          : <p className="ssh-note"><Icon name="shield" extra="sm" />{zh ? "仅在本次连接期间保留，不会保存。" : "Kept only for this connection, never saved."}</p>}
      </div>
      <footer className="ssh-dialog-foot">
        <button type="button" className="btn outline" onClick={cancel}>{zh ? "取消" : "Cancel"}</button>
        <button className="btn primary">{zh ? "连接" : "Connect"}</button>
      </footer>
    </form>
  </dialog>, document.body);
}
