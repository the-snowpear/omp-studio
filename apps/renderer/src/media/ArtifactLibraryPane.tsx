import { useCallback, useEffect, useRef, useState } from "react";
import { OpenAnnotationArtifact } from "../annotations/Annotations";
import { RecordingPlayer } from "../recordings/RecordingPlayer";
import { PREVIEW_RECORDING } from "../preview/recordingsPreview";
import type { ArtifactKind, ArtifactRecord, ArtifactStorageState, StudioClient } from "@omp-studio/client-contract";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_ARTIFACTS } from "../preview/mediaPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { SettingRow, SettingSection } from "../settings/SettingRow";
import { Icon } from "../icons";
import "./media.css";

export function artifactUrl(artifactId: string): string { return `omp-artifact://library/${encodeURIComponent(artifactId)}`; }
function bytesLabel(bytes: number): string { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }

export function ArtifactStorageSettings({ client }: { client?: StudioClient | undefined }) {
  const { preview } = usePreviewMode();
  const { t } = useI18n();
  const [state, setState] = useState<ArtifactStorageState>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (preview) { setState({ locationName: "Studio Media", writable: true, total: PREVIEW_ARTIFACTS.length, totalBytes: PREVIEW_ARTIFACTS.reduce((sum, item) => sum + item.bytes, 0) }); return; }
    setState(undefined);
    if (client) void client.query("artifacts.storage.get", {}).then(value => { if (active) setState(value); }).catch(cause => { if (active) setError(hostErrorMessage(cause, t("media.unavailable"))); });
    return () => { active = false; };
  }, [client, preview, t]);
  return <SettingSection title={t("media.storage")}>
    <SettingRow label={t("media.location")} desc={t("media.locationDesc")} source={state ? "user" : "unavailable"}>
      <span className="small muted">{state?.locationName ?? t("media.unavailable")}{preview ? ` · ${t("common.demo")}` : ""}</span>
      <button type="button" className="btn small outline" disabled={!preview && !globalThis.ompStudioChrome?.chooseArtifactDirectory} onClick={() => {
        if (preview) { setState(current => current ? { ...current, locationName: "Media" } : current); return; }
        void globalThis.ompStudioChrome?.chooseArtifactDirectory?.().then(result => {
          if (!result.ok) setError(result.message);
          else if (result.storage) { setState(result.storage); setError(""); }
        }).catch(cause => setError(hostErrorMessage(cause, t("media.failed"))));
      }}>{t("media.chooseLocation")}</button>
    </SettingRow>
    {state ? <p className="small muted">{state.total} · {bytesLabel(state.totalBytes)}{state.writable ? "" : ` · ${t("media.readOnly")}`}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </SettingSection>;
}

