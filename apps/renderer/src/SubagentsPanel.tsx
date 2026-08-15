import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  AgentDefinitionRecord,
  AgentDefinitionsReadModel,
  AgentDefinitionSource,
  AgentDefinitionUpsertInput,
  AgentThinkingLevel,
  CommandName,
  ConfigWriteResult,
  ModelConfigReadModel,
  StudioClient,
} from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { ToastHost } from "./ToastHost";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { pagePhaseClass, useDeferredPresence } from "./pageTransition";
import { parseJsonOrYaml, StructuredEditor } from "./structured-editor";
import {
  AGENT_THINKING,
  createPreviewAgentDefinitions,
} from "./preview/subagentsPreview";

type SourceFilter = "all" | AgentDefinitionSource | "disabled";
type ToolsMode = "inherit" | "custom";
type SpawnsMode = "inherit" | "none" | "any" | "list";
type PrewalkMode = "inherit" | "off" | "on" | "custom";

interface AgentDraft {
  name: string;
  description: string;
  systemPrompt: string;
  scope: "user" | "project";
  toolsMode: ToolsMode;
  tools: string[];
  customTool: string;
  spawnsMode: SpawnsMode;
  spawns: string[];
  models: string[];
  modelInput: string;
  thinkingLevel: "" | AgentThinkingLevel;
  blocking: boolean;
  readSummarize: boolean;
  prewalkMode: PrewalkMode;
  prewalkPattern: string;
  autoloadSkills: string;
  outputText: string;
  disabled: boolean;
  overrideModel: string;
  prewalkOverride: string;
  contentHash?: string;
  existing: boolean;
  source?: AgentDefinitionSource;
  editable: boolean;
  canDelete: boolean;
  canFork: boolean;
  promptPacked?: boolean;
}

const SOURCE_CHIP: Record<AgentDefinitionSource, string> = {
  project: "blue",
  user: "purple",
  bundled: "gray",
  plugin: "amber",
};

const SOURCE_ORDER: ReadonlyArray<AgentDefinitionSource> = ["project", "user", "bundled", "plugin"];

const FILTERS: ReadonlyArray<{ id: SourceFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "project", label: "项目" },
  { id: "user", label: "用户" },
  { id: "bundled", label: "内置" },
  { id: "plugin", label: "插件" },
  { id: "disabled", label: "已禁用" },
];

function sourceLabel(source: AgentDefinitionSource): string {
  if (source === "project") return "项目";
  if (source === "user") return "用户";
  if (source === "plugin") return "插件";
  return "内置";
}

async function runWrite<T extends Extract<CommandName, `agents.definition.${string}`>>(
  client: StudioClient,
  name: T,
  input: unknown,
): Promise<ConfigWriteResult> {
  const handle = await client.command(name, input as never);
  return waitReceipt<ConfigWriteResult>(client, handle.requestId);
}

function blankDraft(projectAvailable: boolean): AgentDraft {
  return {
    name: "",
    description: "",
    systemPrompt: "",
    scope: projectAvailable ? "project" : "user",
    toolsMode: "inherit",
    tools: [],
    customTool: "",
    spawnsMode: "inherit",
    spawns: [],
    models: [],
    modelInput: "",
    thinkingLevel: "",
    blocking: false,
    readSummarize: true,
    prewalkMode: "inherit",
    prewalkPattern: "",
    autoloadSkills: "",
    outputText: "",
    disabled: false,
    overrideModel: "",
    prewalkOverride: "",
    existing: false,
    editable: true,
    canDelete: false,
    canFork: false,
  };
}

