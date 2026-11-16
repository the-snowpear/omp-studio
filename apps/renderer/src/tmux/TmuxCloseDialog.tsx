import { useState } from "react";
import { useI18n } from "../i18n";
import { WorkspaceDialog } from "../workspaces/Workspace";

export function TmuxCloseDialog({ name, onClose, onChoose }: { name: string; onClose(): void; onChoose(action: "hide" | "kill", remember: boolean): void }) {
  const { t } = useI18n();
  const [remember, setRemember] = useState(false);
  return <WorkspaceDialog title={t("terminal.tmux.closeTitle", { name })} onClose={onClose}>
    <p>{t("terminal.tmux.closeDetail")}</p>
    <label className="tmux-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{t("terminal.tmux.remember")}</label>
    <div className="tmux-dialog-actions">
      <button type="button" className="btn outline" onClick={onClose}>{t("terminal.tmux.cancel")}</button>
      <button type="button" className="btn outline" onClick={() => onChoose("hide", remember)}>{t("terminal.tmux.hide")}</button>
      <button type="button" className="btn danger" onClick={() => onChoose("kill", remember)}>{t("terminal.tmux.killWindow")}</button>
    </div>
  </WorkspaceDialog>;
}
