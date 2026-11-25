import { useEffect, useState } from "react";
import type { StudioClient, WorkspaceListReadModel, WorkspaceRecord } from "@omp-studio/client-contract";
import { initializeConversationClient } from "../conversationWorkspace/client";
import { hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { getPreviewWorkspaceRecovery } from "../preview/fixtures";
import { waitForCommandReceipt } from "../sessionLifecycle";
import { pickProject as chooseHostProject } from "../web/chooseProject";

/** Recovery uses the connection's root client, so a stale conversation cannot block it. */
export function WorkspaceRecoveryPane({ client, onOpenWorkspace, onChooseRemoteWorkspace }: {
  client: StudioClient;
  onOpenWorkspace?: (workspace: WorkspaceRecord) => void;
  onChooseRemoteWorkspace?: () => void;
}) {
  const { preview, marks } = usePreviewMode();
  const { t, resolvedLanguage } = useI18n();
  const [model, setModel] = useState<WorkspaceListReadModel>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [previewCleared, setPreviewCleared] = useState(false);
  const fixture = getPreviewWorkspaceRecovery(resolvedLanguage === "zh");
  const view = preview ? { ...fixture, workspaces: fixture.workspaces.filter(row => !previewCleared || !row.unavailable) } : model;
  const stale = view?.workspaces.filter(row => row.unavailable) ?? [];
  const active = view?.workspaces.find(row => row.workspaceId === view.activeWorkspaceId && !row.unavailable);

  useEffect(() => {
    if (preview) return;
    let current = true;
    client.query("projects.list", {}).then(value => { if (current) { setModel(value); setError(undefined); } }, failure => { if (current) setError(failure); });
    return () => { current = false; };
  }, [client, preview]);

  const submit = async (kind: "choose" | "forget") => {
    if (preview) {
      if (kind === "forget") setPreviewCleared(true);
      if (marks) setNotice(kind === "forget" ? "workspaceRecovery.forgotten" : "workspaceRecovery.chosen");
      return;
    }
    if (kind === "choose" && onChooseRemoteWorkspace) { onChooseRemoteWorkspace(); return; }
    if (kind === "forget" && !window.confirm(t("workspaceRecovery.confirmForget"))) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await initializeConversationClient(client);
      const handle = kind === "choose"
        ? await chooseHostProject(client)
        : await client.command("workspace.forgetUnavailable", {});
      if (!handle) return;
      const receipt = await waitForCommandReceipt(client, handle.requestId);
      if (receipt.status === "failed") throw receipt.error;
      if (receipt.status !== "completed") throw new Error(t("workspaceRecovery.actionFailed"));
      const result = receipt.result as WorkspaceListReadModel;
      setModel(result);
      setNotice(kind === "forget" ? "workspaceRecovery.forgotten" : "workspaceRecovery.chosen");
      const chosen = result.workspaces.find(row => row.workspaceId === result.activeWorkspaceId);
      if (kind === "choose" && chosen) onOpenWorkspace?.(chosen);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };

  return <section className="diag-section" aria-label={t("workspaceRecovery.title")} aria-busy={busy}>
    <h3>{t("workspaceRecovery.title")}{preview && marks ? <span className="chip gray xs">{t("agentDeck.demo")}</span> : null}</h3>
    <div className="set-section">
      <div className="set-row">
        <div><div className="sr-desc">{t("workspaceRecovery.description")}</div>{!active ? <p className="small muted">{t("workspaceRecovery.empty")}</p> : null}</div>
        <div className="sr-control"><button type="button" className="btn outline" disabled={busy} onClick={() => void submit("choose")}><Icon name="folder" extra="sm" />{t("workspaceRecovery.choose")}</button></div>
      </div>
      {active && onOpenWorkspace ? <div className="set-row"><div className="mono small wrap">{active.root ?? active.name}</div><button type="button" className="btn outline" disabled={busy} onClick={() => {
        if (preview) { if (marks) setNotice("workspaceRecovery.chosen"); }
        else onOpenWorkspace(active);
      }}>{t("workspaceRecovery.newChat", { name: active.name })}</button></div> : null}
      {stale.map(row => <div className="set-row" key={row.workspaceId}><div><div className="sr-label">{row.name}</div><div className="mono small wrap">{row.root}</div></div><span className="chip amber xs">{t("workspaceRecovery.unavailable")}</span></div>)}
      {stale.length ? <div className="set-row"><span className="sr-desc">{t("workspaceRecovery.staleCount", { count: stale.length })}</span><button type="button" className="btn outline" disabled={busy} onClick={() => void submit("forget")}>{t("workspaceRecovery.forget")}</button></div> : null}
      {error ? <p className="small" role="alert">{hostErrorMessage(error, t(model ? "workspaceRecovery.actionFailed" : "workspaceRecovery.loadFailed"))}</p> : null}
      {notice && (!preview || marks) ? <p className="small" role="status">{t(notice)}</p> : null}
    </div>
  </section>;
}