function draftFromAgent(agent: AgentDefinitionRecord, projectAvailable: boolean): AgentDraft {
  const spawnsMode: SpawnsMode = agent.spawns === "*" ? "any" : Array.isArray(agent.spawns) ? (agent.spawns.length === 0 ? "none" : "list") : "inherit";
  const prewalkMode: PrewalkMode =
    agent.prewalk === undefined ? "inherit" : agent.prewalk === false ? "off" : agent.prewalk === true ? "on" : "custom";
  return {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    scope: agent.source === "project" || (agent.source !== "user" && projectAvailable) ? (agent.source === "project" ? "project" : "user") : "user",
    toolsMode: agent.tools ? "custom" : "inherit",
    tools: (agent.tools ?? []).filter((name) => name !== "yield"),
    customTool: "",
    spawnsMode,
    spawns: Array.isArray(agent.spawns) ? [...agent.spawns] : [],
    models: agent.model ? [...agent.model] : [],
    modelInput: "",
    thinkingLevel: agent.thinkingLevel ?? "",
    blocking: agent.blocking === true,
    readSummarize: agent.readSummarize !== false,
    prewalkMode,
    prewalkPattern: typeof agent.prewalk === "string" ? agent.prewalk : "",
    autoloadSkills: (agent.autoloadSkills ?? []).join(", "),
    outputText: agent.output === undefined ? "" : JSON.stringify(agent.output, null, 2),
    disabled: agent.disabled,
    overrideModel: agent.overrideModel ?? "",
    prewalkOverride: agent.prewalkOverride ?? "",
    ...(agent.contentHash === undefined ? {} : { contentHash: agent.contentHash }),
    existing: true,
    source: agent.source,
    editable: agent.editable,
    canDelete: agent.canDelete,
    canFork: agent.canFork,
    ...(agent.promptPacked === undefined ? {} : { promptPacked: agent.promptPacked }),
  };
}

function previewMd(draft: AgentDraft): string {
  const lines = [`name: ${draft.name || "…"}`, `description: ${JSON.stringify(draft.description || "…")}`];
  if (draft.toolsMode === "custom" && draft.tools.length > 0) lines.push(`tools: ${[...draft.tools, "yield"].join(", ")}`);
  if (draft.spawnsMode === "any") lines.push("spawns: \"*\"");
  if (draft.spawnsMode === "none") lines.push("spawns: []");
  if (draft.spawnsMode === "list") lines.push(`spawns: ${draft.spawns.join(", ")}`);
  if (draft.models.length > 0) lines.push(`model: ${draft.models.join(", ")}`);
  if (draft.thinkingLevel) lines.push(`thinking-level: ${draft.thinkingLevel}`);
  if (draft.blocking) lines.push("blocking: true");
  if (!draft.readSummarize) lines.push("read-summarize: false");
  if (draft.prewalkMode === "on") lines.push("prewalk: true");
  if (draft.prewalkMode === "custom" && draft.prewalkPattern) lines.push(`prewalk: ${draft.prewalkPattern}`);
  if (draft.autoloadSkills.trim()) lines.push(`autoloadSkills: ${draft.autoloadSkills}`);
  return `---\n${lines.join("\n")}\n---\n\n${draft.systemPrompt || "…"}\n`;
}

function toolCount(agent: AgentDefinitionRecord): string {
  if (!agent.tools) return "继承全部工具";
  const n = agent.tools.filter((name) => name !== "yield").length;
  return `${n} 个工具`;
}

