import { useEffect, useRef, useState } from "react";
import type { ForeignSessionSummary, ForeignSource, StudioClient, WorkspaceRecord, WorkspaceId } from "@omp-studio/client-contract";
import { invokeUpgrade, useUpgradeAvailable } from "./runtimeUpgrade";
import { hostErrorMessage } from "./hostError";
import { usePreviewMode } from "./preview/PreviewContext";
import { useI18n } from "./i18n";
import { MarkdownText } from "./conversation/markdown";
import { PREVIEW_FOREIGN_SESSIONS, PREVIEW_IMPORT_TEXT } from "./preview/runtimeUpgradeFixtures";

export function SessionImportPanel({ client, onOpen, onImported }: {
 client: StudioClient | null; onOpen: (sessionId: string, workspaceId: WorkspaceId) => void;
 onImported?: () => void;
}) {
 const { preview } = usePreviewMode();
 const { t } = useI18n();
 const available = useUpgradeAvailable(client, preview, "session.import.execute");
 const [open, setOpen] = useState(false);
 const [source, setSource] = useState<ForeignSource>("claude");
 const [sessions, setSessions] = useState<ForeignSessionSummary[]>([]);
 const [selected, setSelected] = useState<ForeignSessionSummary | null>(null);
 const [body, setBody] = useState("");
 const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>([]);
 const [fallback, setFallback] = useState("");
 const [result, setResult] = useState<{ sessionId: string; workspaceId: string } | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 const generation = useRef(0);
 useEffect(() => {
  const gen = ++generation.current;
  setSelected(null); setBody(""); setResult(null); setError(""); setSessions([]);
  if (!open || !available) return;
  if (preview) { setSessions(PREVIEW_FOREIGN_SESSIONS.filter(item => item.source === source)); return; }
  if (!client) return;
  setBusy(true);
  void Promise.all([invokeUpgrade(client, "session.import.list", { source }), client.query("projects.list", {})]).then(([list, projects]) => {
   if (generation.current !== gen) return;
   setSessions(list.sessions); setWorkspaces(projects.workspaces);
  }).catch(cause => { if (generation.current === gen) setError(hostErrorMessage(cause, "Import list unavailable")); })
    .finally(() => { if (generation.current === gen) setBusy(false); });
  return () => { generation.current++; };
 }, [open, available, source, preview, client]);
 const choose = async (item: ForeignSessionSummary) => {
  const gen = ++generation.current;
  setSelected(item); setBody(""); setResult(null); setFallback(""); setBusy(true); setError("");
  try {
   const value = preview ? PREVIEW_IMPORT_TEXT : client ? (await invokeUpgrade(client, "session.import.preview", {source, sourceId:item.sourceId})).preview : "";
   if (gen === generation.current) setBody(value);
  } catch(cause) { if (gen === generation.current) setError(hostErrorMessage(cause, "Import preview failed")); }
  finally { if (gen === generation.current) setBusy(false); }
 };
 const run = async () => {
  if (!selected || busy || result) return;
  setBusy(true); setError("");
  try {
   const imported = preview ? { sessionId:"demo-import",workspaceId:"demo-workspace" } : client ? await invokeUpgrade(client, "session.import.execute", {source,sourceId:selected.sourceId,...(!selected.cwdExists ? {fallbackWorkspaceId:fallback} : {})}) : null;
   setResult(imported); if (!preview && imported) onImported?.();
  } catch(cause) { setError(hostErrorMessage(cause, "Import failed")); }
  finally { setBusy(false); }
 };
 return <div className="session-import">
  <button className="btn small outline" disabled={!available} data-tip={!available ? t("runtimeUpgrade.unavailable") : undefined} onClick={() => setOpen(value => !value)}>{t("runtimeUpgrade.importTitle")}</button>
  {open ? <section className="session-import-panel" aria-label={t("runtimeUpgrade.importTitle")}>
   <div className="row"><select className="select" value={source} disabled={busy} aria-label={t("runtimeUpgrade.importTitle")} onChange={event => setSource(event.target.value as ForeignSource)}><option value="claude">Claude</option><option value="codex">Codex</option></select>
    {preview ? <span className="chip gray">{t("common.demo")}</span> : null}
    <button className="btn small" disabled={busy} onClick={() => setOpen(false)}>{t("common.close")}</button>
   </div>
   {busy ? <p role="status">{t("common.loading")}</p> : null}
   {error ? <p role="alert">{error}</p> : null}
   <div className="session-import-sources">{sessions.map(item => <button className={"btn outline" + (selected?.sourceId === item.sourceId ? " active" : "")} key={item.sourceId} disabled={busy} onClick={() => void choose(item)}>{item.title} · {item.directoryName}</button>)}</div>
   {!busy && sessions.length === 0 ? <p className="muted">{t("history.noMatches")}</p> : null}
   {selected ? <>
    <div className="session-import-preview"><MarkdownText text={body} /></div>
    {!selected.cwdExists ? <label>{t("runtimeUpgrade.importCwd")}<select className="select" value={fallback} disabled={busy} onChange={event => setFallback(event.target.value)}><option value="">—</option>{workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.name}</option>)}</select></label> : null}
    {result ? <div role="status"><p>{t("runtimeUpgrade.importDone")}</p><button className="btn primary" onClick={() => { if (!preview) onOpen(result.sessionId, result.workspaceId as WorkspaceId); }}>{t("common.open")}</button></div> :
    <button className="btn primary" disabled={busy || !body || (!selected.cwdExists && !fallback)} onClick={() => void run()}>{t("runtimeUpgrade.importAction")}</button>}
   </> : null}
  </section> : null}
 </div>;
}
