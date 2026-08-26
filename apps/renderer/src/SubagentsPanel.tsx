import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  ModelRoleRecord,
  StudioClient,
} from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { ToastHost } from "./ToastHost";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { pagePhaseClass, useDeferredPresence } from "./pageTransition";
import { parseJsonOrYaml, StructuredEditor } from "./structured-editor";
import { ComposerModelMenu } from "./ComposerModelPicker";
import { createPreviewModelConfig } from "./preview/modelConfigFixtures";
import {
  AGENT_THINKING,
  createPreviewAgentDefinitions,
} from "./preview/subagentsPreview";

type SourceFilter = "all" | AgentDefinitionSource | "disabled";
type ToolsMode = "inherit" | "custom";
type SpawnsMode = "inherit" | "none" | "any" | "list";
type PrewalkMode = "inherit" | "off" | "on" | "custom";
type AdvisorMode = PrewalkMode;

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
  advisorMode: AdvisorMode;
  advisorPattern: string;
  autoloadSkills: string;
  outputText: string;
  disabled: boolean;
  overrideModel: string;
  prewalkOverride: string;
  advisorOverride: string;
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

/** Matches Host `omp-agent-definitions-adapter` AGENT_NAME. */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_NAME_HINT = "subagents.agentNameHintLong";

const FILTER_KEYS: ReadonlyArray<{ id: SourceFilter; key: string }> = [
  { id: "all", key: "history.all" },
  { id: "project", key: "subagents.scopeProject" },
  { id: "user", key: "subagents.scopeUser" },
  { id: "bundled", key: "skills.scopeBuiltin" },
  { id: "plugin", key: "skills.scopePlugin" },
  { id: "disabled", key: "modelConfig.disabled" },
];

function sourceLabel(source: AgentDefinitionSource, t?: (k: string) => string): string {
  if (t) {
    if (source === "project") return t("subagents.scopeProject");
    if (source === "user") return t("subagents.scopeUser");
    if (source === "plugin") return t("skills.scopePlugin");
    return t("skills.scopeBuiltin");
  }
  return source;
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
    advisorMode: "inherit",
    advisorPattern: "",
    autoloadSkills: "",
    outputText: "",
    disabled: false,
    overrideModel: "",
    prewalkOverride: "",
    advisorOverride: "",
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
  const advisorMode: AdvisorMode =
    agent.advisor === undefined ? "inherit" : agent.advisor === false ? "off" : agent.advisor === true ? "on" : "custom";
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
    advisorMode,
    advisorPattern: typeof agent.advisor === "string" ? agent.advisor : "",
    autoloadSkills: (agent.autoloadSkills ?? []).join(", "),
    outputText: agent.output === undefined ? "" : JSON.stringify(agent.output, null, 2),
    disabled: agent.disabled,
    overrideModel: agent.overrideModel ?? "",
    prewalkOverride: agent.prewalkOverride ?? "",
    advisorOverride: agent.advisorOverride ?? "",
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
  if (draft.advisorMode === "on") lines.push("advisor: true");
  if (draft.advisorMode === "custom" && draft.advisorPattern) lines.push(`advisor: ${draft.advisorPattern}`);
  if (draft.autoloadSkills.trim()) lines.push(`autoloadSkills: ${draft.autoloadSkills}`);
  return `---\n${lines.join("\n")}\n---\n\n${draft.systemPrompt || "…"}\n`;
}

function modelChipLabel(value: string, catalog: ModelConfigReadModel | null): string {
  if (value.startsWith("@")) {
    const role = catalog?.roles.find((item) => item.alias === value);
    return role ? `${role.name} ${value}` : value;
  }
  const model = catalog?.availableModels.find((item) => item.selector === value);
  if (model) return model.name;
  const tail = value.split("/").pop() ?? value;
  return tail.split(":")[0] || value;
}