export function SubagentsPanel({
  client,
  preview,
  models,
  initialAgent,
  onCount,
}: {
  client: StudioClient;
  preview: boolean;
  models: ModelConfigReadModel | null;
  initialAgent?: string;
  onCount?: (count: number) => void;
}) {
  const [data, setData] = useState<AgentDefinitionsReadModel | null>(preview ? createPreviewAgentDefinitions() : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [draftState, setDraft] = useState<AgentDraft | null>(null);
  const { shown: draft, phase: viewPhase, live: viewLive } = useDeferredPresence(draftState);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const opened = useRef(false);

  const toast = (text: string) => {
    setFlash(text);
  };

  const refresh = useCallback(async () => {
    if (preview) {
      setData(createPreviewAgentDefinitions());
      setLoadError(null);
      return;
    }
    try {
      const next = await client.query("agents.definitions.get", {});
      setData(next);
      setLoadError(next.unavailableReason ?? null);
    } catch (error) {
      setLoadError(hostErrorMessage(error, "agents.definitions.get failed"));
      setData(null);
    }
  }, [client, preview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (data) onCount?.(data.agents.length);
  }, [data, onCount]);

  useEffect(() => {
    if (opened.current || !initialAgent || !data) return;
    const match = data.agents.find((agent) => agent.name === initialAgent);
    if (!match) return;
    opened.current = true;
    setDraft(draftFromAgent(match, data.projectScopeAvailable));
  }, [data, initialAgent]);

  const mutateLocal = (updater: (current: AgentDefinitionsReadModel) => AgentDefinitionsReadModel) => {
    setData((current) => updater(current ?? createPreviewAgentDefinitions()));
  };

  const agents = data?.agents ?? [];
  const toolNames = data?.builtinToolNames ?? [];
  const roleAliases = data?.roleAliases ?? [];
  const filtered = agents.filter((agent) => {
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || agent.name.toLowerCase().includes(q) || agent.description.toLowerCase().includes(q);
    if (!matchesQuery) return false;
    if (sourceFilter === "all") return true;
    if (sourceFilter === "disabled") return agent.disabled;
    return agent.source === sourceFilter;
  });
  const grouped = SOURCE_ORDER.map((source) => ({
    source,
    items: filtered.filter((agent) => agent.source === source),
  })).filter((group) => group.items.length > 0);

  const modelSuggestions = useMemo(() => {
    const fromRoles = (models?.roles ?? []).map((role) => role.alias);
    const fromAvailable = (models?.availableModels ?? []).map((model) => model.selector);
    return [...new Set([...roleAliases, ...fromRoles, ...fromAvailable])];
  }, [models, roleAliases]);

  const otherAgentNames = agents.map((agent) => agent.name);

  const openNew = () => {
    setConfirmDelete(false);
    setDraft(blankDraft(Boolean(data?.projectScopeAvailable)));
  };

  const openAgent = (agent: AgentDefinitionRecord) => {
    setConfirmDelete(false);
    setDraft(draftFromAgent(agent, Boolean(data?.projectScopeAvailable)));
  };

  const toggleEnabled = async (agent: AgentDefinitionRecord, enabled: boolean) => {
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        agents: current.agents.map((item) => (item.name === agent.name ? { ...item, disabled: !enabled } : item)),
      }));
      toast("演示：已切换启用状态，未写入 config.yml");
      return;
    }
    try {
      await runWrite(client, "agents.definition.configure", { name: agent.name, disabled: !enabled });
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "更新失败"));
    }
  };

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    const draft = draftState;
    if (!draft) return;
    if (!draft.name.trim() || !draft.description.trim()) {
      toast("名称和描述为必填");
      return;
    }
    let output: unknown;
    if (draft.outputText.trim()) {
      const parsed = parseJsonOrYaml(draft.outputText);
      if (!parsed.ok) {
        toast("output schema 无法解析（需要合法 JSON 或 YAML）");
        return;
      }
      output = parsed.value;
    }
    const prewalk =
      draft.prewalkMode === "inherit"
        ? null
        : draft.prewalkMode === "off"
          ? false
          : draft.prewalkMode === "on"
            ? true
            : draft.prewalkPattern.trim() || null;
    const upsert: AgentDefinitionUpsertInput = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt,
      scope: draft.scope,
      tools: draft.toolsMode === "inherit" ? null : draft.tools,
      spawns: draft.spawnsMode === "inherit" ? null : draft.spawnsMode === "any" ? "*" : draft.spawns,
      model: draft.models.length > 0 ? draft.models : null,
      thinkingLevel: draft.thinkingLevel || null,
      blocking: draft.blocking ? true : null,
      readSummarize: draft.readSummarize ? null : false,
      prewalk,
      autoloadSkills: draft.autoloadSkills.trim()
        ? draft.autoloadSkills.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
        : null,
      ...(output === undefined ? {} : { output }),
      ...(draft.contentHash ? { expectedHash: draft.contentHash } : {}),
    };

    if (preview) {
      if (draft.editable) {
        const record: AgentDefinitionRecord = {
          name: upsert.name,
          description: upsert.description,
          systemPrompt: upsert.systemPrompt,
          ...(upsert.tools ? { tools: [...upsert.tools, "yield"] } : {}),
          ...(upsert.spawns !== undefined && upsert.spawns !== null ? { spawns: upsert.spawns } : {}),
          ...(upsert.model ? { model: upsert.model } : {}),
          ...(upsert.thinkingLevel ? { thinkingLevel: upsert.thinkingLevel } : {}),
          ...(output === undefined ? {} : { output }),
          ...(upsert.blocking ? { blocking: true } : {}),
          ...(upsert.readSummarize === false ? { readSummarize: false } : {}),
          ...(prewalk === null || prewalk === undefined ? {} : { prewalk }),
          source: draft.scope === "project" ? "project" : "user",
          sourceLabel: draft.scope === "project" ? "项目" : "用户",
          editable: true,
          canDelete: true,
          canFork: false,
          disabled: draft.disabled,
          ...(draft.overrideModel.trim() ? { overrideModel: draft.overrideModel.trim() } : {}),
          ...(draft.prewalkOverride.trim() ? { prewalkOverride: draft.prewalkOverride.trim() } : {}),
        };
        mutateLocal((current) => ({
          ...current,
          agents: [...current.agents.filter((item) => item.name !== record.name), record],
        }));
        toast("演示：已更新本地列表，未写入磁盘");
      } else {
        mutateLocal((current) => ({
          ...current,
          agents: current.agents.map((item) => {
            if (item.name !== upsert.name) return item;
            const { overrideModel: _ignoredModel, prewalkOverride: _ignoredPrewalk, ...rest } = item;
            return {
              ...rest,
              disabled: draft.disabled,
              ...(draft.overrideModel.trim() ? { overrideModel: draft.overrideModel.trim() } : {}),
              ...(draft.prewalkOverride.trim() ? { prewalkOverride: draft.prewalkOverride.trim() } : {}),
            };
          }),
        }));
        toast("演示：已更新会话覆盖，未写入 config.yml");
      }
      setDraft(null);
      return;
    }

    setBusy(true);
    try {
      if (draft.editable) {
        await runWrite(client, "agents.definition.upsert", upsert);
      }
      const needsConfigure =
        !draft.editable
        || draft.disabled
        || Boolean(draft.overrideModel.trim())
        || Boolean(draft.prewalkOverride.trim());
      if (needsConfigure) {
        await runWrite(client, "agents.definition.configure", {
          name: upsert.name,
          disabled: draft.disabled,
          overrideModel: draft.overrideModel.trim() ? draft.overrideModel.trim() : null,
          prewalkOverride: draft.prewalkOverride.trim() ? draft.prewalkOverride.trim() : null,
        });
      }
      toast(draft.editable ? "已保存子代理" : "已更新会话覆盖");
      setDraft(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const deleteDraft = async () => {
    if (!draft?.canDelete) return;
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        agents: current.agents.filter((item) => item.name !== draft.name),
      }));
      setDraft(null);
      toast("演示：已从本地列表移除");
      return;
    }
    setBusy(true);
    try {
      await runWrite(client, "agents.definition.delete", {
        name: draft.name,
        scope: draft.scope,
        ...(draft.contentHash ? { expectedHash: draft.contentHash } : {}),
      });
      toast("已删除");
      setDraft(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "删除失败"));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const forkDraft = () => {
    if (!draft) return;
    const { contentHash: _hash, ...rest } = draft;
    setDraft({
      ...rest,
      existing: false,
      editable: true,
      canDelete: false,
      canFork: false,
      promptPacked: false,
      systemPrompt: draft.promptPacked ? "" : draft.systemPrompt,
      scope: data?.projectScopeAvailable ? "project" : "user",
      source: data?.projectScopeAvailable ? "project" : "user",
    });
    toast("已复制为可编辑草稿，保存后会覆盖同名内置代理");
  };

  const addModel = () => {
    if (!draft) return;
    const value = draft.modelInput.trim();
    if (!value || draft.models.includes(value)) return;
    setDraft({ ...draft, models: [...draft.models, value], modelInput: "" });
  };

  const addCustomTool = () => {
    if (!draft) return;
    const value = draft.customTool.trim();
    if (!value || draft.tools.includes(value)) return;
    setDraft({ ...draft, tools: [...draft.tools, value], customTool: "", toolsMode: "custom" });
  };

  const definitionLocked = Boolean(draft && !draft.editable);

  return (
    <div className={viewLive ? `mc-view ${pagePhaseClass(viewPhase)}` : "mc-view"}>
      {draft ? (
      <form className="mp-editor" onSubmit={(event) => void saveDraft(event)}>
        <div className="mr-toolbar">
          <button type="button" className="icon-btn" onClick={() => setDraft(null)}>
            <Icon name="arrow-l" />
          </button>
          <b style={{ fontSize: "var(--fs-14)" }}>{draft.existing ? `编辑 · ${draft.name}` : "新建子代理"}</b>
          {draft.source ? <span className={`chip ${SOURCE_CHIP[draft.source]} xs`}>{sourceLabel(draft.source)}</span> : <span className="chip purple xs">自定义</span>}
          {preview ? <span className="chip purple xs">演示</span> : null}
        </div>
        <ToastHost message={flash} onDismiss={() => setFlash(null)} />

        <div className="mp-sec">
          <h3>身份</h3>
          <p className="sec-desc">OMP 用 <span className="chip-code">name</span> 作为 task 工具里的代理类型。描述会出现在子代理名册里，建议以 “Use this agent when…” 开头。</p>
          <div className="f-grid">
            <div className="field">
              <label htmlFor="sa-name">名称</label>
              <input className="input mono" id="sa-name" value={draft.name} readOnly={draft.existing} disabled={definitionLocked && draft.existing} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>
            <div className="field">
              <label>保存位置</label>
              <div className="seg">
                <button type="button" className={draft.scope === "user" ? "active" : undefined} disabled={definitionLocked && draft.existing} onClick={() => setDraft({ ...draft, scope: "user" })}>用户</button>
                <button type="button" className={draft.scope === "project" ? "active" : undefined} disabled={(definitionLocked && draft.existing) || !data?.projectScopeAvailable} title={data?.projectScopeAvailable ? undefined : "未打开工作区"} onClick={() => setDraft({ ...draft, scope: "project" })}>项目</button>
              </div>
              <span className="desc">{draft.scope === "project" ? "写入当前工作区 .omp/agents/" : "写入用户 agents 目录"}</span>
            </div>
            <div className="field span2">
              <label htmlFor="sa-desc">描述</label>
              <textarea className="input sa-textarea" id="sa-desc" rows={2} value={draft.description} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </div>
          </div>
        </div>

        <div className="mp-sec">
          <h3>模型</h3>
          <p className="sec-desc">按顺序尝试。可填角色别名（如 @task）或 provider/model。留空则继承父会话模型。</p>
          <div className="sa-chip-row">
            {draft.models.map((item) => (
              <span className="chip-code sa-chip" key={item}>
                {item}
                {definitionLocked ? null : (
                  <button type="button" className="sa-chip-x" onClick={() => setDraft({ ...draft, models: draft.models.filter((value) => value !== item) })} aria-label={`移除 ${item}`}>
                    <Icon name="x" extra="sm" />
                  </button>
                )}
              </span>
            ))}
          </div>
          {definitionLocked ? null : (
            <div className="sa-add-row">
              <input className="input mono" list="sa-model-suggest" placeholder="@smol 或 provider/model" value={draft.modelInput} onChange={(event) => setDraft({ ...draft, modelInput: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel(); } }} />
              <datalist id="sa-model-suggest">
                {modelSuggestions.map((item) => <option key={item} value={item} />)}
              </datalist>
              <button type="button" className="btn small outline" onClick={addModel}>添加</button>
            </div>
          )}
          <div className="field" style={{ marginTop: 12 }}>
            <label>思考等级</label>
            <div className="seg sa-seg-wrap">
              {AGENT_THINKING.map((item) => (
                <button type="button" key={item.id || "inherit"} className={draft.thinkingLevel === item.id ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, thinkingLevel: item.id as AgentDraft["thinkingLevel"] })}>{item.label}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="mp-sec">
          <h3>系统提示</h3>
          {draft.promptPacked ? (
            <div className="preset-banner">
              <Icon name="info" extra="sm" />
              <span>内置提示词打包在运行时里。复制到用户/项目后可在此编写，或先在终端执行 omp agents unpack 再编辑。</span>
            </div>
          ) : (
            <textarea className="input sa-prompt" rows={12} value={draft.systemPrompt} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} placeholder="子代理的系统提示词（frontmatter 以下的 Markdown 正文）" />
          )}
        </div>

        <div className="mp-sec">
          <h3>工具</h3>
          <p className="sec-desc">留空表示继承父会话全部工具。显式列表会自动附带 <span className="chip-code">yield</span>。</p>
          <div className="seg">
            <button type="button" className={draft.toolsMode === "inherit" ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, toolsMode: "inherit" })}>继承全部</button>
            <button type="button" className={draft.toolsMode === "custom" ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, toolsMode: "custom" })}>指定工具</button>
          </div>
          {draft.toolsMode === "custom" ? (
            <>
              <div className="sa-tool-grid">
                {toolNames.map((name) => {
                  const on = draft.tools.includes(name);
                  return (
                    <button type="button" key={name} className={`sa-tool${on ? " on" : ""}`} disabled={definitionLocked} onClick={() => setDraft({ ...draft, tools: on ? draft.tools.filter((item) => item !== name) : [...draft.tools, name] })}>
                      {name}
                    </button>
                  );
                })}
              </div>
              {definitionLocked ? null : (
                <div className="sa-add-row">
                  <input className="input mono" placeholder="mcp__server_tool" value={draft.customTool} onChange={(event) => setDraft({ ...draft, customTool: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomTool(); } }} />
                  <button type="button" className="btn small outline" onClick={addCustomTool}>添加 MCP 工具</button>
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="mp-sec">
          <h3>可派生</h3>
          <p className="sec-desc">控制此代理能否再用 task 拉起其他子代理。含 task 工具且未写 spawns 时，OMP 会推断为任意。</p>
          <div className="seg">
            {([["inherit", "继承"], ["none", "禁止"], ["any", "任意 *"], ["list", "指定"]] as const).map(([id, label]) => (
              <button type="button" key={id} className={draft.spawnsMode === id ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, spawnsMode: id })}>{label}</button>
            ))}
          </div>
          {draft.spawnsMode === "list" ? (
            <div className="sa-tool-grid" style={{ marginTop: 12 }}>
              {otherAgentNames.filter((name) => name !== draft.name).map((name) => {
                const on = draft.spawns.includes(name);
                return (
                  <button type="button" key={name} className={`sa-tool${on ? " on" : ""}`} disabled={definitionLocked} onClick={() => setDraft({ ...draft, spawns: on ? draft.spawns.filter((item) => item !== name) : [...draft.spawns, name] })}>
                    {name}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="mp-sec">
          <h3>行为</h3>
          <div className="f-grid">
            <div className="field">
              <label>阻塞父会话</label>
              <button type="button" className={`switch${draft.blocking ? " on" : ""}`} role="switch" aria-checked={draft.blocking} disabled={definitionLocked} onClick={() => setDraft({ ...draft, blocking: !draft.blocking })} />
              <span className="desc">frontmatter blocking</span>
            </div>
            <div className="field">
              <label>Read 摘要</label>
              <button type="button" className={`switch${draft.readSummarize ? " on" : ""}`} role="switch" aria-checked={draft.readSummarize} disabled={definitionLocked} onClick={() => setDraft({ ...draft, readSummarize: !draft.readSummarize })} />
              <span className="desc">关闭后 read 返回原文</span>
            </div>
            <div className="field span2">
              <label>Prewalk</label>
              <div className="seg">
                {([["inherit", "默认"], ["off", "关"], ["on", "默认目标"], ["custom", "自定义"]] as const).map(([id, label]) => (
                  <button type="button" key={id} className={draft.prewalkMode === id ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, prewalkMode: id })}>{label}</button>
                ))}
              </div>
              {draft.prewalkMode === "custom" ? (
                <input className="input mono" style={{ marginTop: 8 }} placeholder="@smol 或 provider/model" value={draft.prewalkPattern} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, prewalkPattern: event.target.value })} />
              ) : null}
            </div>
            <div className="field span2">
              <label htmlFor="sa-skills">自动加载 Skills</label>
              <input className="input" id="sa-skills" placeholder="skill-a, skill-b" value={draft.autoloadSkills} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, autoloadSkills: event.target.value })} />
            </div>
          </div>
        </div>

        <details className="mp-advanced">
          <summary>高级 · 结构化 output 与生成预览</summary>
          <div className="adv-body">
            <StructuredEditor
              className="st-card-embed"
              language="json"
              languages={["json", "yaml"] as const}
              value={draft.outputText}
              onChange={(text) => setDraft({ ...draft, outputText: text })}
              disabled={definitionLocked}
              title="output schema"
              placeholder={'{\n  "type": "object"\n}'}
              minHeight={200}
              maxHeight={360}
            />
            <StructuredEditor
              className="st-card-embed"
              language="yaml"
              value={previewMd(draft)}
              readOnly
              lint={false}
              title="将写入的 Markdown"
              minHeight={240}
              maxHeight={360}
            />
          </div>
        </details>

        <div className="mp-sec">
          <h3>会话覆盖</h3>
          <p className="sec-desc">写入 config.yml 的 task.disabledAgents / agentModelOverrides / agentPrewalk，对内置代理同样生效。</p>
          <div className="f-grid">
            <div className="field">
              <label>启用</label>
              <button type="button" className={`switch${!draft.disabled ? " on" : ""}`} role="switch" aria-checked={!draft.disabled} onClick={() => setDraft({ ...draft, disabled: !draft.disabled })} />
            </div>
            <div className="field">
              <label htmlFor="sa-override">模型覆盖</label>
              <input className="input mono" id="sa-override" list="sa-model-suggest" placeholder="留空 = 使用定义" value={draft.overrideModel} onChange={(event) => setDraft({ ...draft, overrideModel: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="sa-prewalk-ov">Prewalk 覆盖</label>
              <input className="input mono" id="sa-prewalk-ov" placeholder="on / off / @smol" value={draft.prewalkOverride} onChange={(event) => setDraft({ ...draft, prewalkOverride: event.target.value })} />
            </div>
          </div>
        </div>

        <div className="mp-foot">
          {draft.canDelete ? (
            confirmDelete ? (
              <>
                <span className="desc">确认删除 {draft.name}？</span>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void deleteDraft()}>确认删除</button>
                <button type="button" className="btn outline" onClick={() => setConfirmDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除</button>
            )
          ) : null}
          {draft.canFork ? <button type="button" className="btn outline" onClick={forkDraft}>复制并自定义</button> : null}
          <div className="right">
            <button type="button" className="btn outline" onClick={() => setDraft(null)}>取消</button>
            <button type="submit" className="btn primary" disabled={busy}>{draft.editable ? "保存" : "保存覆盖"}</button>
          </div>
        </div>
      </form>
      ) : (
    <>
      <div className="mr-toolbar">
        <input className="input" placeholder="搜索子代理…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="seg src-filter">
          {FILTERS.map((item) => (
            <button type="button" key={item.id} className={sourceFilter === item.id ? "active" : undefined} onClick={() => setSourceFilter(item.id)}>{item.label}</button>
          ))}
        </div>
        <span className="mr-count">{filtered.length} / {agents.length}</span>
        <span className="spacer" />
        <button type="button" className="btn small outline" disabled={preview} onClick={() => void refresh()} title={preview ? "演示模式不刷新 Host" : undefined}>
          <Icon name="refresh" extra="sm" />刷新
        </button>
        <button type="button" className="btn small primary" disabled={Boolean(loadError) && !preview} onClick={openNew}>
          <Icon name="plus" extra="sm" />新建子代理
        </button>
      </div>
      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
      {preview ? <div className="role-issue-banner"><Icon name="sparkles" extra="sm" /><div><div className="rib-title">当前是演示数据</div><div className="rib-text">写入只改本地列表，不会碰到本机或项目 agents 目录。</div></div></div> : null}
      {!preview && !data && !loadError ? <div className="preset-banner" role="status"><Icon name="refresh" extra="sm" /><span>正在读取本机子代理定义…</span></div> : null}
      {!preview && loadError ? <div className="role-issue-banner"><Icon name="alert" extra="sm" /><div><div className="rib-title">读取说明</div><div className="rib-text">{loadError}</div></div></div> : null}
      {data?.warnings.length ? (
        <div className="preset-banner" role="status">
          <Icon name="alert" extra="sm" />
          <span>{data.warnings[0]}{data.warnings.length > 1 ? ` · 另有 ${data.warnings.length - 1} 条` : ""}</span>
        </div>
      ) : null}

      {grouped.length === 0 ? (
        <div className="empty">
          <Icon name="bot" />
          <div>{agents.length === 0 ? "还没有可显示的子代理定义" : "没有匹配的子代理"}</div>
        </div>
      ) : (
        grouped.map((group) => (
          <div className="sa-group" key={group.source}>
            <div className="sa-group-label">{sourceLabel(group.source)} · {group.items.length}</div>
            <div className="pv-list">
              {group.items.map((agent) => (
                <article key={agent.name} className={`pv-card sa-card${agent.disabled ? " is-disabled" : ""}`}>
                  <button type="button" className="sa-card-main" onClick={() => openAgent(agent)}>
                    <div className="sa-card-top">
                      <Icon name="bot" extra="sm" />
                      <b>{agent.name}</b>
                      <span className={`chip ${SOURCE_CHIP[agent.source]} xs`}>{agent.sourceLabel}</span>
                      {agent.disabled ? <span className="chip gray xs">已禁用</span> : null}
                      {agent.promptPacked ? <span className="chip gray xs">内置提示词</span> : null}
                    </div>
                    <div className="sa-card-desc">{agent.description}</div>
                    <div className="sa-card-meta">
                      {agent.model?.length ? <span className="chip-code">{agent.model[0]}{agent.model.length > 1 ? ` +${agent.model.length - 1}` : ""}</span> : <span className="muted">继承模型</span>}
                      {agent.thinkingLevel ? <span className="chip gray xs">{agent.thinkingLevel}</span> : null}
                      <span className="muted">{toolCount(agent)}</span>
                      {agent.blocking ? <span className="chip amber xs">blocking</span> : null}
                      {agent.prewalk === true || typeof agent.prewalk === "string" ? <span className="chip blue xs">prewalk</span> : null}
                    </div>
                  </button>
                  <div className="sa-card-act">
                    <button
                      type="button"
                      className={`switch${agent.disabled ? "" : " on"}`}
                      role="switch"
                      aria-checked={!agent.disabled}
                      aria-label={agent.disabled ? `启用 ${agent.name}` : `禁用 ${agent.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleEnabled(agent, agent.disabled);
                      }}
                    />
                    <button
                      type="button"
                      className="pv-act is-expand"
                      aria-label={`打开 ${agent.name} 详情`}
                      onClick={() => openAgent(agent)}
                    >
                      <Icon name="chevron-r" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))
      )}
    </>
      )}
    </div>
  );
}
