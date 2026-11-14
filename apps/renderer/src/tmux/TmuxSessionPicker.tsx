import { useEffect, useState } from "react";
import { TMUX_SESSION_NAME_PATTERN, type TmuxSessionsResult } from "../../../desktop/src/tmux/tmux-shared";
import { useI18n } from "../i18n";
import { WorkspaceDialog } from "../workspaces/Workspace";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_TMUX_SESSIONS } from "../preview/tmuxPreview";
import type { TerminalSessions } from "../terminalSessions";
import "../history/sessionPicker.css";

export function TmuxSessionPicker({ store, targetId, workspaceId, defaultName, onAttach, onClose }: {
  store: TerminalSessions; targetId: string | null; workspaceId?: string | undefined; defaultName: string;
  onAttach(name: string): Promise<void>; onClose(): void;
}) {
  const { t, resolvedLanguage } = useI18n(), { preview, marks } = usePreviewMode();
  const [result, setResult] = useState<TmuxSessionsResult>();
  const [error, setError] = useState("");
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(undefined); setError("");
    if (preview) setResult({ available: true, version: "3.7c", sessions: PREVIEW_TMUX_SESSIONS });
    else void store.listTmuxSessions(targetId!, workspaceId!).then(value => { if (active) setResult(value); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [store, targetId, workspaceId, preview, reload]);
  const attach = async (name: string) => {
    setBusy(true); setError("");
    try { await onAttach(name); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <WorkspaceDialog title={t("terminal.tmux.attach")} onClose={onClose}>
    {preview && marks ? <span className="chip purple xs">{t("terminal.tmux.demo")}</span> : null}
    {!result && !error ? <p role="status">{t("terminal.tmux.loading")}</p> : null}
    {result && !result.available ? <p role="alert">{t(`terminal.tmux.errors.${result.reason}`)} {result.version}{result.reason === "ssh-failed" ? ` · ${result.message}` : ""}</p> : null}
    {result?.available ? <>
      <ul className="session-picker-list" aria-label={t("terminal.tmux.sessions")}>
        {result.sessions.map(session => <li key={session.id}><button type="button" className="session-picker-row" disabled={busy} onClick={() => void attach(session.name)}>
          <span className="session-picker-row-top"><strong>{session.name}</strong></span>
          <span className="session-picker-meta">{t("terminal.tmux.sessionMeta", { windows: session.windows, attached: session.attached })} · {new Date(session.createdAt).toLocaleString(resolvedLanguage)}</span>
        </button></li>)}
      </ul>
      {!result.sessions.length ? <p>{t("terminal.tmux.noSessions")}</p> : null}
      <form onSubmit={event => { event.preventDefault(); void attach(name); }}>
        <label className="tmux-name-label">{t("terminal.tmux.newSession")}<input className="input" value={name} onChange={event => setName(event.target.value)} aria-invalid={!TMUX_SESSION_NAME_PATTERN.test(name)} /></label>
        <p className="muted small">{t(TMUX_SESSION_NAME_PATTERN.test(name) ? "terminal.tmux.existingName" : "terminal.tmux.nameHint")}</p>
        <div className="tmux-dialog-actions"><button className="btn outline" type="button" disabled={busy} onClick={() => setReload(value => value + 1)}>{t("terminal.tmux.refresh")}</button><button className="btn primary" disabled={busy} type="submit">{t("terminal.tmux.createAttach")}</button></div>
      </form>
    </> : <button className="btn outline" type="button" onClick={() => setReload(value => value + 1)}>{t("terminal.tmux.refresh")}</button>}
    {error ? <p role="alert">{error}</p> : null}
  </WorkspaceDialog>;
}