export function ArtifactLibraryPane({ client, workspaceId, sessionId, refreshKey = 0 }: { client: StudioClient; workspaceId?: string | undefined; sessionId?: string | undefined; refreshKey?: number }) {
  const { preview } = usePreviewMode();
  const { t } = useI18n();
  const [rows, setRows] = useState<readonly ArtifactRecord[]>([]);
  const [kind, setKind] = useState<ArtifactKind | "">("");
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<ArtifactRecord>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async (after?: string) => {
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      if (preview) { setRows(PREVIEW_ARTIFACTS.filter(row => !kind || row.kind === kind)); setCursor(undefined); return; }
      const page = await client.query("artifacts.list", { ...(workspaceId ? { workspaceId } : {}), ...(kind ? { kind } : {}), ...(after ? { cursor: after } : {}), limit: 50 });
      if (generation.current !== token) return;
      setRows(current => after ? [...current, ...page.artifacts] : page.artifacts);
      setCursor(page.nextCursor);
    } catch (cause) { if (generation.current === token) setError(hostErrorMessage(cause, t("media.unavailable"))); }
    finally { if (generation.current === token) setBusy(false); }
  }, [client, workspaceId, kind, preview, t]);
  useEffect(() => { setRows([]); setSelected(undefined); setConfirmDelete(undefined); void load(); return () => { generation.current++; }; }, [load, refreshKey]);
  const remove = async (row: ArtifactRecord) => {
    setBusy(true); setError("");
    try {
      if (preview) setRows(current => current.filter(item => item.artifactId !== row.artifactId));
      else {
        const handle = await client.command("artifacts.delete", { artifactId: row.artifactId });
        await waitReceipt(client, handle.requestId);
        await load();
      }
      if (selected?.artifactId === row.artifactId) setSelected(undefined);
      setConfirmDelete(undefined);
    } catch (cause) { setError(hostErrorMessage(cause, t("media.failed"))); }
    finally { setBusy(false); }
  };
  const importFile = async () => {
    if (preview) { setRows(PREVIEW_ARTIFACTS); return; }
    setBusy(true); setError("");
    try {
      const result = await globalThis.ompStudioChrome?.importArtifact?.({ kind: kind || "image", ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}) });
      if (!result) throw new Error(t("media.unavailable"));
      if (!result.ok) throw new Error(result.message);
      if (!result.cancelled) await load();
    } catch (cause) { setError(hostErrorMessage(cause, t("media.failed"))); }
    finally { setBusy(false); }
  };
  return <section className="artifact-library" aria-label={t("media.library")}>
    <div className="media-toolbar">
      <h3>{t("media.library")}</h3>
      {preview ? <span className="chip gray">{t("common.demo")}</span> : null}
      <select className="select" aria-label={t("media.filter")} value={kind} onChange={event => setKind(event.target.value as ArtifactKind | "")}>
        <option value="">{t("media.all")}</option>
        {(["image", "video", "audio", "judgment", "benchmark", "transcript", "recording", "annotation", "export"] as const).map(value => <option key={value} value={value}>{t(`media.kind.${value}`)}</option>)}
      </select>
      <button type="button" className="btn small outline" disabled={busy || (!preview && !globalThis.ompStudioChrome?.importArtifact)} onClick={() => void importFile()}>{t("media.import")}</button>
      <button type="button" className="btn small" disabled={busy} onClick={() => void load()}>{t("media.refresh")}</button>
    </div>
    {error ? <p role="alert" className="media-error">{error}</p> : null}
    {busy ? <p className="small muted" role="status">{t("common.loading")}</p> : null}
    {!busy && !error && !rows.length ? <p className="empty muted">{t("media.empty")}</p> : null}
    <div className="media-library-layout">
      <div className="media-file-list">{rows.map(row => <div key={row.artifactId} className={`media-file-row${selected?.artifactId === row.artifactId ? " is-selected" : ""}`}>
        <button type="button" className="media-file-select" onClick={() => setSelected(row)}><Icon name={row.kind === "image" ? "image" : row.kind === "audio" ? "mic" : "file"} extra="sm" /><span><strong>{row.name}</strong><small>{t(`media.kind.${row.kind}`)} · {bytesLabel(row.bytes)}</small></span></button>
        {confirmDelete === row.artifactId ? <span className="row"><button type="button" className="btn small" disabled={busy} onClick={() => void remove(row)}>{t("media.confirmDelete")}</button><button type="button" className="btn small" onClick={() => setConfirmDelete(undefined)}>{t("common.cancel")}</button></span> : <button type="button" className="btn small icon" aria-label={t("common.delete")} disabled={busy} onClick={() => setConfirmDelete(row.artifactId)}><Icon name="trash" extra="sm" /></button>}
      </div>)}</div>
      {selected ? <div className="media-inspector">
        {selected.kind === "annotation" ? <OpenAnnotationArtifact artifactId={selected.artifactId} /> : null}
        <div className="media-toolbar"><strong>{selected.name}</strong><button type="button" className="btn small outline" disabled={!preview && !globalThis.ompStudioChrome?.exportArtifact} onClick={() => {
          if (preview) return;
          void globalThis.ompStudioChrome?.exportArtifact?.({ artifactId: selected.artifactId }).then(result => { if (!result.ok) setError(result.message); }).catch(cause => setError(hostErrorMessage(cause, t("media.failed"))));
        }}>{t("media.saveAs")}</button></div>
        {!preview && !globalThis.ompStudioChrome?.exportArtifact ? <p className="muted">{t("media.unavailable")}</p> : selected.kind === "recording" ? <RecordingPlayer key={selected.artifactId} {...(preview ? { demoText: PREVIEW_RECORDING } : { artifactId: selected.artifactId })} /> : preview ? <div className="media-demo-preview"><Icon name="image" /><span>{t("common.demo")}</span></div> : selected.kind === "image" ? <img src={artifactUrl(selected.artifactId)} alt={selected.name} /> : selected.kind === "video" ? <video key={selected.artifactId} controls preload="metadata" src={artifactUrl(selected.artifactId)} /> : selected.kind === "audio" ? <audio key={selected.artifactId} controls preload="metadata" src={artifactUrl(selected.artifactId)} /> : <p className="muted">{t("media.exportToView")}</p>}
        <p className="small muted">{new Date(selected.createdAt).toLocaleString()} · {bytesLabel(selected.bytes)}</p>
      </div> : null}
    </div>
    {cursor ? <button type="button" className="btn outline" disabled={busy} onClick={() => void load(cursor)}>{t("media.more")}</button> : null}
  </section>;
}