function toolCount(agent: AgentDefinitionRecord, t: (k: string, p?: any) => string): string {
  if (!agent.tools) return t("subagents.inheritAllTools");
  const n = agent.tools.filter((name) => name !== "yield").length;
  return `${n} ${t("capabilities.toolsProvided")}`;
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
  const { t } = useI18n();
  const [data, setData] = useState<AgentDefinitionsReadModel | null>(preview ? createPreviewAgentDefinitions() : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [draftState, setDraft] = useState<AgentDraft | null>(null);
  const { shown: draft, phase: viewPhase, live: viewLive } = useDeferredPresence(draftState);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    name: string;
    scope: "user" | "project";
    contentHash?: string;
  } | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const opened = useRef(false);
  const draftRef = useRef<AgentDraft | null>(null);
  draftRef.current = draftState;

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

  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busy) setPendingDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingDelete, busy]);

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
    setPendingDelete(null);
    setModelMenuOpen(false);
    setSaveHint(null);
    setDraft(blankDraft(Boolean(data?.projectScopeAvailable)));
  };

  const openAgent = (agent: AgentDefinitionRecord) => {
    setPendingDelete(null);
    setModelMenuOpen(false);
    setSaveHint(null);
    setDraft(draftFromAgent(agent, Boolean(data?.projectScopeAvailable)));
  };

  const toggleEnabled = async (agent: AgentDefinitionRecord, enabled: boolean) => {
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        agents: current.agents.map((item) => (item.name === agent.name ? { ...item, disabled: !enabled } : item)),
      }));
      toast(t("subagents.demoToggledEnabled"));
      return;
    }
    try {
      await runWrite(client, "agents.definition.configure", { name: agent.name, disabled: !enabled });
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.updateFailed")));
    }
  };

  const saveDraft = async (event?: FormEvent) => {
    event?.preventDefault();
    const draft = draftRef.current;
    if (!draft) return;
    const name = draft.name.trim();
    const description = draft.description.trim();
    if (!name || !description) {
      const message = t("subagents.nameDescRequired");
      setSaveHint(message);
      toast(message);
      return;
    }
    if (!AGENT_NAME_RE.test(name)) {
      setSaveHint(AGENT_NAME_HINT);
      toast(AGENT_NAME_HINT);
      return;
    }
    setSaveHint(null);
    let output: unknown;
    if (draft.outputText.trim()) {
      const parsed = parseJsonOrYaml(draft.outputText);
      if (!parsed.ok) {
        toast(t("subagents.schemaInvalid"));
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
    const advisor =
      draft.advisorMode === "inherit"
        ? null
        : draft.advisorMode === "off"
          ? false
          : draft.advisorMode === "on"
            ? true
            : draft.advisorPattern.trim() || null;
    const upsert: AgentDefinitionUpsertInput = {
      name,
      description,
      systemPrompt: draft.systemPrompt,
      scope: draft.scope,
      tools: draft.toolsMode === "inherit" ? null : draft.tools,
      spawns: draft.spawnsMode === "inherit" ? null : draft.spawnsMode === "any" ? "*" : draft.spawns,
      model: draft.models.length > 0 ? draft.models : null,
      thinkingLevel: draft.thinkingLevel || null,
      blocking: draft.blocking ? true : null,
      readSummarize: draft.readSummarize ? null : false,
      prewalk,
      advisor,
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
          ...(advisor === null || advisor === undefined ? {} : { advisor }),
          source: draft.scope === "project" ? "project" : "user",
          sourceLabel: draft.scope === "project" ? t("subagents.scopeProject") : t("subagents.scopeUser"),
          editable: true,
          canDelete: true,
          canFork: false,
          disabled: draft.disabled,
          ...(draft.overrideModel.trim() ? { overrideModel: draft.overrideModel.trim() } : {}),
          ...(draft.prewalkOverride.trim() ? { prewalkOverride: draft.prewalkOverride.trim() } : {}),
          ...(draft.advisorOverride.trim() ? { advisorOverride: draft.advisorOverride.trim() } : {}),
        };
        mutateLocal((current) => ({
          ...current,
          agents: [...current.agents.filter((item) => item.name !== record.name), record],
        }));
        toast(t("subagents.demoListUpdated"));
      } else {
        mutateLocal((current) => ({
          ...current,
          agents: current.agents.map((item) => {
            if (item.name !== upsert.name) return item;
            const { overrideModel: _ignoredModel, prewalkOverride: _ignoredPrewalk, advisorOverride: _ignoredAdvisor, ...rest } = item;
            return {
              ...rest,
              disabled: draft.disabled,
              ...(draft.overrideModel.trim() ? { overrideModel: draft.overrideModel.trim() } : {}),
              ...(draft.prewalkOverride.trim() ? { prewalkOverride: draft.prewalkOverride.trim() } : {}),
          ...(draft.advisorOverride.trim() ? { advisorOverride: draft.advisorOverride.trim() } : {}),
            };
          }),
        }));
        toast(t("subagents.demoOverrideUpdated"));
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
        || Boolean(draft.prewalkOverride.trim())
        || Boolean(draft.advisorOverride.trim());
      if (needsConfigure) {
        await runWrite(client, "agents.definition.configure", {
          name: upsert.name,
          disabled: draft.disabled,
          overrideModel: draft.overrideModel.trim() ? draft.overrideModel.trim() : null,
          prewalkOverride: draft.prewalkOverride.trim() ? draft.prewalkOverride.trim() : null,
          advisorOverride: draft.advisorOverride.trim() ? draft.advisorOverride.trim() : null,
        });
      }
      toast(draft.editable ? t("subagents.savedAgent") : t("subagents.savedOverride"));
      setDraft(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgentDef = async (input: {
    name: string;
    scope: "user" | "project";
    contentHash?: string;
  }) => {
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        agents: current.agents.filter((item) => item.name !== input.name),
      }));
      if (draftState?.name === input.name) setDraft(null);
      toast(t("subagents.demoRemovedFromList"));
      setPendingDelete(null);
      return;
    }
    setBusy(true);
    try {
      await runWrite(client, "agents.definition.delete", {
        name: input.name,
        scope: input.scope,
        ...(input.contentHash ? { expectedHash: input.contentHash } : {}),
      });
      toast(t("modelConfig.saved"));
      if (draftState?.name === input.name) setDraft(null);
      setPendingDelete(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.deleteFailed")));
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = (input: { name: string; scope: "user" | "project"; contentHash?: string }) => {
    setPendingDelete(input);
  };

  const cancelPendingDelete = () => {
    if (!busy) setPendingDelete(null);
  };

  const confirmPendingDelete = async () => {
    if (!pendingDelete) return;
    await deleteAgentDef(pendingDelete);
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
    toast(t("subagents.forkDraftToast"));
  };

  const catalog = models ?? (preview ? createPreviewModelConfig() : null);

  const addModelValue = (value: string) => {
    if (!draftState || !value || draftState.models.includes(value)) {
      setModelMenuOpen(false);
      return;
    }
    setDraft({ ...draftState, models: [...draftState.models, value] });
    setModelMenuOpen(false);
  };

  const chooseRoleModel = (role: ModelRoleRecord) => {
    addModelValue(role.alias);
  };

  const moveModel = (index: number, delta: -1 | 1) => {
    if (!draftState) return;
    const target = index + delta;
    if (target < 0 || target >= draftState.models.length) return;
    const next = [...draftState.models];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft({ ...draftState, models: next });
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
      <form className="mp-editor" noValidate onSubmit={(event) => void saveDraft(event)}>
        <div className="mr-toolbar">
          <button type="button" className="icon-btn" onClick={() => { setModelMenuOpen(false); setDraft(null); }}>
            <Icon name="arrow-l" />
          </button>
          <b style={{ fontSize: "var(--fs-14)" }}>{draft.existing ? t("subagents.editSubagent", { name: draft.name }) : t("subagents.newSubagent")}</b>
          {draft.source ? <span className={`chip ${SOURCE_CHIP[draft.source]} xs`}>{sourceLabel(draft.source, t)}</span> : <span className="chip purple xs">{t("common.custom") || "Custom"}</span>}
          {preview ? <span className="chip purple xs">{t("common.demo")}</span> : null}
        </div>
        <ToastHost message={flash} onDismiss={() => setFlash(null)} />

        <div className="mp-sec">
          <h3>{t("subagents.title")}</h3>
          <p className="sec-desc">{t("subagents.identityDesc")}</p>
          <div className="f-grid">
            <div className="field">
              <label htmlFor="sa-name">{t("common.name") || "Name"}</label>
              <input className="input mono" id="sa-name" value={draft.name} readOnly={draft.existing} disabled={definitionLocked && draft.existing} {...(saveHint ? { "aria-invalid": true as const } : {})} onChange={(event) => { setSaveHint(null); setDraft({ ...draft, name: event.target.value }); }} />
              {saveHint ? <span className="desc sa-field-error" role="alert">{saveHint.startsWith("subagents.") ? t(saveHint) : saveHint}</span> : <span className="desc">{t("subagents.nameHint")}</span>}
            </div>
            <div className="field">
              <label>{t("subagents.savePosition")}</label>
              <div className="seg">
                <button type="button" className={draft.scope === "user" ? "active" : undefined} disabled={definitionLocked && draft.existing} onClick={() => setDraft({ ...draft, scope: "user" })}>{t("subagents.scopeUser")}</button>
                <button type="button" className={draft.scope === "project" ? "active" : undefined} disabled={(definitionLocked && draft.existing) || !data?.projectScopeAvailable} data-tip={data?.projectScopeAvailable ? undefined : t("subagents.noWorkspaceTip")} onClick={() => setDraft({ ...draft, scope: "project" })}>{t("subagents.scopeProject")}</button>
              </div>
              <span className="desc">{draft.scope === "project" ? t("subagents.scopeProjectDesc") : t("subagents.scopeUserDesc")}</span>
            </div>
            <div className="field span2">
              <label htmlFor="sa-desc">{t("common.description") || "Description"}</label>
              <textarea className="input sa-textarea" id="sa-desc" rows={2} value={draft.description} disabled={definitionLocked} onChange={(event) => { setSaveHint(null); setDraft({ ...draft, description: event.target.value }); }} />
            </div>
          </div>
        </div>

        <div className="mp-sec">
          <h3>{t("subagents.modelSectionTitle")}</h3>
          <p className="sec-desc">{t("subagents.modelSectionDesc")}</p>
          <div className="sa-model-pick">
            <div className="sa-model-pills">
              {draft.models.length === 0 ? (
                <span className="sa-model-inherit">{t("subagents.inheritModel")}</span>
              ) : (
                draft.models.map((item, index) => (
                  <span className="sa-model-pill" key={item} data-tip={item}>
                    <Icon name="cpu" extra="sm" />
                    <span>{modelChipLabel(item, catalog)}</span>
                    {definitionLocked ? null : (
                      <>
                        <button
                          type="button"
                          className="sa-chip-x sa-chip-move"
                          disabled={index === 0}
                          onClick={() => moveModel(index, -1)}
                          aria-label={t("subagents.moveModelUp", { name: item })}
                        >
                          <Icon name="arrow-u" extra="sm" />
                        </button>
                        <button
                          type="button"
                          className="sa-chip-x sa-chip-move"
                          disabled={index === draft.models.length - 1}
                          onClick={() => moveModel(index, 1)}
                          aria-label={t("subagents.moveModelDown", { name: item })}
                        >
                          <Icon name="arrow-d" extra="sm" />
                        </button>
                        <button
                          type="button"
                          className="sa-chip-x"
                          onClick={() => setDraft({ ...draft, models: draft.models.filter((value) => value !== item) })}
                          aria-label={`${t("common.remove")} ${item}`}
                        >
                          <Icon name="x" extra="sm" />
                        </button>
                      </>
                    )}
                  </span>
                ))
              )}
              {definitionLocked ? null : (
                <span className="cmp-pill-wrap sa-model-add">
                  <button
                    type="button"
                    className="pill-btn"
                    aria-haspopup="menu"
                    aria-expanded={modelMenuOpen}
                    aria-label={t("subagents.addModel")}
                    onClick={() => setModelMenuOpen((open) => !open)}
                  >
                    <Icon name="plus" extra="sm" />
                    <span>{t("subagents.addModel")}</span>
                  </button>
                  {modelMenuOpen ? (
                    <ComposerModelMenu
                      data={catalog}
                      loading={!catalog}
                      loadError={null}
                      preview={preview}
                      placement="down"
                      isRoleSelected={(role) => draft.models.includes(role.alias) || draft.models.includes(role.primary)}
                      isModelSelected={(selector) => draft.models.includes(selector)}
                      note={preview ? t("subagents.demoNoticeDesc") : t("subagents.addModelNote")}
                      onChooseRole={chooseRoleModel}
                      onChooseModel={addModelValue}
                      onClose={() => setModelMenuOpen(false)}
                    />
                  ) : null}
                </span>
              )}
            </div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>{t("subagents.thinkingLevel")}</label>
            <div className="seg sa-seg-wrap">
              {AGENT_THINKING.map((item) => (
                <button type="button" key={item.id || "inherit"} className={draft.thinkingLevel === item.id ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, thinkingLevel: item.id as AgentDraft["thinkingLevel"] })}>{item.label}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="mp-sec">
          <h3>{t("subagents.promptSectionTitle")}</h3>
          {draft.promptPacked ? (
            <div className="preset-banner">
              <Icon name="info" extra="sm" />
              <span>{t("subagents.promptSectionDesc")}</span>
            </div>
          ) : (
            <textarea className="input sa-prompt" rows={12} value={draft.systemPrompt} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} placeholder={t("subagents.promptPlaceholder")} />
          )}
        </div>

        <div className="mp-sec">
          <h3>{t("subagents.toolsSectionTitle")}</h3>
          <p className="sec-desc">{t("subagents.toolsSectionDesc")}</p>
          <div className="seg">
            <button type="button" className={draft.toolsMode === "inherit" ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, toolsMode: "inherit" })}>{t("subagents.inheritAllTools")}</button>
            <button type="button" className={draft.toolsMode === "custom" ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, toolsMode: "custom" })}>{t("subagents.customTools")}</button>
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
                  <button type="button" className="btn small outline" onClick={addCustomTool}>{t("subagents.addMcpTool")}</button>
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="mp-sec">
          <h3>{t("subagents.spawnsSectionTitle")}</h3>
          <p className="sec-desc">{t("subagents.spawnsSectionDesc")}</p>
          <div className="seg">
            {([["inherit", t("subagents.spawnInherit")], ["none", t("subagents.spawnNone")], ["any", t("subagents.spawnAny")], ["list", t("subagents.spawnList")]] as const).map(([id, label]) => (
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
          <h3>{t("subagents.behaviorSectionTitle")}</h3>
          <div className="f-grid">
            <div className="field span2">
              <label htmlFor="sa-enabled">{t("subagents.enableAgent")}</label>
              <button type="button" id="sa-enabled" className={`switch${!draft.disabled ? " on" : ""}`} role="switch" aria-checked={!draft.disabled} aria-label={t("subagents.enableAgent")} onClick={() => setDraft({ ...draft, disabled: !draft.disabled })} />
              <span className="desc">{t("subagents.enableAgentDesc")}</span>
            </div>
            <div className="field">
              <label>{t("subagents.blockParent")}</label>
              <button type="button" className={`switch${draft.blocking ? " on" : ""}`} role="switch" aria-checked={draft.blocking} disabled={definitionLocked} onClick={() => setDraft({ ...draft, blocking: !draft.blocking })} />
              <span className="desc">frontmatter blocking</span>
            </div>
            <div className="field">
              <label>{t("subagents.readSummary")}</label>
              <button type="button" className={`switch${draft.readSummarize ? " on" : ""}`} role="switch" aria-checked={draft.readSummarize} disabled={definitionLocked} onClick={() => setDraft({ ...draft, readSummarize: !draft.readSummarize })} />
              <span className="desc">{t("subagents.readSummaryDesc")}</span>
            </div>
            <div className="field span2">
              <label>Prewalk</label>
              <div className="seg">
                {([["inherit", t("common.default") || "Default"], ["off", t("common.off") || "Off"], ["on", t("common.on") || "On"], ["custom", t("common.custom") || "Custom"]] as const).map(([id, label]) => (
                  <button type="button" key={id} className={draft.prewalkMode === id ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, prewalkMode: id })}>{label}</button>
                ))}
              </div>
              {draft.prewalkMode === "custom" ? (
                <input className="input mono" style={{ marginTop: 8 }} placeholder={t("composer.modelOrRolePlaceholder") || "@smol / provider/model"} value={draft.prewalkPattern} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, prewalkPattern: event.target.value })} />
              ) : null}
            </div>
            <div className="field span2">
              <label>Advisor</label>
              <div className="seg">
                {([["inherit", t("common.default") || "Default"], ["off", t("common.off") || "Off"], ["on", t("common.on") || "On"], ["custom", t("common.custom") || "Custom"]] as const).map(([id, label]) => (
                  <button type="button" key={id} className={draft.advisorMode === id ? "active" : undefined} disabled={definitionLocked} onClick={() => setDraft({ ...draft, advisorMode: id })}>{label}</button>
                ))}
              </div>
              {draft.advisorMode === "custom" ? (
                <input className="input mono" style={{ marginTop: 8 }} placeholder={t("composer.modelOrRolePlaceholder") || "@advisor / provider/model"} value={draft.advisorPattern} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, advisorPattern: event.target.value })} />
              ) : null}
            </div>
            <div className="field span2">
              <label htmlFor="sa-skills">{t("subagents.autoLoadSkills")}</label>
              <input className="input" id="sa-skills" placeholder="skill-a, skill-b" value={draft.autoloadSkills} disabled={definitionLocked} onChange={(event) => setDraft({ ...draft, autoloadSkills: event.target.value })} />
            </div>
          </div>
        </div>

        <details className="mp-advanced">
          <summary>{t("subagents.advancedMarkdown")}</summary>
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
              title={t("subagents.markdownPreviewTitle")}
              minHeight={240}
              maxHeight={360}
            />
          </div>
        </details>

        <div className="mp-sec">
          <h3>{t("subagents.sessionOverrideTitle")}</h3>
          <p className="sec-desc">{t("subagents.sessionOverrideDesc")}</p>
          <div className="f-grid">
            <div className="field">
              <label htmlFor="sa-override">{t("subagents.overrideModel")}</label>
              <input className="input mono" id="sa-override" list="sa-model-suggest" placeholder={t("subagents.overrideModelPlaceholder")} value={draft.overrideModel} onChange={(event) => setDraft({ ...draft, overrideModel: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="sa-prewalk-ov">{t("subagents.overridePrewalk")}</label>
              <input className="input mono" id="sa-prewalk-ov" placeholder="on / off / @smol" value={draft.prewalkOverride} onChange={(event) => setDraft({ ...draft, prewalkOverride: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="sa-advisor-ov">{t("subagents.overrideAdvisor")}</label>
              <input className="input mono" id="sa-advisor-ov" placeholder="on / off / @advisor" value={draft.advisorOverride} onChange={(event) => setDraft({ ...draft, advisorOverride: event.target.value })} />
            </div>
          </div>
        </div>

        <div className="mp-foot">
          {draft.canDelete ? (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => requestDelete({
                name: draft.name,
                scope: draft.scope,
                ...(draft.contentHash ? { contentHash: draft.contentHash } : {}),
              })}
            >
              {t("common.delete")}
            </button>
          ) : null}
          {draft.canFork ? <button type="button" className="btn outline" onClick={forkDraft}>{t("subagents.forkAndCustomize")}</button> : null}
          <div className="right">
            <button type="button" className="btn outline" onClick={() => setDraft(null)}>{t("common.cancel")}</button>
            <button
              type="submit"
              className="btn primary"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void saveDraft();
              }}
            >
              {busy ? t("common.saving") : draft.editable ? t("common.save") : t("subagents.saveOverride")}
            </button>
          </div>
        </div>
      </form>
      ) : (
    <>
      <div className="mr-toolbar">
        <input className="input" placeholder={t("subagents.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="seg src-filter">
          {FILTER_KEYS.map((item) => (
            <button type="button" key={item.id} className={sourceFilter === item.id ? "active" : undefined} onClick={() => setSourceFilter(item.id)}>{t(item.key)}</button>
          ))}
        </div>
        <span className="mr-count">{filtered.length} / {agents.length}</span>
        <span className="spacer" />
        <button type="button" className="btn small outline" disabled={preview} onClick={() => void refresh()} data-tip={preview ? t("common.demo") : undefined}>
          <Icon name="refresh" extra="sm" />{t("common.refresh")}
        </button>
        <button type="button" className="btn small primary" disabled={Boolean(loadError) && !preview} onClick={openNew}>
          <Icon name="plus" extra="sm" />{t("subagents.newSubagent")}
        </button>
      </div>
      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
      {preview ? <div className="role-issue-banner"><Icon name="sparkles" extra="sm" /><div><div className="rib-title">{t("subagents.demoNoticeTitle")}</div><div className="rib-text">{t("subagents.demoNoticeDesc")}</div></div></div> : null}
      {!preview && !data && !loadError ? <div className="preset-banner" role="status"><Icon name="refresh" extra="sm" /><span>{t("subagents.readingDefinitions")}</span></div> : null}
      {!preview && loadError ? <div className="role-issue-banner"><Icon name="alert" extra="sm" /><div><div className="rib-title">{t("subagents.readDescription")}</div><div className="rib-text">{loadError}</div></div></div> : null}
      {data?.warnings.length ? (
        <div className="preset-banner" role="status">
          <Icon name="alert" extra="sm" />
          <span>{data.warnings[0]}{data.warnings.length > 1 ? t("subagents.andMoreWarnings", { count: data.warnings.length - 1 }) : ""}</span>
        </div>
      ) : null}

      {grouped.length === 0 ? (
        <div className="empty">
          <Icon name="bot" />
          <div>{agents.length === 0 ? t("subagents.noAvailableAgents") : t("subagents.noMatchingAgents")}</div>
        </div>
      ) : (
        grouped.map((group) => (
          <div className="sa-group" key={group.source}>
            <div className="sa-group-label">{sourceLabel(group.source, t)} · {group.items.length}</div>
            <div className="pv-list">
              {group.items.map((agent) => (
                <article key={agent.name} className={`pv-card sa-card${agent.disabled ? " is-disabled" : ""}`}>
                  <button type="button" className="sa-card-main" onClick={() => openAgent(agent)}>
                    <div className="sa-card-top">
                      <Icon name="bot" extra="sm" />
                      <b>{agent.name}</b>
                      <span className={`chip ${SOURCE_CHIP[agent.source]} xs`}>{sourceLabel(agent.source, t)}</span>
                      {agent.disabled ? <span className="chip gray xs">{t("modelConfig.disabled")}</span> : null}
                      {agent.promptPacked ? <span className="chip gray xs">{t("skills.scopeBuiltin")}</span> : null}
                    </div>
                    <div className="sa-card-desc">{agent.description}</div>
                    <div className="sa-card-meta">
                      {agent.model?.length ? <span className="chip-code">{agent.model[0]}{agent.model.length > 1 ? ` +${agent.model.length - 1}` : ""}</span> : <span className="muted">{t("subagents.inheritedModelBadge")}</span>}
                      {agent.thinkingLevel ? <span className="chip gray xs">{agent.thinkingLevel}</span> : null}
                      <span className="muted">{toolCount(agent, t)}</span>
                      {agent.prewalk === true || typeof agent.prewalk === "string" ? <span className="chip blue xs">prewalk</span> : null}
                      {agent.advisor === true || typeof agent.advisor === "string" ? <span className="chip blue xs">advisor</span> : null}
                      {agent.blocking ? <span className="chip amber xs">blocking</span> : null}
                    </div>
                  </button>
                  <div className="sa-card-act">
                    {agent.canDelete ? (
                      <button
                        type="button"
                        className="sa-card-delete"
                        aria-label={`${t("common.delete")} ${agent.name}`}
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          requestDelete({
                            name: agent.name,
                            scope: agent.source === "project" ? "project" : "user",
                            ...(agent.contentHash ? { contentHash: agent.contentHash } : {}),
                          });
                        }}
                      >
                        <Icon name="trash" extra="sm" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`switch${agent.disabled ? "" : " on"}`}
                      role="switch"
                      aria-checked={!agent.disabled}
                      aria-label={agent.disabled ? `${t("common.enable")} ${agent.name}` : `${t("common.disable")} ${agent.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleEnabled(agent, agent.disabled);
                      }}
                    />
                    <button
                      type="button"
                      className="pv-act is-expand"
                      aria-label={t("subagents.openDetail", { name: agent.name })}
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
      {pendingDelete
        ? createPortal(
        <div className="modal-backdrop sa-delete-backdrop" role="presentation" onMouseDown={cancelPendingDelete}>
              <div
                className="modal sa-delete-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="saDeleteTitle"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="modal-head" id="saDeleteTitle">{t("subagents.deleteConfirmTitle")}</div>
                <div className="modal-body">
                  <p>{t("subagents.deleteConfirmDesc", { name: pendingDelete.name })}</p>
                  <p className="desc">
                    {preview ? t("subagents.deleteConfirmDemo") : t("subagents.deleteConfirmReal")}
                  </p>
                </div>
                <div className="modal-foot">
                  <button type="button" className="btn outline" autoFocus disabled={busy} onClick={cancelPendingDelete}>{t("common.cancel")}</button>
                  <button type="button" className="btn danger" disabled={busy} onClick={() => void confirmPendingDelete()}>
                    {busy ? t("subagents.deleting") : t("common.delete")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
