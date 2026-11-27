import { useEffect, useRef, useState } from "react";
import type { TodoBackendState, TodoBackendOperation } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { isSystemFilePath } from "@omp-studio/client-contract";
import { useOpenFile } from "../files/fileLinks";
import { useConversationView } from "../conversationWorkspace/Context";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { revealMainWindow } from "../dock/SurfaceContext";
import { WorkspaceDialog } from "../workspaces/Workspace";
import { Icon } from "../icons";
import { PREVIEW_TODO_BACKEND_SOURCE, getPreviewTodoBackends } from "../preview/todoBackendPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { SettingRow, SettingSection } from "./SettingRow";
import { Callout, StatePill, type StateTone } from "../workspaces/StatusBits";
import { useSettingsScope } from "./SettingsScope";
import type { FeatureSettingsProps } from "./useFeatureSettings";

export function TodoBackendSettings({ client, context, visible }: FeatureSettingsProps) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const [scope] = useSettingsScope();
  const openFile = useOpenFile(), view = useConversationView(), executionTarget = useExecutionTarget();
  const [sourceVisible, setSourceVisible] = useState(false), [sourceUnavailable, setSourceUnavailable] = useState(false);
  const [state, setState] = useState<TodoBackendState>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const epoch = useRef(0), zhRef = useRef(zh); zhRef.current = zh;
  const supports = (kind: string) => preview || context?.capabilities?.capabilities.some(row => row.id === kind && row.grade !== "unavailable") === true;
  const enabled = preview || !!(client && context?.available && context.sessionId && supports("todo.backends.get"));
  const invoke = async (op: TodoBackendOperation) => {
    const { kind, ...input } = op;
    const handle = await client!.command(kind, input);
    return (await waitReceipt<{ result: TodoBackendState }>(client!, handle.requestId)).result;
  };
  useEffect(() => {
    const generation = ++epoch.current;
    setState(preview ? getPreviewTodoBackends(zhRef.current) : undefined); setError(""); setBusy(false);
    if (preview || !visible || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await invoke({ kind: "todo.backends.get", sessionId: context!.sessionId! });
        if (generation !== epoch.current) return;
        setState(next); setError("");
      } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zhRef.current ? "无法读取 Todo 后端" : "Could not read Todo backends")); }
      if (generation === epoch.current) timer = setTimeout(() => void read(), 4000);
    };
    void read();
    return () => { epoch.current++; clearTimeout(timer); };
  }, [client, context?.sessionId, enabled, visible, preview]);
  const run = async (backend?: string) => {
    const generation = epoch.current;
    setBusy(true); setError("");
    try {
      if (preview) { setState(current => current && ({ ...current, selected: backend ?? current.selected, source: scope === "session" ? "runtime" : "global", sync: { state: (backend ?? current.selected) === "native" ? "native" : "synced", updatedAt: Date.now() } })); return; }
      const next = await invoke(backend === undefined ? { kind: "todo.backend.sync", sessionId: context!.sessionId! } : { kind: "todo.backend.set", sessionId: context!.sessionId!, backend, scope });
      if (generation === epoch.current) setState(next);
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "Todo 后端操作失败" : "Todo backend action failed")); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  const previewLabels = preview ? getPreviewTodoBackends(zh).backends : undefined;
  const selected = (previewLabels ?? state?.backends)?.find(row => row.id === state?.selected);
  useEffect(() => { setSourceVisible(false); setSourceUnavailable(false); }, [selected?.id, client, context?.sessionId, preview]);
  const openSource = () => {
    if (!selected?.extensionPath) return;
    setSourceUnavailable(false);
    if (preview) { setSourceVisible(true); return; }
    const system = isSystemFilePath(selected.extensionPath);
    const opened = openFile({ path: selected.extensionPath, targetId: view ? view.document.ref.targetId : executionTarget.id,
      ...(system ? { source: "system" as const } : view?.document.ref.workspaceId ? { workspaceId: view.document.ref.workspaceId } : {}),
      onOpened: () => { revealMainWindow(true); },
    });
    setSourceUnavailable(!opened);
  };
  const tones: Record<TodoBackendState["sync"]["state"], StateTone> = { native: "idle", unavailable: "warn", idle: "idle", queued: "active", syncing: "active", synced: "ready", failed: "blocked" };
  const labels = zh ? { native: "仅保存在会话", unavailable: "后端扩展未加载", idle: "等待同步", queued: "同步已排队", syncing: "正在同步", synced: "已同步", failed: "同步失败，下次修改重试" } : { native: "Stored in this session", unavailable: "Backend extension is not loaded", idle: "Waiting to sync", queued: "Sync queued", syncing: "Syncing", synced: "Synced", failed: "Sync failed; retries on the next change" };
  return <SettingSection title={zh ? "Todo 后端" : "Todo backend"} desc={zh ? "原生列表保留在会话中。外部后端由已启用扩展注册，切换后立即同步当前列表。" : "The native list stays in the session. Enabled extensions register external backends; selecting one immediately mirrors the current list."}>
    <SettingRow label={zh ? "同步到" : "Mirror to"} {...(selected?.description ? { desc: selected.description } : {})} source={!enabled ? "unavailable" : state?.source === "global" ? "user" : state?.source ?? "runtime"} reason={zh ? "连接支持 Todo 后端的 Runtime 后可配置。" : "Connect a Runtime that supports Todo backends."}>
      <AppSelect aria-label={zh ? "Todo 后端" : "Todo backend"} value={state?.selected ?? ""} disabled={!enabled || !state || busy || !supports("todo.backend.set")} onChange={event => void run(event.target.value)}>
        {!state ? <option value="">{zh ? "未读取" : "Not loaded"}</option> : null}
        {state && !selected ? <option value={state.selected}>{state.selected}</option> : null}
        {(previewLabels ?? state?.backends)?.map(row => <option key={row.id} value={row.id}>{row.id === "native" ? (zh ? "原生会话列表" : "Native session list") : row.label}</option>)}
      </AppSelect>
      {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
    </SettingRow>
    {selected?.extensionPath ? <SettingRow label={zh ? "后端所属扩展" : "Backend extension"} desc={selected.extensionPath}>
      <button type="button" className="btn small outline" onClick={openSource}><Icon name="file-code" extra="sm" />{zh ? "查看扩展源码" : "View extension source"}</button>
    </SettingRow> : null}
    {sourceUnavailable ? <Callout tone="info">{zh ? "当前界面未连接文件查看器。请在工作台打开上方扩展路径。" : "The file viewer is not available in this view. Open the extension path above from the workbench."}</Callout> : null}
    {sourceVisible && selected?.extensionPath ? <WorkspaceDialog title={zh ? "后端扩展源码" : "Backend extension source"} onClose={() => setSourceVisible(false)}>
      <p className="small muted">{selected.extensionPath}</p>
      <p className="small muted">{zh ? "后端的配置方式由该扩展提供。" : "Configuration is provided by this extension."}{marks ? (zh ? " 当前显示演示源码。" : " Demo source is shown.") : ""}</p>
      <textarea className="input mono" aria-label={zh ? "扩展源码" : "Extension source"} value={PREVIEW_TODO_BACKEND_SOURCE} rows={14} readOnly spellCheck={false} />
    </WorkspaceDialog> : null}
    {state ? <SettingRow label={zh ? "同步状态" : "Sync status"} source={null} {...(state.sync.updatedAt ? { desc: (zh ? "上次同步 " : "Last synced ") + new Date(state.sync.updatedAt).toLocaleTimeString(zh ? "zh-CN" : "en-US") } : {})}>
      <span role="status"><StatePill tone={tones[state.sync.state]} live={state.sync.state === "queued" || state.sync.state === "syncing"}>{labels[state.sync.state]}</StatePill></span>
      {state.selected !== "native" ? <button className="btn small outline" disabled={busy || !supports("todo.backend.sync")} onClick={() => void run()}><Icon name="refresh" extra="sm" />{zh ? "立即同步" : "Sync now"}</button> : null}
    </SettingRow> : null}
    {error ? <Callout tone="error" role="alert">{error}</Callout> : null}
  </SettingSection>;
}
