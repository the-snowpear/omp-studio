import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableModelRecord } from "@omp-studio/client-contract";
import type { ModelSystemTemplateBinding, ModelSystemTemplateFile, ModelSystemTemplateInspection, ModelSystemTemplateWriteResult, ModelSystemTemplatesList } from "@omp-studio/studio-protocol";
import { CapabilityEditor } from "../capabilities/CapabilityEditor";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_SYSTEM_TEMPLATES, PREVIEW_SYSTEM_TEMPLATE_CONTENT, previewSystemTemplateInspection } from "../preview/modelServicesPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { modelServiceAvailable, type ModelServiceContext } from "./useModelAuth";
import "./modelServices.css";

type BindingDraft = { pattern: string; file: string; baseline?: ModelSystemTemplateBinding };

/** config.yml's pattern→file associations; body editing uses Studio's existing CodeMirror foundation. */
export function ModelSystemTemplates({ context, visible, models = [], onDirty, onSaved }: {
  context: ModelServiceContext; visible: boolean; models?: readonly AvailableModelRecord[]; onDirty?: (dirty: boolean) => void; onSaved?: () => void;
}) {
  const { preview, marks } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [list, setList] = useState<ModelSystemTemplatesList>();
  const [draft, setDraft] = useState<BindingDraft>();
  const [file, setFile] = useState<ModelSystemTemplateFile>();
  const [text, setText] = useState("");
  const [previewSelector, setPreviewSelector] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [discard, setDiscard] = useState<(() => void) | undefined>();
  const epoch = useRef(0), lock = useRef(false);
  const listAvailable = preview || modelServiceAvailable(context, "models.systemTemplates.list");
  const canBind = preview || modelServiceAvailable(context, "models.systemTemplates.binding.set");
  const canWrite = preview || modelServiceAvailable(context, "models.systemTemplates.file.write");
  const bindingDirty = !!draft && (draft.pattern !== (draft.baseline?.pattern ?? "") || draft.file !== (draft.baseline?.file ?? ""));
  const bodyDirty = !!file && text !== file.content;
  const dirty = bindingDirty || bodyDirty;
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty, onDirty]);
  const reload = useCallback(async () => {
    if (!visible || !listAvailable) return;
    const generation = epoch.current;
    try {
      const next = preview ? PREVIEW_SYSTEM_TEMPLATES : await context.client!.query("models.systemTemplates.list", { sessionId: context.sessionId! });
      if (generation === epoch.current) { setList(next); setError(""); }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "无法读取系统模板配置" : "System template configuration unavailable")); }
  }, [visible, listAvailable, preview, context.client, context.sessionId, zh]);
  useEffect(() => {
    epoch.current++; setList(undefined); setDraft(undefined); setFile(undefined); setText(""); setError(""); setBusy(false); lock.current = false;
    return () => { epoch.current++; };
  }, [context.client, context.sessionId, preview]);
  useEffect(() => {
    // A hidden surface fences the read/write receipt, but must not strand its editor lock on return.
    if (!visible) { lock.current = false; setBusy(false); }
    else void reload();
    return () => { epoch.current++; };
  }, [visible, reload]);
  useEffect(() => {
    if (!previewSelector && models.length) setPreviewSelector(models.find(model => model.kind === "chat" || !model.kind)?.selector ?? "");
  }, [models, previewSelector]);
  const replaceEditor = (run: () => void) => { if (dirty) setDiscard(() => run); else run(); };
  const edit = (binding?: ModelSystemTemplateBinding) => replaceEditor(() => {
    setDraft(binding ? { pattern: binding.pattern, file: binding.file, baseline: binding } : { pattern: "", file: "" });
    setFile(undefined); setText(""); setError("");
  });
  const openFile = async () => {
    if (!draft?.baseline || bindingDirty || lock.current) return;
    const generation = epoch.current; lock.current = true; setBusy(true); setError("");
    try {
      const next = preview ? { pattern: draft.pattern, file: draft.file, content: PREVIEW_SYSTEM_TEMPLATE_CONTENT, version: "preview-file-v1", exists: true, editable: true }
        : await context.client!.query("models.systemTemplates.file.read", { sessionId: context.sessionId!, pattern: draft.pattern });
      if (generation === epoch.current) { setFile(next); setText(next.content); }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "无法打开模板文件" : "Template file could not be opened")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  const saveBinding = async (remove = false) => {
    if (!draft || !list || !canBind || lock.current) return;
    const generation = epoch.current; lock.current = true; setBusy(true); setError("");
    try {
      let next: ModelSystemTemplatesList;
      if (preview) {
        const bindings = list.bindings.filter(row => row.pattern !== (draft.baseline?.pattern ?? draft.pattern));
        if (!remove) bindings.push({ pattern: draft.pattern, file: draft.file, source: "global", editable: true, effective: true });
        next = { ...list, version: `${list.version}-edit`, bindings };
      } else {
        const handle = await context.client!.command("models.systemTemplates.binding.set", { sessionId: context.sessionId!, version: list.version, pattern: draft.pattern,
          ...(draft.baseline ? { previousPattern: draft.baseline.pattern } : {}), file: remove ? null : draft.file });
        next = await waitReceipt<ModelSystemTemplatesList>(context.client!, handle.requestId);
      }
      if (generation === epoch.current) {
        setList(next); setFile(undefined); setText("");
        const binding = next.bindings.find(row => row.pattern === draft.pattern && row.source === "global") ?? next.bindings.find(row => row.pattern === draft.pattern && row.effective);
        setDraft(remove || !binding ? undefined : { pattern: binding.pattern, file: binding.file, baseline: binding });
        onSaved?.();
      }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "系统模板关联保存失败" : "System template association could not be saved")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  const saveFile = async () => {
    if (!file || !bodyDirty || !canWrite || lock.current) return;
    const generation = epoch.current; lock.current = true; setBusy(true); setError("");
    try {
      let next: ModelSystemTemplateFile;
      if (preview) next = { ...file, content: text, exists: true, version: file.version + "-edit" };
      else {
        const handle = await context.client!.command("models.systemTemplates.file.write", { sessionId: context.sessionId!, pattern: file.pattern, version: file.version, content: text });
        await waitReceipt<ModelSystemTemplateWriteResult>(context.client!, handle.requestId);
        next = await context.client!.query("models.systemTemplates.file.read", { sessionId: context.sessionId!, pattern: file.pattern });
      }
      if (generation === epoch.current) { setFile(next); setText(next.content); onSaved?.(); }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "文件保存失败；草稿已保留，请重新读取版本后处理冲突" : "File save failed; your draft is retained. Reopen the current version to resolve the conflict")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  if (!visible) return null;
  return <section className="model-system-templates mp-sec">
    <header className="model-native-toolbar"><div><h3>{zh ? "模型系统模板" : "Model system templates"}{preview && marks ? zh ? " · 演示" : " · Demo" : ""}</h3><p className="sec-desc">config.yml · systemPromptTemplates</p></div><button className="btn small outline" disabled={!listAvailable || busy || dirty} onClick={() => void reload()}><Icon name="refresh" extra="sm" />{zh ? "重读" : "Reload"}</button><button className="btn small outline" disabled={!canBind || busy} onClick={() => edit()}><Icon name="plus" extra="sm" />{zh ? "添加关联" : "Add association"}</button></header>
    <details className="model-template-rules"><summary><Icon name="info" extra="sm" />{zh ? "匹配与优先级规则" : "Matching and precedence"}</summary><p>{zh ? "原生最长 substring 匹配（忽略大小写）。文件须为绝对路径或 ~/ 路径；SYSTEM.md / SYSTEM_TEMPLATE.md 和显式提示优先。缺失、空或无效模板回退到内置提示。这里不是 slash 模板，也不是 models.yml 的模型覆盖。" : "Native longest-substring matching is case-insensitive. Files use absolute or ~/ paths. SYSTEM.md / SYSTEM_TEMPLATE.md and explicit prompts take precedence; missing, empty or invalid templates fall back to the bundled prompt. This is not a slash template or models.yml override."}</p></details>
    {!listAvailable ? <p className="small muted">{zh ? "当前 Runtime 未提供系统模板读模型。连接新版 Runtime 后可配置。" : "This Runtime has no system-template read model. Connect an updated Runtime to configure it."}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className={`model-template-layout${draft ? " is-editing" : ""}`}>
      <div className="model-template-list" role="list" aria-label={zh ? "系统模板关联" : "System template associations"}>
        {list?.bindings.map(binding => <button type="button" role="listitem" key={`${binding.source}:${binding.pattern}`} className={`model-template-binding${draft?.baseline === binding ? " active" : ""}`} onClick={() => edit(binding)}>
          <b className="mono">{binding.pattern}</b><Icon name="arrow-r" extra="sm" /><span className="mono">{binding.file}</span><small className={`chip xs ${binding.effective ? "gray" : "amber"}`}>{binding.source}{binding.effective ? "" : zh ? " · 被覆盖" : " · Overridden"}</small>
        </button>)}
        {list && !list.bindings.length ? <p className="small muted">{zh ? "尚无关联；使用原生默认系统提示。" : "No associations; native default system prompts apply."}</p> : null}
      </div>
      {draft ? <div className="model-template-edit">
        <label>{zh ? "模型 substring" : "Model substring"}<input className="input mono" value={draft.pattern} readOnly={draft.baseline?.editable === false} disabled={busy} onChange={event => setDraft({ ...draft, pattern: event.target.value })} /></label>
        <label>{zh ? "模板文件" : "Template file"}<input className="input mono" value={draft.file} readOnly={draft.baseline?.editable === false} disabled={busy} placeholder="~/prompts/system.md" onChange={event => setDraft({ ...draft, file: event.target.value })} /></label>
        {draft.baseline?.editable === false ? <p className="small muted">{zh ? "关联由项目 / --config / 会话覆盖拥有；在对应 config.yml 修改。已配置的文件仍可在这里原位编辑。" : "The project / --config / session layer owns this association. Edit its config.yml; the configured file can still be edited here."}</p> : null}
        <div className="model-native-toolbar"><button className="btn small primary" disabled={!canBind || busy || !bindingDirty || !draft.pattern.trim() || !draft.file.trim() || draft.baseline?.editable === false || bodyDirty} onClick={() => void saveBinding()}>{zh ? "保存关联" : "Save association"}</button><button className="btn small outline" disabled={!draft.baseline?.effective || bindingDirty || busy} onClick={() => replaceEditor(() => { void openFile(); })}>{zh ? "编辑文件内容" : "Edit file content"}</button><button className="btn small outline" disabled={busy} onClick={() => replaceEditor(() => { setDraft(undefined); setFile(undefined); setText(""); })}>{zh ? "关闭编辑" : "Close editor"}</button>{draft.baseline?.editable ? <button className="btn small outline danger" disabled={busy || bodyDirty} onClick={() => void saveBinding(true)}>{zh ? "移除关联" : "Remove association"}</button> : null}</div>
        {file ? <><p className="small muted mono">{file.file}{file.exists ? "" : zh ? " · 尚不存在，保存将创建" : " · Not found; saving creates it"}</p><CapabilityEditor label={zh ? "系统模板文件内容" : "System template file content"} language="markdown" value={text} onChange={setText} readOnly={busy || !file.editable || !canWrite} onSubmit={() => void saveFile()} /><div className="model-native-toolbar"><button className="btn small primary" disabled={!bodyDirty || busy || !canWrite} onClick={() => void saveFile()}>{zh ? "保存文件并原生重渲染" : "Save file and rebuild natively"}</button><button className="btn small outline" disabled={!bodyDirty || busy} onClick={() => setText(file.content)}>{zh ? "撤销草稿" : "Discard draft"}</button></div></> : null}
      </div> : null}
    </div>
    <div className="model-template-preview-choice"><label>{zh ? "检查模型" : "Inspect model"}<AppSelect className="select" value={previewSelector} disabled={!models.length} onChange={event => setPreviewSelector(event.target.value)}><option value="">{zh ? "选择实际模型…" : "Choose an available model…"}</option>{models.filter(model => model.kind === "chat" || !model.kind).map(model => <option key={model.selector} value={model.selector}>{model.name} · {model.provider}</option>)}</AppSelect></label></div>
    {previewSelector ? <ModelSystemTemplateInspector key={list?.version + (file?.version ?? "")} context={context} selector={previewSelector} visible={visible} /> : null}
    {discard ? <div className="session-options-confirm" role="dialog" aria-label={zh ? "放弃模板草稿" : "Discard template draft"}><p>{zh ? "模板关联或文件有未保存改动。放弃后继续？" : "The association or file has unsaved changes. Discard them to continue?"}</p><button className="btn danger" onClick={() => { const run = discard; setDiscard(undefined); run(); }}>{zh ? "放弃改动" : "Discard changes"}</button><button className="btn outline" onClick={() => setDiscard(undefined)}>{zh ? "保留草稿" : "Keep draft"}</button></div> : null}
  </section>;
}

export function ModelSystemTemplateInspector({ context, selector, visible }: { context: ModelServiceContext; selector: string; visible: boolean }) {
  const { preview, marks } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [inspection, setInspection] = useState<ModelSystemTemplateInspection>();
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const available = preview || modelServiceAvailable(context, "models.systemTemplates.inspect");
  useEffect(() => {
    let active = true; setInspection(undefined); setError("");
    if (!visible || !selector || !available) return;
    void (preview ? Promise.resolve(previewSystemTemplateInspection(selector)) : context.client!.query("models.systemTemplates.inspect", { sessionId: context.sessionId!, selector })).then(result => { if (active) setInspection(result); }).catch(cause => { if (active) setError(hostErrorMessage(cause, zh ? "系统提示检查不可用" : "System prompt inspection unavailable")); });
    return () => { active = false; };
  }, [context.client, context.sessionId, visible, selector, available, preview, refresh, zh]);
  if (!visible) return null;
  const selection = inspection?.live?.selection ?? inspection?.selection;
  const sourceName = selection ? ({ bundled: zh ? "原生内置提示" : "Native bundled prompt", "explicit-template": zh ? "显式系统模板" : "Explicit template", "explicit-text": zh ? "显式系统提示" : "Explicit prompt", "discovered-template": "SYSTEM_TEMPLATE.md", "discovered-text": "SYSTEM.md", "model-template": "config.yml · systemPromptTemplates" }[selection.source]) : "";
  return <section className="model-template-inspection" aria-label={zh ? "实际系统提示来源" : "System prompt source"}>
    <header className="model-native-toolbar"><h4>{zh ? "系统提示来源与原生预览" : "System prompt source and native preview"}{preview && marks ? zh ? " · 演示" : " · Demo" : ""}</h4><button className="btn small outline" disabled={!available} onClick={() => setRefresh(value => value + 1)}>{zh ? "检查" : "Inspect"}</button></header>
    {!available ? <p className="small muted">{zh ? "此 Runtime 未提供原生系统提示预览。" : "Native system prompt inspection is unavailable on this Runtime."}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {selection ? <dl><div><dt>{inspection?.live ? zh ? "实际已应用来源" : "Applied source" : zh ? "原生选择来源" : "Native selection"}</dt><dd>{sourceName}</dd></div>{selection.matchedTemplate ? <div><dt>{zh ? "最长匹配" : "Longest match"}</dt><dd><code>{selection.matchedTemplate.pattern}</code> · {selection.matchedTemplate.path}{selection.source !== "model-template" ? zh ? " · 未生效" : " · Not selected" : ""}</dd></div> : <div><dt>{zh ? "模型配置匹配" : "Model binding"}</dt><dd>{zh ? "没有匹配的关联" : "No matching association"}</dd></div>}{selection.path ? <div><dt>{zh ? "来源文件" : "Source file"}</dt><dd>{selection.path}</dd></div> : null}{selection.fallback ? <div><dt>{zh ? "回退原因" : "Fallback reason"}</dt><dd>{({ missing: zh ? "文件缺失" : "Missing file", empty: zh ? "模板为空" : "Empty template", invalid: zh ? "模板无效" : "Invalid template" })[selection.fallback]}</dd></div> : null}</dl> : null}
    {inspection ? <><p className="small muted">{zh ? "预览由原生 builder 按当前会话 / 工具上下文渲染，不切换模型、不发送请求、不在客户端执行 Handlebars。" : "The native builder renders against this session and tool context. It does not switch models, send requests or run client-side Handlebars."}</p>{inspection.live && !inspection.live.matchesPreview ? <p className="small muted">{zh ? "当前已应用提示与本次重渲染不同；保留原生缓存 / 当前轮次的提示绑定。" : "The applied prompt differs from this preview; native cache/current-turn prompt binding is retained."}</p> : null}<details><summary>{inspection.live ? zh ? "查看实际当前内容" : "View applied content" : zh ? "查看原生渲染内容" : "View native rendered content"}</summary><pre>{inspection.live?.content ?? inspection.preview}</pre></details>{inspection.live && !inspection.live.matchesPreview ? <details><summary>{zh ? "查看重新渲染预览" : "View rebuilt preview"}</summary><pre>{inspection.preview}</pre></details> : null}{inspection.truncated ? <p className="small muted">{zh ? "内容超过读取预算，已截断。" : "Content exceeds the read budget and is truncated."}</p> : null}</> : null}
  </section>;
}
