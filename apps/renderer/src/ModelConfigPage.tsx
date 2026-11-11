import { useProviderDiscovery } from "./models/config/useProviderDiscovery";
import "./styles/models-roles.css";
import { useListReorder } from "./models/useListReorder";
import { AppSelect } from "./AppSelect";
import { SlidingTabs } from "./SlidingTabs";
import { ModelCompactionPane } from "./models/ModelCompactionPane";
import { ModelPresetsPane } from "./models/ModelPresetsPane";
import { SessionOptionsPane } from "./models/SessionOptionsPane";
import { AccountStatusPane } from "./models/AccountStatusPane";
import { loadRuntimeModels } from "./models/runtimeModels";
import { RuntimeCredentials, VisionModelStatus } from "./models/RuntimeCredentials";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent, CSSProperties } from "react";
import type { ClientBootstrap, AvailableModelRecord, ConfigWriteResult, ModelConfigReadModel, ModelDiscoveryResult, ModelFallbackRevertPolicy, ModelProviderRecord, ModelRoleRecord, ModelRoleStorage, StudioClient } from "@omp-studio/client-contract";
import { modelAcceptsRole, isModelEnvConfigName } from "@omp-studio/client-contract";
import { Brand, hasBrand } from "./brands";
import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { ToastHost } from "./ToastHost";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { pageDir, pagePhaseClass, useDeferredKey, useDeferredPresence, useOverlayPresence } from "./pageTransition";
import { extractYamlMapEntry, mergeYamlMapEntry, parseStructured, readYamlMapEntryNode, StructuredEditor } from "./structured-editor";
import { usePreviewMode } from "./preview/PreviewContext";
import { MODEL_API_TYPES, MODEL_AUTH_TYPES, createPreviewModelConfig } from "./preview/modelConfigFixtures";
import { chooseFetchedModelCandidate, pickedCount, setAllPicked, togglePicked } from "./models/fetchedModels";
import { draftProviderYamlNode, nestedProviderYamlNode, serializeModelsYmlNode } from "./models/providerYaml";
import { SubagentsPanel } from "./SubagentsPanel";
import { WebSearchPanel } from "./models/WebSearchPanel";
import { createPreviewAgentDefinitions } from "./preview/subagentsPreview";
import { takeModelConfigIntent as takeIntent, type McTab } from "./pageIntents";
import { setModelConfigDirty } from "./models/modelConfigState";
import { ROLE_ICONS, ROLE_TINTS, groupModelsByProvider, fmtK } from "./models/modelPresentation";
import { type Draft, type ModelEditState, type ModelRoleDraft, type ModelsTab, type TestResultView } from "./models/config/types";
import { mergeProviderOrder, permuteVisible, readProviderOrder, sameOrder, sortProviders, writeProviderOrder } from "./models/config/providerOrder";
import { applyRoleSelector, assignedRoleIds, blankCustomForm, blankDraft, blankOverrideForm, draftFromPreset, draftFromProvider, draftsEqual, editorTestSecret, previewProviderFromDraft, providerUpsertFromDraft, readModelRoles, roleAssignDiff, roleAssignModCount, rolePrimaryUpdates, roleSelector, roleThinkingUi, rolesEqual, sameStringList, withPreviewLogin, withRoleModel, withRolePrimaryUpdates } from "./models/config/drafts";
import { SOURCE_GROUP, STATUS_META, formatProviderStatusDetail, formatRoleDesc } from "./models/config/presentation";
import { runProbe, runTest, runWrite } from "./models/config/commands";
import { AuthTypeSelect, BrandMark, DiscoveryResultBlock, ModelCaps, ProviderTestRow, confirmDiscardDirty } from "./models/config/ProviderControls";
import { RoleAssignControl, RoleModelPicker, RoleThinkingSeg } from "./models/config/RoleControls";
import { ModelParametersDialog } from "./models/config/ModelParametersDialog";

export { MC_INTENT_KEY, setModelConfigIntent, type McTab } from "./pageIntents";

export { modelConfigHasUnsavedChanges } from "./models/modelConfigState";

export { ModelPickCaps, ProviderGlyph, ROLE_ICONS, ROLE_TINTS, groupModelsByProvider, type ModelPickItem } from "./models/modelPresentation";

/* Written in tab-strip order: a tab swap travels the way the strip reads. */
const TAB_BUTTON_ID: Record<McTab, string> = {
  providers: "mcTabProviders",
  roles: "mcTabRoles",
  subagents: "mcTabSubagents",
  websearch: "mcTabWebSearch",
  presets: "mcTabPresets",
  accounts: "mcTabAccounts",
};
const mcTabRank = (tab: McTab): number => Object.keys(TAB_BUTTON_ID).indexOf(tab);

export function ModelConfigPage({ client, sessionId, workspaceId, runtimeAvailable = false, capabilities }: { capabilities?: ClientBootstrap["capabilityManifest"] | undefined; client: StudioClient; sessionId?: string | undefined; workspaceId?: string | undefined; runtimeAvailable?: boolean }) {
  const { resolvedLanguage } = useI18n();
  const [, updatePricingClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => updatePricingClock(tick => tick + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const { t } = useI18n();
  const { preview, marks } = usePreviewMode();
  const [tab, setTab] = useState<McTab>("providers");
  const { shown: shownTab, phase: tabPhase, dir: tabDir } = useDeferredKey(tab, mcTabRank);
  /* First paint must not play tabpanel page-in: it stacks on the shell/page-body
     translateY and Chromium flashes native placeholder glyphs at the wrong size.
     Arm only after a real tab change, same idea as useDeferredPresence `live`.
     useDeferredKey now reports "out" on the click paint, so the outgoing panel
     gets page-out rather than a one-frame page-in flash. */
  const tabMotionLive = useRef(false);
  if (!Object.is(tab, shownTab)) tabMotionLive.current = true;
  /* Tabs are siblings, so the swap runs sideways (data-page-axis) in strip order. */
  const tabPanelMotion = (id: McTab) => (shownTab === id && tabMotionLive.current
    ? { className: pagePhaseClass(tabPhase), "data-page-axis": "x", "data-page-dir": pageDir(tabDir) }
    : {});
  const [runtimeModels, setRuntimeModels] = useState<AvailableModelRecord[]>([]);
  const nativeLoad = useRef(0);
  const [data, setData] = useState<ModelConfigReadModel | null>(preview ? createPreviewModelConfig() : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "native" | "third">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editorState, setEditor] = useState<Draft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const { shown: editor, phase: editorPhase, live: editorLive, dir: editorDir } = useDeferredPresence(editorState);
  const [modelsYmlDraft, setModelsYmlDraft] = useState<string | null>(null);
  const [configYmlDraft, setConfigYmlDraft] = useState<string | null>(null);
  const [providerBaseline, setProviderBaseline] = useState<Draft | null>(null);
  const [roleBaseline, setRoleBaseline] = useState<ModelRoleRecord | null>(null);
  const [editExisting, setEditExisting] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetQuery, setPresetQuery] = useState("");
  const [presetSel, setPresetSel] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [roleDraftState, setRoleDraft] = useState<ModelRoleRecord | null>(null);
  const { shown: roleDraft, phase: rolePhase, live: roleLive, dir: roleDir } = useDeferredPresence(roleDraftState);
  const [assignSel, setAssignSel] = useState<string | null>(null);
  const [assignPopSel, setAssignPopSel] = useState<string | null>(null);
  const [assignModCounts, setAssignModCounts] = useState<Record<string, number>>({});
  const [roleAssignDraft, setRoleAssignDraft] = useState<Record<string, string[]>>({});
  const [agentIntent, setAgentIntent] = useState<string | undefined>(undefined);
  const [accountPoolsDirty, setAccountPoolsDirty] = useState(false);
  const [agentCount, setAgentCount] = useState(preview ? createPreviewAgentDefinitions().agents.length : 0);
  const [testResult, setTestResult] = useState<TestResultView | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cycleEdit, setCycleEdit] = useState(false);
  const [cycleDraft, setCycleDraft] = useState<string[]>([]);
  const [orderEdit, setOrderEdit] = useState(false);
  const [orderDraft, setOrderDraft] = useState<string[]>([]);
  const [probeResult, setProbeResult] = useState<ModelDiscoveryResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [catalogUpdating, setCatalogUpdating] = useState(false);
  const [createRoleOpen, setCreateRoleOpen] = useState(false);
  const [newRole, setNewRole] = useState({ id: "", name: "", desc: "" });
  const [fallbackDraft, setFallbackDraft] = useState<string[] | null>(null);
  const [revertPolicyDraft, setRevertPolicyDraft] = useState<ModelFallbackRevertPolicy | null>(null);
  const [modelsTab, setModelsTab] = useState<ModelsTab>("custom");
  const [modelEdit, setModelEdit] = useState<ModelEditState | null>(null);
  const { shown: modelEditView, leaving: modelEditLeaving } = useOverlayPresence(modelEdit);
  const [displayOrder, setDisplayOrder] = useState<string[]>(() => readProviderOrder());
  const { fetching, fetchDetail, setFetchDetail, candidates, setCandidates, onFetchModels, importCandidates } = useProviderDiscovery({ client, editorState, catalogVersion: data?.catalog?.version, setEditor, setModelsTab, toast: text => setFlash(text) });
  const loaded = useRef(false);
  const orderRef = useRef(displayOrder);
  orderRef.current = displayOrder;
  const { listRef, draggingId, dragPhase, onPointerDown: onProviderDragPointerDown } = useListReorder({
    order: displayOrder, selector: ".pv-card", gap: 10, sortingClass: "is-pv-sorting",
    onReorder(from, to, visible) {
      const nextVisible = visible.slice();
      const [moved] = nextVisible.splice(from, 1);
      if (!moved) return;
      nextVisible.splice(to, 0, moved);
      const nextOrder = permuteVisible(orderRef.current, visible, nextVisible);
      if (sameOrder(nextOrder, orderRef.current)) return;
      orderRef.current = nextOrder;
      setDisplayOrder(nextOrder);
      writeProviderOrder(nextOrder);
    },
  });

  const refresh = useCallback(async () => {
    if (preview) {
      setData(createPreviewModelConfig());
      setAgentCount(createPreviewAgentDefinitions().agents.length);
      setLoadError(null);
      return;
    }
    try {
      const [next, defs] = await Promise.all([
        client.query("models.get", {}),
        client.query("agents.definitions.get", {}).catch(() => null),
      ]);
      setData(next);
      setLoadError(next.unavailableReason ?? null);
      setAgentCount(defs?.agents.length ?? 0);
    } catch (error) {
      setLoadError(hostErrorMessage(error, "models.get failed"));
      setData(null);
    }
  }, [client, preview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const generation = ++nativeLoad.current;
    setRuntimeModels([]);
    if (preview || (tab !== "roles" && tab !== "websearch")) return;
    void loadRuntimeModels(client, () => generation === nativeLoad.current)
      .then(rows => { if (generation === nativeLoad.current) setRuntimeModels(rows); })
      .catch(() => { /* Disk configuration remains usable when Runtime is unavailable. */ });
    return () => { nativeLoad.current++; };
  }, [client, preview, tab, data]);


  const previewRef = useRef(preview);
  useEffect(() => {
    if (previewRef.current === preview) return;
    previewRef.current = preview;
    setEditor(null);
    setRoleDraft(null);
    setRoleId(null);
    setModelsYmlDraft(null);
    setConfigYmlDraft(null);
    setModelEdit(null);
    setProviderBaseline(null);
    setRoleBaseline(null);
    setProbeResult(null);
    setFetchDetail(null);
    setCandidates(null);
    setFallbackDraft(null);
    setRevertPolicyDraft(null);
    setCreateRoleOpen(false);
    setOrderEdit(false);
  }, [preview]);

  const hasProviderEditor = editorState !== null;
  const hasRoleEditor = roleDraftState !== null;

  useEffect(() => {
    if (!hasProviderEditor) {
      setProviderBaseline(null);
      setModelsYmlDraft(null);
      setModelEdit(null);
      setProbeResult(null);
      setFetchDetail(null);
      setCandidates(null);
    }
  }, [hasProviderEditor]);

  useEffect(() => {
    if (editorState && providerBaseline === null) setProviderBaseline(editorState);
  }, [editorState, providerBaseline]);

  useEffect(() => {
    if (!editorState) return;
    setModelsYmlDraft(null);
    setFetchDetail(null);
    setCandidates(null);
    const hasCatalog = editorState.models.some((m) => m.source === "catalog" || m.source === "extension");
    if (editorState.discoveryType) setModelsTab("discovery");
    else if (hasCatalog) setModelsTab("catalog");
    else setModelsTab("custom");
  }, [editorState?.id]);

  useEffect(() => {
    if (!hasRoleEditor) {
      setRoleBaseline(null);
      setConfigYmlDraft(null);
      setFallbackDraft(null);
      setRevertPolicyDraft(null);
    }
  }, [hasRoleEditor]);

  useEffect(() => {
    if (roleDraftState && roleBaseline === null) setRoleBaseline(roleDraftState);
  }, [roleDraftState, roleBaseline]);

  useEffect(() => {
    setConfigYmlDraft(null);
  }, [roleDraftState?.id]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const intent = takeIntent();
    if (!intent) return;
    if (intent.tab === "roles" || intent.role || intent.assign) setTab("roles");
    if (intent.tab === "subagents" || intent.agent) setTab("subagents");
    if (intent.tab === "websearch") setTab("websearch");
    if (intent.tab === "presets" || intent.tab === "accounts") setTab(intent.tab);
    if (intent.edit) {
      setTab("providers");
    }
    if (intent.assign) setAssignSel(intent.assign);
    if (intent.role) setRoleId(intent.role);
    if (intent.agent) setAgentIntent(intent.agent);
  }, []);

  useEffect(() => {
    if (editorState) return;
    setAssignPopSel(null);
    setRoleAssignDraft({});
  }, [editorState]);

  useEffect(() => {
    if (!data || !roleId || roleDraft) return;
    const role = data.roles.find((item) => item.id === roleId);
    if (role) setRoleDraft({ ...role });
  }, [data, roleId, roleDraft]);

  const providers = data?.providers ?? [];
  const roles = data?.roles ?? [];
  const [webSearchReadyCount, setWebSearchReadyCount] = useState(0);
  const presets = data?.presets ?? [];
  const modelEditListProvider = modelEditView?.providerId
    ? providers.find((item) => item.id === modelEditView.providerId)
    : undefined;
  const modelEditHost = modelEditView?.providerId
    ? (modelEditListProvider ? draftFromProvider(modelEditListProvider) : null)
    : editor;

  useEffect(() => {
    if (!data) return;
    const ids = data.providers.map((item) => item.id);
    setDisplayOrder((prev) => {
      const merged = mergeProviderOrder(ids, prev);
      if (sameOrder(merged, prev)) return prev;
      writeProviderOrder(merged);
      return merged;
    });
  }, [data]);


  const orderedProviders = useMemo(() => sortProviders(providers, displayOrder), [providers, displayOrder]);
  const filtered = orderedProviders.filter((item) => {
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
    const matchesSource = sourceFilter === "all" || SOURCE_GROUP(item.source) === sourceFilter;
    return matchesQuery && matchesSource;
  });
  const availCount = providers.filter((item) => item.enabled && item.status === "available").length;
  const roleIssues = roles.filter((role) => role.issue).length;

  const toast = (text: string) => {
    setFlash(text);
  };

  const modelsYmlSource = data?.generatedModelsYml || "providers: {}\n";
  const configYmlSource = data?.generatedConfigYml || "modelRoles: {}\n";
  const providerYamlId = editorState?.id.trim() ?? "";
  const roleYamlId = roleDraftState?.id.trim() ?? "";
  const modelsYmlSliceSource = providerYamlId
    ? extractYamlMapEntry(modelsYmlSource, ["providers", providerYamlId], {})
    : "";
  const configYmlSliceSource = roleYamlId
    ? extractYamlMapEntry(configYmlSource, ["modelRoles", roleYamlId], "")
    : "";
  const providerYamlNodeValue = useMemo(
    () => (providerYamlId
      ? nestedProviderYamlNode(readYamlMapEntryNode(modelsYmlSource, ["providers", providerYamlId]))
      : undefined),
    [modelsYmlSource, providerYamlId],
  );
  const providerFormDirty = Boolean(
    editorState && providerBaseline && !draftsEqual(editorState, providerBaseline),
  );
  const roleFormDirty = Boolean(
    roleDraftState && roleBaseline && !rolesEqual(roleDraftState, roleBaseline),
  );
  // The auth type the provider was loaded with resolves what a redacted
  // "********" apiKey hides; the read model reflects the file as last saved.
  const storedAuthType = providers.find((item) => item.id === providerYamlId)?.auth.type;
  // The card shows what the save would write: while the form carries unsaved
  // edits, the slice is derived from the form instead of from the file. The card
  // is read-only in that state, so the form and a hand edit never fight over the
  // same slice.
  const modelsYmlFormSlice = useMemo(
    () => providerFormDirty && editorState && providerYamlId
      ? serializeModelsYmlNode({ [providerYamlId]: draftProviderYamlNode(editorState, providerYamlNodeValue, storedAuthType) })
      : null,
    [providerFormDirty, editorState, providerYamlId, providerYamlNodeValue, storedAuthType],
  );
  const configYmlFormSlice = useMemo(
    () => roleFormDirty && roleDraftState?.primary && roleYamlId
      ? serializeModelsYmlNode({ [roleYamlId]: roleSelector(roleDraftState) })
      : null,
    [roleFormDirty, roleDraftState, roleYamlId],
  );
  // The card is driven by the form while the form carries unsaved edits: it is
  // read-only by construction, not merely reported as such.
  const providerCardLocked = providerFormDirty;
  const roleCardLocked = roleFormDirty;
  const modelsYmlSlice = modelsYmlFormSlice ?? modelsYmlSliceSource;
  const configYmlSlice = configYmlFormSlice ?? configYmlSliceSource;
  // A hand draft entered before the form went dirty is parked, not applied:
  // the form owns the slice, so display and save follow the same value. The
  // parked draft resurfaces only if the form returns to its baseline.
  const modelsYmlHandDraft = providerCardLocked ? null : modelsYmlDraft;
  const configYmlHandDraft = roleCardLocked ? null : configYmlDraft;
  const modelsYmlValue = modelsYmlHandDraft ?? modelsYmlSlice;
  const configYmlValue = configYmlHandDraft ?? configYmlSlice;
  /** A live hand edit of the card: a draft that actually differs from the slice. */
  const modelsYmlEdited = modelsYmlHandDraft !== null && modelsYmlHandDraft !== modelsYmlSlice;
  const configYmlEdited = configYmlHandDraft !== null && configYmlHandDraft !== configYmlSlice;
  const modelsYmlDirty = modelsYmlEdited;
  const configYmlDirty = configYmlEdited;
  const fallbackDirty = Boolean(
    roleDraftState && (
      (fallbackDraft !== null && !sameStringList(fallbackDraft, data?.fallbackChains[roleDraftState.id] ?? data?.fallbackChains[roleDraftState.primary] ?? []))
      || (revertPolicyDraft !== null && revertPolicyDraft !== (data?.fallbackRevertPolicy ?? "cooldown-expiry"))
    ),
  );
  const ymlCardsDirty = providerFormDirty || roleFormDirty || modelsYmlEdited || configYmlEdited || fallbackDirty;

  useEffect(() => {
    setModelConfigDirty(ymlCardsDirty || accountPoolsDirty);
    return () => {
      setModelConfigDirty(false);
    };
  }, [ymlCardsDirty, accountPoolsDirty]);

  const mutateLocal = (recipe: (current: ModelConfigReadModel) => ModelConfigReadModel) => {
    setData((current) => recipe(current ?? createPreviewModelConfig()));
  };

  const mergeContentHash = (hash: string | undefined) => {
    if (!hash) return;
    mutateLocal((current) => ({ ...current, contentHash: hash }));
  };

  const persistModelsYml = async (text: string, overlayForm: boolean, close: boolean): Promise<boolean> => {
    if (!providerYamlId) {
      toast(t("modelConfig.fillProviderId"));
      return false;
    }
    const merged = mergeYamlMapEntry(modelsYmlSource, ["providers", providerYamlId], text);
    if (!merged.ok) {
      toast(merged.message);
      return false;
    }
    const parsed = parseStructured("yaml", merged.text, false);
    if (!parsed.ok) {
      toast(parsed.message);
      return false;
    }
    const fullText = merged.text;
    const draft = editorState;
    if (overlayForm && (!draft || !draft.id.trim() || !draft.name.trim())) {
      toast(t("modelConfig.nameAndIdRequired"));
      return false;
    }
    if (preview) {
      mutateLocal((current) => {
        const next = { ...current, generatedModelsYml: fullText };
        if (overlayForm && draft) {
          const record = previewProviderFromDraft(draft);
          return { ...next, providers: [...current.providers.filter((item) => item.id !== record.id), record] };
        }
        return next;
      });
      if (overlayForm && draft) setProviderBaseline(draft);
      setModelsYmlDraft(null);
      if (close) setEditor(null);
      if (marks) toast(t("modelConfig.demoYamlUpdated"));
      return true;
    }
    setBusy(true);
    try {
      const overlay = overlayForm && draft ? providerUpsertFromDraft(draft) : undefined;
      const result = await runWrite(client, "models.yml.write", {
        text: fullText,
        ...(data?.contentHash ? { expectedHash: data.contentHash } : {}),
        ...(overlay ? { overlay } : {}),
      });
      toast(result.message ?? t("modelConfig.modelsYmlWritten"));
      setModelsYmlDraft(null);
      if (overlayForm && draft) setProviderBaseline(draft);
      mergeContentHash(result.contentHash);
      if (close) setEditor(null);
      await refresh();
      return true;
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const persistConfigYml = async (text: string, overlayForm: boolean, close: boolean): Promise<boolean> => {
    if (!roleYamlId) {
      toast(t("modelConfig.roleIdRequired"));
      return false;
    }
    const merged = mergeYamlMapEntry(configYmlSource, ["modelRoles", roleYamlId], text);
    if (!merged.ok) {
      toast(merged.message);
      return false;
    }
    const parsed = parseStructured("yaml", merged.text, false);
    if (!parsed.ok) {
      toast(parsed.message);
      return false;
    }
    const rolesMap = readModelRoles(parsed.value);
    const draft = roleDraftState;
    if (overlayForm && draft?.primary) {
      rolesMap[roleYamlId] = roleSelector(withRoleModel(
        { ...draft, id: roleYamlId },
        draft.primary,
        (data?.availableModels ?? []).find((item) => item.selector === draft.primary),
      ));
    }
    if (preview) {
      mutateLocal((current) => {
        const roles = current.roles.map((role) => {
          const selector = rolesMap[role.id];
          if (selector) return applyRoleSelector(role, selector);
          if (!role.primary) return role;
          const { issue: _ignored, thinking: _thinking, ...rest } = role;
          return { ...rest, primary: "" };
        });
        const generatedConfigYml = overlayForm
          ? `modelRoles:\n${roles
              .filter((role) => role.primary)
              .map((role) => `  ${role.id}: ${roleSelector(role)}`)
              .join("\n")}${roles.some((role) => role.primary) ? "\n" : ""}`
          : merged.text;
        return { ...current, roles, generatedConfigYml };
      });
      if (overlayForm && draft) setRoleBaseline(draft);
      setConfigYmlDraft(null);
      if (close) {
        setRoleDraft(null);
        setRoleId(null);
      }
      if (marks) toast(t("modelConfig.demoRoleYamlUpdated"));
      return true;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roles.write", { roles: rolesMap });
      toast(result.message ?? t("modelConfig.savedToConfigYml"));
      setConfigYmlDraft(null);
      if (overlayForm && draft) setRoleBaseline(draft);
      if (close) {
        setRoleDraft(null);
        setRoleId(null);
      }
      await refresh();
      return true;
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!editorState) return;
    if (!editorState.id.trim() || !editorState.name.trim()) {
      toast(t("modelConfig.nameAndIdRequired"));
      return;
    }
    if (editorState.authType === "env" && editorState.envName.trim() && !isModelEnvConfigName(editorState.envName.trim())) {
      toast(t("modelConfig.envNameInvalid"));
      return;
    }
    if (editorState.authType === "command" && !editorState.command.trim() && !editExisting) {
      toast(t("modelConfig.fillSecretCommand"));
      return;
    }
    const roleUpdates = rolePrimaryUpdates(roles, roleAssignDraft);
    // A hand-edited card or an unsaved form both go through the YAML write: the
    // form's model list, overrides and advanced fields only reach models.yml
    // when the overlay rides along with the text.
    if (modelsYmlDirty || providerFormDirty) {
      const saved = await persistModelsYml(modelsYmlValue, true, true);
      if (saved) {
        await applyRolePrimaryUpdates(roleUpdates);
        setRoleAssignDraft({});
      }
      return;
    }
    if (preview) {
      const record = previewProviderFromDraft(editorState);
      mutateLocal((current) => {
        const saved = withPreviewLogin(record, current);
        let next: ModelConfigReadModel = {
          ...current,
          providers: [...current.providers.filter((item) => item.id !== saved.id), saved],
        };
        if (roleUpdates.length > 0) next = withRolePrimaryUpdates(next, roleUpdates);
        return next;
      });
      setRoleAssignDraft({});
      setEditor(null);
      if (marks) toast(roleUpdates.length > 0 ? t("modelConfig.demoUpdatedListAndRoles") : t("modelConfig.demoUpdatedList"));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(
        client,
        "models.provider.upsert",
        providerUpsertFromDraft(editorState, data?.contentHash),
      );
      await applyRolePrimaryUpdates(roleUpdates, { announce: false, refreshAfter: false });
      setRoleAssignDraft({});
      mergeContentHash(result.contentHash);
      toast(roleUpdates.length > 0 ? t("modelConfig.savedAndRolesUpdated", { message: result.message ?? t("modelConfig.saved"), count: roleUpdates.length }) : (result.message ?? t("modelConfig.saved")));
      setEditor(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const persistProviderDraft = async (draft: Draft, okMessage: string) => {
    if (!draft.id.trim() || !draft.name.trim()) {
      toast(t("modelConfig.nameAndIdRequired"));
      return;
    }
    if (preview) {
      const record = previewProviderFromDraft(draft);
      mutateLocal((current) => {
        const saved = withPreviewLogin(record, current);
        return {
          ...current,
          providers: [...current.providers.filter((item) => item.id !== saved.id), saved],
        };
      });
      if (marks) toast(t("modelConfig.demoOkMessage", { message: okMessage }));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.provider.upsert", providerUpsertFromDraft(draft, data?.contentHash));
      mergeContentHash(result.contentHash);
      toast(result.message ?? okMessage);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async (id: string) => {
    if (preview) {
      mutateLocal((current) => ({ ...current, providers: current.providers.filter((item) => item.id !== id) }));
      if (marks) toast(t("modelConfig.demoRemoved"));
      return;
    }
    setBusy(true);
    try {
      await runWrite(client, "models.provider.delete", { id, ...(data?.contentHash ? { expectedHash: data.contentHash } : {}) });
      toast(t("modelConfig.deletedFromModelsYml"));
      setEditor(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.deleteFailed")));
    } finally {
      setBusy(false);
    }
  };

  const applyEnabledLocal = (id: string, enabled: boolean) => {
    mutateLocal((current) => ({
      ...current,
      providers: current.providers.map((item) => item.id === id
        ? { ...item, enabled, status: enabled ? (item.status === "disabled" ? "available" : item.status) : "disabled" }
        : item),
    }));
  };

  const toggleEnabled = async (provider: ModelProviderRecord) => {
    const enabled = !provider.enabled;
    applyEnabledLocal(provider.id, enabled);
    if (preview) {
      if (marks) toast(enabled ? t("modelConfig.demoEnabled", { name: provider.name }) : t("modelConfig.demoDisabled", { name: provider.name }));
      return;
    }
    const snapshot = data;
    setBusy(true);
    try {
      const result = await runWrite(client, "models.provider.setEnabled", { id: provider.id, enabled });
      const nextHash = result.contentHash;
      if (nextHash) {
        mutateLocal((current) => ({ ...current, contentHash: nextHash }));
      }
      toast(enabled ? t("modelConfig.enabled", { name: provider.name }) : t("modelConfig.disabledNoRouting", { name: provider.name }));
    } catch (error) {
      if (snapshot) setData(snapshot);
      else applyEnabledLocal(provider.id, provider.enabled);
      toast(hostErrorMessage(error, t("modelConfig.updateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const applyRolePrimaryUpdates = async (
    updates: ReadonlyArray<{ role: ModelRoleRecord; selector: string }>,
    opts?: { announce?: boolean; refreshAfter?: boolean },
  ) => {
    if (updates.length === 0) return;
    if (preview) {
      mutateLocal((current) => withRolePrimaryUpdates(current, updates));
      if (opts?.announce !== false && marks) toast(t("modelConfig.demoAssignedRoles", { count: updates.length }));
      return;
    }
    let last: ConfigWriteResult | undefined;
    for (const item of updates) {
      const model = (data?.availableModels ?? []).find((entry) => entry.selector === item.selector);
      last = await runWrite(client, "models.roles.set", {
        roleId: item.role.id,
        selector: item.selector ? roleSelector(withRoleModel(item.role, item.selector, model)) : "",
      });
    }
    if (opts?.announce !== false) toast(last?.message ?? t("modelConfig.assignedRoles", { count: updates.length }));
    if (opts?.refreshAfter !== false) await refresh();
  };

  const commitRoleAssign = (sel: string, addedIds: string[], removedIds: string[] = []) => {
    const updates: Array<{ role: ModelRoleRecord; selector: string }> = [];
    for (const id of addedIds) {
      const role = roles.find((item) => item.id === id);
      if (role) updates.push({ role, selector: sel });
    }
    for (const id of removedIds) {
      const role = roles.find((item) => item.id === id);
      if (role) updates.push({ role, selector: "" });
    }
    if (updates.length === 0) return;
    setAssignModCounts((current) => ({ ...current, [sel]: updates.length }));
    void applyRolePrimaryUpdates(updates);
  };

  const onRoleAssignDraft = (id: string, picked: string[]) => {
    setRoleAssignDraft((current) => {
      const baseline = assignedRoleIds(roles, id);
      const { added, removed } = roleAssignDiff(picked, baseline);
      if (added.length === 0 && removed.length === 0) {
        if (!(id in current)) return current;
        const { [id]: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, [id]: picked };
    });
  };

  const saveRole = async (role: ModelRoleRecord) => {
    const id = role.id.trim();
    const name = role.name.trim();
    const desc = role.desc.trim();
    const model = (data?.availableModels ?? []).find((item) => item.selector === role.primary);
    const next = withRoleModel({ ...role, id, alias: `@${id}`, name, desc }, role.primary, model);
    const selector = role.primary ? roleSelector(next) : "";
    const baseline = hasRoleEditor ? roleBaseline : null;
    const persistIdentity = Boolean(
      hasRoleEditor
      && !role.builtin
      && baseline
      && (baseline.id !== id || baseline.name !== name || baseline.desc !== desc),
    );
    if (!role.builtin) {
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
        toast(t("modelConfig.roleIdInvalid"));
        return;
      }
      if (!name) {
        toast(t("modelConfig.fillRoleName"));
        return;
      }
      const taken = roles.some((item) => item.id === id && item.id !== (baseline?.id ?? role.id));
      if (taken) {
        toast(t("modelConfig.roleIdTaken"));
        return;
      }
    } else if (!role.primary) {
      toast(t("modelConfig.selectPrimaryFirst"));
      return;
    }
    const renamed = Boolean(persistIdentity && baseline && baseline.id !== id);
    if (preview) {
      mutateLocal((current) => {
        const saved = { ...next };
        const { issue: _ignored, ...rest } = saved;
        const record = rest;
        if (renamed && baseline) {
          return { ...current, roles: [...current.roles.filter((item) => item.id !== baseline.id), record] };
        }
        return {
          ...current,
          roles: current.roles.map((item) => (item.id === (baseline?.id ?? role.id) ? record : item)),
        };
      });
      if (marks) toast((next.thinkingAdjustment ? `${next.thinkingAdjustment} · ` : "") + t("modelConfig.demoRoleUpdated"));
      setRoleId(null);
      setRoleDraft(null);
      return;
    }
    setBusy(true);
    try {
      if (persistIdentity) {
        await runWrite(client, "models.roles.create", {
          id,
          name,
          ...(desc ? { desc } : {}),
          ...(selector ? { selector } : {}),
        });
        if (renamed && baseline) {
          await runWrite(client, "models.roles.delete", { roleId: baseline.id });
        }
      } else if (selector) {
        await runWrite(client, "models.roles.set", { roleId: id, selector });
      } else {
        toast(t("modelConfig.selectPrimaryFirst"));
        return;
      }
      toast((next.thinkingAdjustment ? `${next.thinkingAdjustment} · ` : "") + t("modelConfig.savedToConfigToast"));
      setRoleId(null);
      setRoleDraft(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const [loginFlowByProvider, setLoginFlowByProvider] = useState<Record<string, string>>({});
  const startLogin = async (providerId: string, loginId?: string) => {
    if (!providerId.trim()) {
      toast(t("modelConfig.fillProviderId"));
      return;
    }
    if (preview) {
      mutateLocal((current) => {
        const known = current.loginProviders.some((item) => item.id === providerId);
        const loginProviders = known
          ? current.loginProviders.map((item) => item.id === providerId ? { ...item, authenticated: true } : item)
          : [...current.loginProviders, {
              id: providerId,
              name: current.providers.find((item) => item.id === providerId)?.name ?? providerId,
              available: true,
              authenticated: true,
            }];
        return {
          ...current,
          loginProviders,
          providers: current.providers.map((item) => item.id === providerId
            ? {
                ...item,
                status: item.enabled ? "available" : item.status,
                statusDetail: t("modelConfig.statusDemoAccount"),
                auth: { ...item.auth, type: "oauth", hasSecret: true, account: item.auth.account ?? "demo@local" },
              }
            : item),
        };
      });
      if (marks) toast(t("modelConfig.toastDemoLogin"));
      return;
    }
    if (!data?.loginAvailable) {
      toast(t("modelConfig.toastTerminalLogin", { providerId }));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.login.start", { providerId, ...(loginId ? { loginId } : {}) });
      toast(result.message ?? t("modelConfig.toastLoginCompleted"));
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.toastLoginFailed", { providerId })));
    } finally {
      setBusy(false);
    }
  };

  const logoutProvider = async (providerId: string) => {
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        loginProviders: current.loginProviders.map((item) => item.id === providerId ? { ...item, authenticated: false } : item),
        providers: current.providers.map((item) => {
          if (item.id !== providerId) return item;
          const { account: _dropped, ...auth } = item.auth;
          return { ...item, statusDetail: t("modelConfig.statusNotLoggedIn"), auth: { ...auth, hasSecret: false } };
        }),
      }));
      if (marks) toast(t("modelConfig.toastDemoLogout"));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.login.logout", { providerId });
      toast(result.message ?? t("modelConfig.toastLogoutNamed", { providerId }));
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.toastLogoutFailed")));
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (source: "list" | "editor", providerId?: string, api?: string, endpointUrl?: string, apiKey?: string) => {
    if (preview) {
      // 演示：本地模拟结果，不调 Host、不写 reducer。
      setTestResult({
        source,
        providerId,
        ok: true,
        latencyMs: 23 + Math.floor(Math.random() * 60),
        detail: marks ? t("modelConfig.detailDemoConnectHttp200") : "HTTP 200",
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await runTest(client, {
        ...(providerId ? { providerId } : {}),
        ...(api ? { api } : {}),
        ...(endpointUrl ? { endpointUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setTestResult({ source, providerId, ...result });
    } catch (error) {
      setTestResult({ source, providerId, ok: false, latencyMs: 0, detail: hostErrorMessage(error, t("modelConfig.detailTestFailed")) });
    } finally {
      setTesting(false);
    }
  };

  const previewProbeResult = (providerId: string): ModelDiscoveryResult => ({
    ok: true,
    found: 3,
    usable: 3,
    models: [
      { id: "qwen2.5", name: "qwen2.5" },
      { id: "llama3.2", name: "llama3.2" },
      { id: "deepseek-r1", name: "deepseek-r1" },
    ],
    latencyMs: 28,
    detail: marks ? t("modelConfig.detailDemoProbeSuccess", { providerId }) : t("modelConfig.probeSuccess"),
  });

  const onProbe = async (providerId: string, endpointUrl?: string, apiKey?: string, discoveryType?: string, timeoutMs?: number) => {
    if (preview) {
      setProbeResult(previewProbeResult(providerId));
      if (marks) toast(t("modelConfig.toastDemoDiscoveryNoHost"));
      return;
    }
    setProbing(true);
    setProbeResult(null);
    try {
      const result = await runProbe(client, {
        providerId,
        ...(endpointUrl !== undefined ? { endpointUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(discoveryType ? { discoveryType } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      setProbeResult(result);
    } catch (error) {
      setProbeResult({
        ok: false,
        found: 0,
        usable: 0,
        models: [],
        latencyMs: 0,
        detail: hostErrorMessage(error, t("modelConfig.detailProbeFailed")),
      });
    } finally {
      setProbing(false);
    }
  };

  const updateModelCatalog = async () => {
    if (preview) { if (marks) toast(t("modelAdaptation.demoUpdate")); return; }
    setCatalogUpdating(true);
    try {
      const handle = await client.command("models.catalog.refresh", {});
      const result = await waitReceipt<import("@omp-studio/client-contract").ModelCatalogRefreshResult>(client, handle.requestId);
      setData(current => current ? { ...current, catalog: result.catalog } : current);
      toast(result.message);
    } catch (error) { toast(hostErrorMessage(error, t("modelConfig.toastRefreshFailed"))); }
    finally { setCatalogUpdating(false); }
  };

  const refreshDiscovery = async () => {
    if (preview) {
      if (marks) toast(t("modelConfig.toastDemoNoRefresh"));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.discovery.refresh", {});
      toast(result.message ?? t("modelConfig.toastRescannedDiscovery"));
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.toastRefreshFailed")));
    } finally {
      setBusy(false);
    }
  };

  const setRoleStorage = async (storage: ModelRoleStorage) => {
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        modelRoleStorage: storage,
        roles: current.roles.map((role) => ({ ...role, scope: storage })),
      }));
      if (marks) toast(storage === "project" ? t("modelConfig.toastDemoScopeProject") : t("modelConfig.toastDemoScopeGlobal"));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roleStorage.set", { storage });
      toast(result.message ?? t("modelConfig.toastScopeUpdated"));
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.toastScopeUpdateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const createCustomRole = async () => {
    const id = newRole.id.trim();
    const name = newRole.name.trim() || id;
    if (!id) {
      toast(t("modelConfig.toastFillRoleId"));
      return;
    }
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        roles: [...current.roles, {
          id,
          alias: `@${id}`,
          name,
          desc: newRole.desc.trim() || t("modelConfig.defaultCustomRoleDesc"),
          builtin: false,
          primary: "",
          scope: current.modelRoleStorage,
        }],
      }));
      setCreateRoleOpen(false);
      setNewRole({ id: "", name: "", desc: "" });
      if (marks) toast(t("modelConfig.toastDemoCustomRoleCreated"));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roles.create", {
        id,
        name,
        ...(newRole.desc.trim() ? { desc: newRole.desc.trim() } : {}),
      });
      toast(result.message ?? t("modelConfig.toastRoleCreatedNamed", { id }));
      setCreateRoleOpen(false);
      setNewRole({ id: "", name: "", desc: "" });
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.toastRoleCreateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const deleteCustomRole = async (roleId: string) => {
    if (preview) {
      mutateLocal((current) => ({ ...current, roles: current.roles.filter((role) => role.id !== roleId) }));
      setRoleDraft(null);
      setRoleId(null);
      if (marks) toast(t("modelConfig.toastDemoCustomRoleDeleted"));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roles.delete", { roleId });
      toast(result.message ?? t("modelConfig.toastRoleDeletedNamed", { roleId }));
      setRoleDraft(null);
      setRoleId(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.toastRoleDeleteFailed")));
    } finally {
      setBusy(false);
    }
  };

  const saveFallback = async (role: string, primary: string) => {
    const chains = { ...(data?.fallbackChains ?? {}) };
    const nextChain = [...(fallbackDraft ?? chains[role] ?? chains[primary] ?? [])];
    chains[role] = nextChain;
    const revertPolicy = revertPolicyDraft ?? data?.fallbackRevertPolicy ?? "cooldown-expiry";
    if (preview) {
      mutateLocal((current) => ({ ...current, fallbackChains: chains, fallbackRevertPolicy: revertPolicy }));
      setFallbackDraft(nextChain);
      setRevertPolicyDraft(revertPolicy);
      if (marks) toast(t("modelConfig.toastDemoFallbackUpdated"));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.fallback.set", { chains, revertPolicy });
      toast(result.message ?? t("modelConfig.toastFallbackSaved"));
      setFallbackDraft(nextChain);
      setRevertPolicyDraft(revertPolicy);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.toastFallbackSaveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const saveProviderOrder = async () => {
    if (preview) {
      mutateLocal((current) => ({ ...current, modelProviderOrder: orderDraft.slice() }));
      if (marks) toast(t("modelConfig.toastDemoModelProviderOrderUpdated"));
      setOrderEdit(false);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.providerOrder.set", { order: orderDraft.slice() });
      toast(result.message ?? t("modelConfig.toastModelProviderOrderSaved"));
      setOrderEdit(false);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const closeProviderEditor = () => {
    if ((providerFormDirty || modelsYmlDirty) && !confirmDiscardDirty(t)) return;
    setEditor(null);
  };

  const closeRoleEditor = () => {
    if ((roleFormDirty || configYmlDirty || fallbackDirty) && !confirmDiscardDirty(t)) return;
    setRoleDraft(null);
    setRoleId(null);
  };

  const saveCycle = async () => {
    if (preview) {
      mutateLocal((current) => ({ ...current, cycleOrder: cycleDraft.slice() }));
      if (marks) toast(t("modelConfig.toastDemoLocalOrderUpdated"));
      setCycleEdit(false);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.cycleOrder.set", { order: cycleDraft.slice() });
      toast(result.message ?? t("modelConfig.toastOrderSaved"));
      setCycleEdit(false);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const usable = useMemo(() => {
    const models = data?.availableModels ?? [];
    const merged = new Map(models.filter(model => (preview && !providers.some(provider => provider.id === model.provider)) || providers.some(provider => provider.id === model.provider && provider.enabled && provider.status !== "disabled")).map(model => [model.selector, model]));
    for (const model of runtimeModels) if (!providers.some(provider => provider.id === model.provider && !provider.enabled)) merged.set(model.selector, { ...model, ...merged.get(model.selector) });
    return [...merged.values()];
  }, [data, providers, runtimeModels, preview]);
  const availableBySelector = useMemo(() => {
    const map = new Map<string, AvailableModelRecord>();
    for (const model of data?.availableModels ?? []) map.set(model.selector, model);
    for (const provider of providers) {
      for (const entry of provider.models) {
        const current = map.get(entry.selector);
        if (entry.thinking && entry.thinking.length > 0) {
          map.set(entry.selector, {
            provider: provider.id,
            id: entry.id,
            selector: entry.selector,
            name: entry.name,
            reasoning: entry.reasoning,
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
            ...(entry.webSearch === undefined ? {} : { webSearch: entry.webSearch }),
            image: entry.image,
            tools: entry.tools,
            ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
            ...(entry.cost ? { cost: entry.cost } : {}),
            thinking: entry.thinking,
            ...(entry.thinkingConfig === undefined ? {} : { thinkingConfig: entry.thinkingConfig }),
          });
        } else if (!current) {
          map.set(entry.selector, {
            provider: provider.id,
            id: entry.id,
            selector: entry.selector,
            name: entry.name,
            reasoning: entry.reasoning,
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
            ...(entry.webSearch === undefined ? {} : { webSearch: entry.webSearch }),
            image: entry.image,
            tools: entry.tools,
            ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
            ...(entry.cost ? { cost: entry.cost } : {}),
            ...(entry.thinkingConfig === undefined ? {} : { thinkingConfig: entry.thinkingConfig }),
          });
        }
      }
    }
    for (const model of runtimeModels) map.set(model.selector, { ...model, ...map.get(model.selector) });
    return map;
  }, [data, providers, runtimeModels]);

  const catalogStatus = preview && marks ? t("modelAdaptation.demo") : data?.catalog?.version ?? t("modelAdaptation.catalogUnknown");

  return (
    <div className="page-wide" id="mcRoot">
      <a className="skip-link" href="#mcPanels">{t("common.skipToContent")}</a>
      <div className="mc-tabbar">
        <SlidingTabs<McTab>
          id="mcTabs"
          className="mc-tabs"
          ariaLabel={t("modelConfig.modelConfigView")}
          orientation="horizontal"
          value={tab}
          onChange={setTab}
          items={[
            { id: "providers", icon: "server", label: t("modelConfig.providersTab"), buttonId: TAB_BUTTON_ID.providers, panelId: "mcPanelProviders", badge: <span className={`chip ${availCount === 0 && providers.length > 0 ? "amber" : "gray"} xs`}>{providers.length}<span className="sr-only"> {t("modelConfig.providersCountAria", { count: providers.length })}</span></span> },
            { id: "roles", icon: "steering", label: t("modelConfig.rolesTab"), buttonId: TAB_BUTTON_ID.roles, panelId: "mcPanelRoles", badge: <span className={`chip ${roleIssues ? "red" : "gray"} xs`}>{roles.length}<span className="sr-only"> {t("modelConfig.rolesCountAria", { count: roles.length })}</span></span> },
            { id: "subagents", icon: "bot", label: t("modelConfig.subagentsTab"), buttonId: TAB_BUTTON_ID.subagents, panelId: "mcPanelSubagents", badge: <span className="chip gray xs">{agentCount}<span className="sr-only"> {t("modelConfig.subagentsCountAria", { count: agentCount })}</span></span> },
            { id: "websearch", icon: "globe", label: t("modelConfig.webSearchTab"), buttonId: TAB_BUTTON_ID.websearch, panelId: "mcPanelWebSearch", badge: <span className={`chip ${webSearchReadyCount === 0 ? "amber" : "gray"} xs`}>{webSearchReadyCount}<span className="sr-only"> {t("modelConfig.webSearchCountAria", { count: webSearchReadyCount })}</span></span> },
            { id: "presets", icon: "layers", label: resolvedLanguage === "zh" ? "预设" : "Presets", buttonId: TAB_BUTTON_ID.presets, panelId: "mcPanelPresets" },
            { id: "accounts", icon: "user", label: resolvedLanguage === "zh" ? "账户" : "Accounts", buttonId: TAB_BUTTON_ID.accounts, panelId: "mcPanelAccounts" },
          ]}
        />
        <div className="mc-catalog-update">
          <span className="mc-catalog-status" data-tip={`${t("modelAdaptation.catalogHint")} ${catalogStatus}`}>
            <span>{t("modelAdaptation.catalog")}</span>
            <span className="mc-catalog-version" aria-live="polite">{catalogStatus}</span>
          </span>
          <button type="button" className="icon-btn mc-catalog-refresh" aria-label={t(catalogUpdating ? "modelAdaptation.updating" : "modelAdaptation.update")} data-tip={t(catalogUpdating ? "modelAdaptation.updating" : "modelAdaptation.update")} disabled={catalogUpdating || (!preview && !data)} onClick={() => void updateModelCatalog()}>
            {catalogUpdating ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" extra="sm" />}
          </button>
        </div>
      </div>

      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
      {preview && marks ? (
        <div className="role-issue-banner mc-page-banner">
          <Icon name="info" extra="sm" />
          <div>
            <div className="rib-title">{t("modelConfig.previewBannerTitle")}</div>
            <div className="rib-text">{t("modelConfig.previewBannerText")}</div>
          </div>
        </div>
      ) : null}
      {!preview && loadError ? <div className="role-issue-banner mc-page-banner"><Icon name="alert" extra="sm" /><div><div className="rib-title">{t("modelConfig.loadErrorTitle")}</div><div className="rib-text">{loadError}</div></div></div> : null}

      <div id="mcPanels" tabIndex={-1}>
        <section id="mcPanelPresets" role="tabpanel" aria-labelledby="mcTabPresets" hidden={shownTab !== "presets"} {...tabPanelMotion("presets")}>
          <ModelPresetsPane client={client} sessionId={sessionId} available={runtimeAvailable} capabilities={capabilities} visible={shownTab === "presets"} />
        </section>
        <section id="mcPanelAccounts" role="tabpanel" aria-labelledby="mcTabAccounts" hidden={shownTab !== "accounts"} {...tabPanelMotion("accounts")}>
          <AccountStatusPane sessionId={sessionId} standalone visible={shownTab === "accounts"} client={client} available={runtimeAvailable} capabilities={capabilities} />
          <SessionOptionsPane client={client} sessionId={sessionId} available={runtimeAvailable} capabilities={capabilities} visible={shownTab === "accounts"} />
          <RuntimeCredentials client={client} preview={preview} />
        </section>
        <section id="mcPanelProviders" role="tabpanel" aria-labelledby="mcTabProviders" hidden={shownTab !== "providers"} {...tabPanelMotion("providers")}>
          <div className={editorLive ? `mc-view ${pagePhaseClass(editorPhase)}` : "mc-view"} data-page-dir={pageDir(editorDir)}>
          {editor ? (
            <>
            <form className="mp-editor" onSubmit={(event) => void saveProvider(event)}>
              <div className="mr-toolbar">
                <button type="button" className="icon-btn" onClick={closeProviderEditor}><Icon name="arrow-l" /></button>
                {hasBrand(editor.id) ? <Brand id={editor.id} extra="lg" /> : null}
                <b style={{ fontSize: "var(--fs-14)" }}>{editExisting ? t("modelConfig.editProviderNamed", { name: editor.name }) : t("modelConfig.newProvider")}</b>
                {presetSel ? <span className="chip blue xs">{t("modelConfig.presetTemplateNamed", { name: presetSel })}</span> : <span className="chip purple xs">{t("modelConfig.customProviderBadge")}</span>}
              </div>

              {!editExisting ? (
                <div className={`preset-entry${presetOpen ? " open" : ""}`}>
                  <button type="button" className="preset-toggle" aria-expanded={presetOpen} onClick={() => setPresetOpen((value) => !value)}>
                    <span className="tw"><Icon name="chevron-r" /></span>
                    <Icon name="layers" extra="sm" />
                    <b>{t("modelConfig.createFromPresetTemplate")}</b>
                    <span className="hint">{t("modelConfig.createFromPresetHint")}</span>
                    <span className="spacer" />
                    <span className="chip gray xs">{t("modelConfig.presetsCount", { count: presets.reduce((n, group) => n + group.items.length, 0) })}</span>
                  </button>
                  {presetOpen ? (
                    <div className="preset-body">
                      <input className="input preset-search" placeholder={t("modelConfig.searchPresetPlaceholder")} value={presetQuery} onChange={(event) => setPresetQuery(event.target.value)} />
                      {presets.map((group) => {
                        const items = group.items.filter((item) => !presetQuery || item.name.toLowerCase().includes(presetQuery.toLowerCase()) || item.id.includes(presetQuery.toLowerCase()));
                        if (!items.length) return null;
                        return (
                          <div key={group.group}>
                            <div className="preset-group-label">{group.group} · {items.length}</div>
                            <div className="preset-grid">
                              {items.map((item) => (
                                <button type="button" key={item.id} className={`preset-item${presetSel === item.id ? " sel" : ""}`} onClick={() => { setProviderBaseline(null); setEditor(draftFromPreset(item)); setPresetSel(item.id); }}>
                                  <span className="pi-name">{hasBrand(item.id) ? <Brand id={item.id} extra="sm" /> : null}{item.name}{item.popular ? <span className="chip purple xs">{t("modelConfig.popularBadge")}</span> : null}{item.local ? <span className="chip blue xs">{t("modelConfig.localBadge")}</span> : null}</span>
                                  <span className="pi-desc">{item.desc}</span>
                                  <span className="pi-desc">{item.auth.map((auth) => MODEL_AUTH_TYPES.find((entry) => entry.id === auth)?.label ?? auth).join(" · ")}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="mp-sec">
                <h3>{t("modelConfig.basicInfoSection")}</h3>
                <div className="f-grid">
                  <div className="field"><label htmlFor="f-name">{t("modelConfig.providerNameLabel")}</label><input className="input" id="f-name" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></div>
                  <div className="field">
                    <label htmlFor="f-id">Provider ID</label>
                    <input className="input mono" id="f-id" value={editor.id} readOnly={editExisting} onChange={(event) => {
                      const id = event.target.value;
                      const prevConv = `${editor.id.replace(/-/g, "_").toUpperCase()}_API_KEY`;
                      const nextConv = `${id.replace(/-/g, "_").toUpperCase()}_API_KEY`;
                      setEditor({
                        ...editor,
                        id,
                        envName: !editor.envName.trim() || editor.envName === prevConv ? nextConv : editor.envName,
                      });
                    }} />
                    <span className="desc">{t("modelConfig.providerIdHelper", { format: `${editor.id || "provider-id"}/model-id` })}</span>
                  </div>
                  <div className="field"><label htmlFor="f-site">{t("modelConfig.websiteLabel")}</label><input className="input mono" id="f-site" value={editor.website} onChange={(event) => setEditor({ ...editor, website: event.target.value })} /></div>
                  <div className="field"><label htmlFor="f-note">{t("modelConfig.notesLabel")}</label><input className="input" id="f-note" value={editor.note} onChange={(event) => setEditor({ ...editor, note: event.target.value })} /></div>
                </div>

                <div className="mp-sec-divider" aria-hidden="true" />

                <h3>{t("modelConfig.authSection")}</h3>
                <AuthTypeSelect
                  value={editor.authType}
                  onChange={(authType) => {
                    const envName = editor.envName.trim()
                      || `${(editor.id || "provider").replace(/-/g, "_").toUpperCase()}_API_KEY`;
                    setEditor({ ...editor, authType, envName });
                  }}
                />
                <div className="auth-box">
                  {editor.authType === "oauth" ? (() => {
                    const login = data?.loginProviders.find((item) => item.id === editor.id);
                    const authed = Boolean(login?.authenticated);
                    const account = marks ? data?.providers.find((item) => item.id === editor.id)?.auth.account : undefined;
                    return (
                      <>
                        <div className="auth-status">
                          <Icon name={authed ? "check" : data?.loginAvailable ? "key" : "info"} extra="sm" />
                          <span>
                            {authed
                              ? <>{t("modelConfig.loginCompleted", { account: account ? ` ${account}` : ` ${t("modelConfig.localOauthCredential")}` })}</>
                              : data?.loginAvailable
                                ? t("modelConfig.loginPrompt")
                                : <>{t("modelConfig.loginCliPrompt", { provider: editor.id || "provider" })}</>}
                          </span>
                          <span className={`chip ${authed ? "green" : "gray"} xs`}>{authed ? t("modelConfig.credentialValid") : t("modelConfig.notLoggedIn")}</span>
                        </div>
                        <div className="auth-actions">
                          {login?.flows?.length ? <AppSelect aria-label="登录方式 / Login method" className="select" value={loginFlowByProvider[editor.id] ?? login.flows[0]!.id} disabled={busy} onChange={event => setLoginFlowByProvider(current => ({ ...current, [editor.id]: event.target.value }))}>{login.flows.map(flow => <option key={flow.id} value={flow.id}>{flow.name}</option>)}</AppSelect> : null}
                          <button type="button" className={`btn small ${authed ? "outline" : "primary"}`} disabled={busy} onClick={() => void startLogin(editor.id, loginFlowByProvider[editor.id] ?? login?.flows?.[0]?.id)}>
                            <Icon name="key" extra="sm" />
                            {authed ? t("modelConfig.relogin") : t("modelConfig.login")}
                          </button>
                          {authed ? (
                            <button type="button" className="btn small outline" disabled={busy} onClick={() => void logoutProvider(editor.id)}>{t("modelConfig.logout")}</button>
                          ) : null}
                        </div>
                      </>
                    );
                  })() : null}
                  {editor.authType === "api-key" ? (
                    <div className="field">
                      <label htmlFor="f-key">API Key</label>
                      <div className="pwd-input">
                        <input
                          className="input mono"
                          id="f-key"
                          type={showKey ? "text" : "password"}
                          value={editor.apiKey}
                          placeholder={t("modelConfig.apiKeyPlaceholder")}
                          autoComplete="off"
                          onChange={(event) => setEditor({ ...editor, apiKey: event.target.value })}
                        />
                        <button
                          type="button"
                          className="pwd-toggle"
                          aria-label={showKey ? t("modelConfig.hideApiKeyAria") : t("modelConfig.showApiKeyAria")}
                          aria-pressed={showKey}
                          data-tip={showKey ? t("common.hide") : t("common.show")}
                          onClick={() => setShowKey((value) => !value)}
                        >
                          <Icon name={showKey ? "eye-off" : "eye"} extra="sm" />
                        </button>
                      </div>
                      <span className="desc">{editor.apiKey ? t("modelConfig.apiKeyHelperConfigured") : t("modelConfig.apiKeyHelperNotConfigured")}</span>
                    </div>
                  ) : null}
                  {editor.authType === "env" ? (() => {
                    const name = editor.envName.trim();
                    const valid = !name || isModelEnvConfigName(name);
                    const saved = data?.providers.find((item) => item.id === editor.id);
                    const detected = saved?.auth.type === "env" && saved.auth.envName === name && saved.auth.hasSecret;
                    return (
                      <div className="field">
                        <label htmlFor="f-env">Environment Variable Name</label>
                        <input
                          className="input mono"
                          id="f-env"
                          value={editor.envName}
                          placeholder={t("modelConfig.envVarPlaceholder")}
                          aria-invalid={!valid}
                          onChange={(event) => setEditor({ ...editor, envName: event.target.value })}
                        />
                        <span className="desc">
                          {!valid
                            ? t("modelConfig.envVarInvalidDesc")
                            : name
                              ? detected
                                ? <span className="auth-env-ok">{t("modelConfig.envVarDetectedDesc", { name })}</span>
                                : preview && marks
                                  ? t("modelConfig.envVarPreviewDesc", { name })
                                  : t("modelConfig.envVarRealDesc", { name })
                              : t("modelConfig.envVarDefaultDesc")}
                        </span>
                      </div>
                    );
                  })() : null}
                  {editor.authType === "command" ? (
                    <div className="field">
                      <label htmlFor="f-cmd">{t("modelConfig.commandAuthLabel")}</label>
                      <input className="input mono" id="f-cmd" value={editor.command} placeholder="!op read op://dev/openai/api-key" onChange={(event) => setEditor({ ...editor, command: event.target.value })} />
                      <span className="desc">{t("modelConfig.commandAuthDesc")}</span>
                    </div>
                  ) : null}
                  {editor.authType === "none" ? (
                    <div className="auth-status" style={{ marginBottom: 0 }}>
                      <Icon name="check" extra="sm" />
                      <span>{t("modelConfig.noneAuthDesc")}</span>
                    </div>
                  ) : null}
                </div>

                <div className="mp-sec-divider" aria-hidden="true" />

                <h3>Endpoint</h3>
                <div className="field">
                  <label htmlFor="f-url">Base URL</label>
                  <input className="input mono" id="f-url" value={editor.endpointUrl} onChange={(event) => setEditor({ ...editor, endpointUrl: event.target.value })} />
                </div>

                <div className="mp-sec-divider" aria-hidden="true" />

                <h3>{t("modelConfig.apiTypeSection")}</h3>
                <AppSelect className="select" style={{ maxWidth: 320 }} value={editor.api} onChange={(event) => setEditor({ ...editor, api: event.target.value })}>
                  {MODEL_API_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </AppSelect>
              </div>

              <div className="mp-sec">
                <h3>{t("modelConfig.modelsSection")}</h3>
                <p className="sec-desc">{t("modelConfig.modelsSectionDesc", { prefix: editor.id || "provider-id" })}</p>
                <div className="mc-models-bar">
                  <div className="seg" role="tablist" aria-label={t("modelConfig.modelsSourceAria")}>
                    <button type="button" role="tab" aria-selected={modelsTab === "catalog"} className={modelsTab === "catalog" ? "active" : undefined} onClick={() => setModelsTab("catalog")}>OMP Catalog</button>
                    {editor.discoveryType ? (
                      <button type="button" role="tab" aria-selected={modelsTab === "discovery"} className={modelsTab === "discovery" ? "active" : undefined} onClick={() => setModelsTab("discovery")}>Runtime Discovery</button>
                    ) : null}
                    <button type="button" role="tab" aria-selected={modelsTab === "custom"} className={modelsTab === "custom" ? "active" : undefined} onClick={() => setModelsTab("custom")}>Custom Models</button>
                  </div>
                  {(() => {
                    const missing = !editor.id.trim() ? t("modelConfig.fillProviderIdFirst") : !editor.endpointUrl.trim() ? t("modelConfig.fillBaseUrlFirst") : "";
                    return (
                      <button
                        type="button"
                        className="btn small outline mc-fetch-btn"
                        disabled={busy || fetching || missing !== ""}
                        data-tip={missing || t("modelConfig.readProviderModelsTip")}
                        onClick={() => void onFetchModels(editor)}
                      >
                        {fetching ? <><span className="spinner" />{t("modelConfig.fetchingModels")}</> : <><Icon name="refresh" extra="sm" />{t("modelConfig.autoFetchModels")}</>}
                      </button>
                    );
                  })()}
                </div>

                {fetchDetail && !candidates ? (
                  <div className={`test-result ${fetchDetail.ok ? "ok" : "fail"}`} role="status">
                    <Icon name={fetchDetail.ok ? "check" : "alert"} extra="sm" />
                    <div className="tr-lines"><b>{fetchDetail.ok ? t("modelConfig.fetchSuccess") : t("modelConfig.fetchFailed")}</b><span className="mono">{fetchDetail.text}</span></div>
                  </div>
                ) : null}

                {candidates ? (
                  <div className="mc-fetch-panel">
                    <div className={`test-result ${fetchDetail?.ok === false ? "fail" : "ok"}`} role="status" style={{ marginTop: 0 }}>
                      <Icon name={fetchDetail?.ok === false ? "alert" : "check"} extra="sm" />
                      <div className="tr-lines">
                        <b>{fetchDetail?.ok === false ? t("modelConfig.fetchFailed") : t("modelConfig.selectModelsToAdd")}</b>
                        <span className="mono">{fetchDetail?.text ?? ""}</span>
                      </div>
                    </div>
                    {candidates.length > 0 ? (
                      <div className="mc-fetch-select" role="toolbar" aria-label={t("modelConfig.selectModelsToAdd")}>
                        <span className="sec-desc">{t("modelConfig.importModelsCount", { count: pickedCount(candidates) })}</span>
                        <button
                          type="button"
                          className="icon-btn small"
                          aria-label={t("modelConfig.selectAll")}
                          data-tip={t("modelConfig.selectAll")}
                          disabled={pickedCount(candidates) === candidates.length}
                          onClick={() => setCandidates(setAllPicked(candidates, true))}
                        >
                          <Icon name="check" extra="sm" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn small"
                          aria-label={t("modelConfig.deselectAll")}
                          data-tip={t("modelConfig.deselectAll")}
                          disabled={pickedCount(candidates) === 0}
                          onClick={() => setCandidates(setAllPicked(candidates, false))}
                        >
                          <Icon name="x" extra="sm" />
                        </button>
                      </div>
                    ) : null}
                    {candidates.length === 0 ? (
                      <div className="pm-empty"><Icon name="box" extra="sm" />{t("modelConfig.endpointNoModels")}</div>
                    ) : candidates.map((item) => (
                      <div className={`pm-row mc-fetch-row${item.existing ? " is-off" : ""}`} key={item.id}>
                        <input type="checkbox" aria-label={item.name} checked={item.picked} onChange={() => setCandidates(togglePicked(candidates, item.id))} />
                        <span className="pm-name">{item.name}</span>
                        <span className="pm-sel ellipsis">{`${editor.id || "provider"}/${item.id}`}</span>
                        <span className="pm-meta">
                          {item.contextWindow ? <span className="chip gray xs">{fmtK(item.contextWindow)} ctx</span> : null}
                          {item.maxTokens ? <span className="chip gray xs">{fmtK(item.maxTokens)} out</span> : null}
                          {item.image ? <span className="chip blue xs chip-icon" data-tip={t("modelConfig.badgeImage")}><Icon name="image" extra="sm" /></span> : null}
                          {item.reasoning ? <span className="chip purple xs chip-icon" data-tip={t("modelConfig.badgeReasoning")}><Icon name="brain" extra="sm" /></span> : null}
                          {[...new Set(Object.values(item.parameterSources ?? {}).map(origin => origin.source))].map(source => <span key={source} className="chip gray xs">{t(`modelAdaptation.source.${source}`)}</span>)}
                          {item.adaptation?.status === "ambiguous" ? <span className="chip gray xs">{t("modelAdaptation.ambiguousBadge")}</span> : null}
                          {item.existing ? <span className="chip gray xs">{t("modelConfig.alreadyExists")}</span> : null}
                        </span>
                        {item.adaptation?.status === "ambiguous" ? <AppSelect aria-label={`${t("modelAdaptation.chooseModel")} · ${item.id}`} className="select" value="" onChange={event => {
                          const selected = item.adaptation?.candidates.find(candidate => candidate.key === event.target.value);
                          if (selected) setCandidates(current => current?.map(candidate => candidate.id === item.id ? chooseFetchedModelCandidate(candidate, selected) : candidate) ?? null);
                        }}><option value="">{t("modelAdaptation.chooseModel")}</option>{item.adaptation.candidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.provider} / {candidate.id}</option>)}</AppSelect> : null}
                      </div>
                    ))}
                    <div className="mc-fetch-foot">
                      <span className="spacer" />
                      <button type="button" className="btn small outline" onClick={() => { setCandidates(null); setFetchDetail(null); }}>{t("common.close")}</button>
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={pickedCount(candidates) === 0}
                        onClick={() => importCandidates(editor, candidates.filter((item) => item.picked))}
                      >
                        <Icon name="plus" extra="sm" />{t("modelConfig.importModelsCount", { count: pickedCount(candidates) })}
                      </button>
                    </div>
                    <p className="sec-desc" style={{ marginTop: 8 }}>{t("modelConfig.importDraftNotice", { action: editExisting ? t("modelConfig.saveChanges") : t("modelConfig.addProvider") })}</p>
                  </div>
                ) : null}

                {modelsTab === "catalog" ? (() => {
                  const catalog = editor.models.filter((m) => m.source === "catalog" || m.source === "extension");
                  if (catalog.length === 0) {
                    return <div className="pm-empty"><Icon name="box" extra="sm" />{t("modelConfig.noCatalogModels")}</div>;
                  }
                  return catalog.map((model) => {
                    const sel = model.selector || `${editor.id}/${model.id}`;
                    return (
                      <div className={`mdl-edit${model.status !== "available" ? " is-off" : ""}`} key={sel}>
                        <div className="me-head">
                          <span className="mono">{model.id}</span>
                          <span className="muted small">{model.name}</span>
                          <span className="spacer" />
                          <button type="button" className="icon-btn small" data-tip={t("common.edit")} onClick={() => setModelEdit({ kind: "override", modelId: model.id, draft: blankOverrideForm(editor.modelOverrides[model.id]) })}><Icon name="pencil" extra="sm" /></button>
                          <RoleAssignControl
                            selector={sel}
                            open={assignPopSel === sel}
                            roles={roles}
                            modCount={roleAssignModCount(roleAssignDraft[sel], roles, sel)}
                            showSave={false}
                            {...(roleAssignDraft[sel] ? { initialPicked: roleAssignDraft[sel] } : {})}
                            onToggle={(next) => setAssignPopSel(next)}
                            onDraftChange={onRoleAssignDraft}
                            onError={toast}
                          />
                        </div>
                        <ModelCaps model={model} />
                      </div>
                    );
                  });
                })() : null}

                {modelsTab === "discovery" ? (
                  <div className="kv-list">
                    <div className="kv-row"><span className="k">Discovery Type</span><span className="v"><span className="chip-code">{editor.discoveryType}</span></span></div>
                    <div className="kv-row"><span className="k">采用服务端 reasoning 配置</span><span className="v"><input type="checkbox" checked={editor.advertisedReasoning !== false} onChange={event => setEditor({ ...editor, advertisedReasoning: event.target.checked })} /><span className="tiny muted">读取 /v1/models 的 ladder、none 和 reasoning:false；关闭则沿用目录推断。</span></span></div>
                    <div className="kv-row"><span className="k">Timeout（ms）</span><span className="v">
                      <input className="input mono" type="number" style={{ width: 120 }} value={editor.discoveryTimeoutMs ?? ""} onChange={(event) => {
                        const next = { ...editor };
                        if (event.target.value === "") delete next.discoveryTimeoutMs;
                        else next.discoveryTimeoutMs = Number(event.target.value);
                        setEditor(next);
                      }} />
                    </span></div>
                    <div className="kv-row">
                      <span className="k">{t("modelConfig.probeScan")}</span>
                      <span className="v" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" className="btn small outline" disabled={busy || probing} onClick={() => void onProbe(editor.id, editor.endpointUrl || undefined, editorTestSecret(editor), editor.discoveryType || undefined, editor.discoveryTimeoutMs)}>
                          {probing ? t("modelConfig.probing") : t("modelConfig.probe")}
                        </button>
                        <button type="button" className="btn small outline" disabled={busy} onClick={() => void refreshDiscovery()}>{t("modelConfig.rescan")}</button>
                      </span>
                    </div>
                    {probeResult ? <DiscoveryResultBlock result={probeResult} /> : null}
                    <p className="sec-desc" style={{ marginTop: 8 }}>{t("modelConfig.probeNotice")}</p>
                  </div>
                ) : null}

                {modelsTab === "custom" ? (
                  <>
                    {editor.models.filter((m) => m.source === "custom").map((model) => {
                      const index = editor.models.indexOf(model);
                      const sel = model.selector || `${editor.id}/${model.id}`;
                      return (
                        <div className="mdl-edit" key={`${model.id}-${index}`}>
                          <div className="me-head">
                            <span className="mono">{model.id || t("modelConfig.newModel")}</span>
                            <span className="muted small">{model.name}</span>
                            <span className="spacer" />
                            <button type="button" className="icon-btn small" data-tip={t("common.edit")} onClick={() => setModelEdit({ kind: "custom", index, draft: blankCustomForm(model) })}><Icon name="pencil" extra="sm" /></button>
                            <RoleAssignControl
                              selector={sel}
                              open={assignPopSel === sel}
                              roles={roles}
                              disabled={!model.id}
                              modCount={roleAssignModCount(roleAssignDraft[sel], roles, sel)}
                              showSave={false}
                              {...(roleAssignDraft[sel] ? { initialPicked: roleAssignDraft[sel] } : {})}
                              onToggle={(next) => setAssignPopSel(next)}
                              onDraftChange={onRoleAssignDraft}
                              onError={toast}
                            />
                            <button type="button" className="icon-btn small" data-tip={t("common.delete")} onClick={() => {
                              const models = editor.models.filter((_, i) => i !== index);
                              setEditor({ ...editor, models });
                            }}><Icon name="trash" extra="sm" /></button>
                          </div>
                          <ModelCaps model={model} />
                        </div>
                      );
                    })}
                    <button type="button" className="btn outline" onClick={() => setModelEdit({ kind: "add", draft: blankCustomForm() })}><Icon name="plus" extra="sm" />{t("modelConfig.addModel")}</button>
                  </>
                ) : null}
              </div>

              <details className="mp-advanced">
                <summary><span className="tw"><Icon name="chevron-r" extra="sm" /></span>{t("modelConfig.advancedSettingsSummary")} <span className="hint">Custom Headers · Strict Tools · Transport · Remote Compaction</span></summary>
                <div className="adv-body">
                  <div className="f-grid">
                    <div className="field span2">
                      <label>{t("modelConfig.customHeadersLabel")}</label>
                      <textarea className="input mono" rows={3} value={editor.headersText} placeholder={"X-Org-Id: org-123\nX-Api-Version: 2"} onChange={(event) => setEditor({ ...editor, headersText: event.target.value })} />
                    </div>
                    <div className="kv-row" style={{ border: "none", padding: "4px 0" }}>
                      <span className="k">Disable Strict Tools</span>
                      <span className="v">
                        <button type="button" className={`switch${editor.disableStrictTools ? " on" : ""}`} role="switch" aria-checked={editor.disableStrictTools} onClick={() => setEditor({ ...editor, disableStrictTools: !editor.disableStrictTools })} />
                        <span className="desc">{t("modelConfig.disableStrictToolsDesc")}</span>
                      </span>
                    </div>
                    <div className="field">
                      <label>Transport</label>
                      <AppSelect className="select" value={editor.transport} onChange={(event) => setEditor({ ...editor, transport: event.target.value as "" | "pi-native" })}>
                        <option value="">{t("modelConfig.httpSseDefault")}</option>
                        <option value="pi-native">pi-native</option>
                      </AppSelect>
                    </div>
                    <div className="kv-row span2" style={{ border: "none", padding: "4px 0" }}>
                      <span className="k">Remote Compaction</span>
                      <span className="v">
                        <button type="button" className={`switch${editor.remoteCompactionEnabled ? " on" : ""}`} role="switch" aria-checked={editor.remoteCompactionEnabled} onClick={() => setEditor({ ...editor, remoteCompactionEnabled: !editor.remoteCompactionEnabled })} />
                        <span className="desc">{t("modelConfig.remoteCompactionDesc")}</span>
                      </span>
                    </div>
                    {editor.remoteCompactionEnabled ? (
                      <>
                        <div className="field"><label>Compaction Endpoint</label><input className="input mono" value={editor.remoteCompactionEndpoint} onChange={(event) => setEditor({ ...editor, remoteCompactionEndpoint: event.target.value })} /></div>
                        <div className="field"><label>Compaction Model</label><input className="input mono" value={editor.remoteCompactionModel} onChange={(event) => setEditor({ ...editor, remoteCompactionModel: event.target.value })} /></div>
                      </>
                    ) : null}
                  </div>
                </div>
              </details>

              <StructuredEditor
                language="yaml"
                value={modelsYmlValue}
                onChange={setModelsYmlDraft}
                allowEmpty={false}
                readOnly={providerCardLocked}
                disabled={providerCardLocked}
                title={providerYamlId || t("modelConfig.providerYamlTitle")}
                path={providerYamlId ? `models.yml · providers.${providerYamlId}` : "models.yml"}
                minHeight={320}
                maxHeight={420}
                dirty={modelsYmlEdited}
                saving={busy}
                saveDisabled={!providerYamlId || (!modelsYmlDirty && !providerFormDirty) || providerCardLocked}
                saveHint={!providerYamlId ? t("modelConfig.fillProviderIdSaveHint") : ""}
                onSave={(text) => void persistModelsYml(text, providerFormDirty, false)}
              />

              <div className="mp-foot">
                <button type="button" className="btn outline" onClick={closeProviderEditor}>{t("common.cancel")}</button>
                {editExisting && !preview ? (
                  confirmDelete ? (
                    <span className="confirm-delete" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="desc">{t("modelConfig.deleteProviderNotice")}</span>
                      <button type="button" className="btn danger" disabled={busy} onClick={() => void deleteProvider(editor.id)}>{t("modelConfig.confirmDelete")}</button>
                      <button type="button" className="btn outline" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</button>
                    </span>
                  ) : (
                    <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Icon name="trash" extra="sm" />{t("common.delete")}</button>
                  )
                ) : null}
                <span className="right">
                  {testResult && testResult.source === "editor" ? (
                    <span className={`test-result inline ${testResult.ok ? "ok" : "fail"}`} role="status">
                      <Icon name={testResult.ok ? "check" : "alert"} extra="sm" />
                      <div className="tr-lines">
                        <b>{testResult.ok ? t("modelConfig.connectionSuccess") : t("modelConfig.connectionFailed")}</b>
                        <span className="mono">{testResult.detail} · {testResult.latencyMs}ms</span>
                      </div>
                    </span>
                  ) : null}
                  <button type="button" className="btn outline" disabled={busy || testing} onClick={() => void onTest("editor", editExisting ? editor.id : undefined, editor.api, editor.endpointUrl, editorTestSecret(editor))}>{testing ? t("modelConfig.testingConnection") : t("modelConfig.testConnection")}</button>
                  <button type="submit" className="btn primary" disabled={busy}><Icon name="check" extra="sm" />{editExisting ? t("modelConfig.saveChanges") : t("modelConfig.addProvider")}</button>
                </span>
              </div>
            </form>

            </>
          ) : (
            <>
              <div className="mr-toolbar">
                <input className="input" placeholder={t("modelConfig.searchProviderPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
                <span className="mr-count">{t("modelConfig.providerCounts", { total: providers.length, available: availCount })}</span>
                <span className="seg src-filter" role="tablist" aria-label={t("modelConfig.sourceFilterAria")}>
                  <button type="button" className={sourceFilter === "all" ? "active" : undefined} onClick={() => setSourceFilter("all")}>{t("common.all")}</button>
                  <button type="button" className={sourceFilter === "native" ? "active" : undefined} onClick={() => setSourceFilter("native")}>{t("modelConfig.nativeFilter")}</button>
                  <button type="button" className={sourceFilter === "third" ? "active" : undefined} onClick={() => setSourceFilter("third")}>{t("modelConfig.customFilter")}</button>
                </span>
                <span className="spacer" />
                <button type="button" className="btn outline" disabled={preview} data-tip={preview ? (marks ? t("common.demo") : t("common.unavailable")) : undefined} onClick={() => void refresh()}><Icon name="refresh" extra="sm" />{t("modelConfig.refreshStatus")}</button>
                <button type="button" className="btn primary" onClick={() => { setModelEdit(null); setEditor(blankDraft()); setEditExisting(false); setPresetOpen(false); setPresetSel(null); setConfirmDelete(false); setTestResult(null); }}><Icon name="plus" extra="sm" />{t("modelConfig.addProvider")}</button>
              </div>
              {!data && !loadError ? (
                <div className="pv-list is-pending" role="status">
                  <Icon name="refresh" extra="sm" />
                  <span>{t("modelConfig.readingLocalConfig")}</span>
                </div>
              ) : (
              <>
              {filtered.length === 0 ? <div className="empty"><Icon name="search" />{providers.length === 0 ? t("modelConfig.noProviders") : t("modelConfig.noMatchingProviders")}</div> : null}
              <div className={`pv-list${draggingId && dragPhase === "dragging" ? " is-sorting" : ""}`} ref={listRef}>
              {filtered.map((provider) => {
                const open = expanded.has(provider.id);
                const st = STATUS_META[provider.status] ?? STATUS_META.available;
                const cardCls = !provider.enabled || provider.status === "disabled" ? "is-disabled"
                  : ["config-error", "connection-failed", "offline"].includes(provider.status) ? "is-error"
                    : ["not-authenticated", "auth-expired"].includes(provider.status) ? "is-warn" : "";
                const dragging = draggingId === provider.id;
                const dragClass = dragging ? (dragPhase === "settling" ? " is-settling" : " is-dragging") : "";
                return (
                  <div className={`pv-card ${cardCls}${dragClass}`} data-id={provider.id} key={provider.id}>
                    <div className="pv-head">
                      <button
                        type="button"
                        className="pv-drag"
                        aria-label={t("modelConfig.dragAdjustOrder", { name: provider.name })}
                        data-tip={t("modelConfig.drag")}
                        onPointerDown={(event) => onProviderDragPointerDown(event, provider.id)}
                      />
                      <BrandMark id={provider.id} local={provider.local} status={provider.status} />
                      <div className="pv-title">
                        <div className="pv-name">
                          <span>{provider.name}</span>
                          <span className="chip-code">{provider.id}</span>
                          <span className={`chip ${SOURCE_GROUP(provider.source) === "native" ? "blue" : "gray"} xs`}>{SOURCE_GROUP(provider.source) === "native" ? t("modelConfig.nativeProviderBadge") : t("modelConfig.customProviderBadge")}</span>
                          <span className="pv-count"><span className={`pv-dot dot ${st?.dot || "gray"}`} />{t("modelConfig.modelCount", { count: provider.models.length })}</span>
                        </div>
                        <div className="pv-sub"><span className="pv-url ellipsis">{provider.endpointUrl || formatProviderStatusDetail(provider.statusDetail, t, marks, resolvedLanguage === "zh")}</span></div>
                      </div>
                      <div className="pv-acts">
                        <button type="button" className={`pv-act is-action${testing ? " is-testing" : ""}`} disabled={busy || testing} data-tip={t("common.test")} aria-label={t("modelConfig.testConnection")} onClick={() => void onTest("list", provider.id)}><Icon name="pulse" /></button>
                        <button type="button" className="pv-act is-action" disabled={busy} data-tip={t("common.refresh")} aria-label={t("modelConfig.refreshModels")} onClick={() => void refreshDiscovery()}><Icon name="refresh" /></button>
                        <button type="button" className="pv-act is-action is-edit" data-tip={t("common.edit")} aria-label={t("modelConfig.editProvider")} onClick={() => { setModelEdit(null); setEditor(draftFromProvider(provider)); setEditExisting(true); setConfirmDelete(false); setTestResult(null); }}><Icon name="pencil" /></button>
                        <button type="button" className="pv-act is-action is-copy" data-tip={t("common.copy")} aria-label={t("modelConfig.copyProviderId")} onClick={() => { void navigator.clipboard.writeText(provider.id); toast(`${t("common.copied")} ${provider.id}`); }}><Icon name="copy" /></button>
                        <span className="pv-act is-switch">
                          <button
                            type="button"
                            className={`switch${provider.enabled ? " on" : ""}`}
                            role="switch"
                            aria-checked={provider.enabled}
                            aria-label={provider.enabled ? t("modelConfig.disableProvider", { name: provider.name }) : t("modelConfig.enableProvider", { name: provider.name })}
                            disabled={busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              void toggleEnabled(provider);
                            }}
                          />
                        </span>
                        <button type="button" className="pv-act is-expand" aria-expanded={open} onClick={() => setExpanded((set) => {
                          const next = new Set(set);
                          if (next.has(provider.id)) next.delete(provider.id); else next.add(provider.id);
                          return next;
                        })}>
                          <span className={`pv-expand-chev${open ? " open" : ""}`}><Icon name="chevron-r" /></span>
                        </button>
                      </div>
                    </div>
                    {testResult && testResult.source === "list" && testResult.providerId === provider.id ? (
                      <ProviderTestRow result={testResult} />
                    ) : null}
                    <div className={`pv-models-shell${open ? " open" : ""}`} aria-hidden={!open}>
                      <div className="pv-models">
                        {provider.models.length === 0 ? <div className="pm-empty"><Icon name="box" extra="sm" />{t("modelConfig.noModels")}</div> : provider.models.map((model, index) => (
                          <div className={`pm-row${model.status !== "available" ? " is-off" : ""}`} key={model.selector} style={{ "--pm-i": index } as CSSProperties}>
                            <span className="pm-name"><span className={`dot ${model.status === "available" ? "green" : "amber"}`} />{model.name}</span>
                            <span className="pm-sel ellipsis">{model.selector}</span>
                            <span className="pm-meta">
                              <span className="chip gray xs">{fmtK(model.contextWindow)} ctx</span>
                              {model.image ? <span className="chip blue xs chip-icon" data-tip={t("modelConfig.badgeImage")}><Icon name="image" extra="sm" /></span> : null}
                              {model.reasoning ? <span className="chip purple xs chip-icon" data-tip={t("modelConfig.badgeReasoning")}><Icon name="brain" extra="sm" /></span> : null}
                              {model.tools ? <span className="chip gray xs chip-icon" data-tip={t("modelConfig.badgeTools")}><Icon name="wrench" extra="sm" /></span> : null}
                            </span>
                            <button type="button" className="icon-btn small" data-tip={t("common.copy")} onClick={() => { void navigator.clipboard.writeText(model.selector); toast(t("modelConfig.copiedSelector", { selector: model.selector })); }}><Icon name="copy" extra="sm" /></button>
                            {(model.source === "catalog" || model.source === "extension") ? (
                              <button type="button" className="icon-btn small" data-tip={t("common.edit")} onClick={() => {
                                setModelEdit({ kind: "override", modelId: model.id, draft: blankOverrideForm(provider.modelOverrides?.[model.id]), providerId: provider.id });
                              }}><Icon name="pencil" extra="sm" /></button>
                            ) : model.source === "custom" ? (
                              <button type="button" className="icon-btn small" data-tip={t("common.edit")} onClick={() => {
                                const index = provider.models.findIndex((item) => item.id === model.id && item.source === "custom");
                                if (index >= 0) setModelEdit({ kind: "custom", index, draft: blankCustomForm(model), providerId: provider.id });
                              }}><Icon name="pencil" extra="sm" /></button>
                            ) : null}
                            <RoleAssignControl
                              selector={model.selector}
                              open={assignPopSel === model.selector}
                              roles={roles}
                              modCount={assignModCounts[model.selector] ?? 0}
                              showSave={true}
                              onToggle={(next) => setAssignPopSel(next)}
                              onCommit={commitRoleAssign}
                              onError={toast}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
              </>
              )}
              <div className="mp-sec" style={{ marginTop: 20 }}>
                <h3>{t("modelConfig.providerOrderTitle")} <span className="chip-code">modelProviderOrder</span></h3>
                <p className="sec-desc">{t("modelConfig.providerOrderSubtitle")}</p>
                {orderEdit ? (
                  <>
                    <div className="cycle-pool">
                      {orderDraft.map((id, index) => (
                        <span key={id} className="cycle-chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <span className="mono">{id}</span>
                          <button type="button" className="icon-btn small" disabled={index === 0} aria-label={t("modelConfig.moveUp")} onClick={() => setOrderDraft((current) => {
                            if (index === 0) return current;
                            const next = current.slice();
                            const prev = next[index - 1]!;
                            next[index - 1] = next[index]!;
                            next[index] = prev;
                            return next;
                          })}><Icon name="arrow-l" extra="sm" /></button>
                          <button type="button" className="icon-btn small" disabled={index === orderDraft.length - 1} aria-label={t("modelConfig.moveDown")} onClick={() => setOrderDraft((current) => {
                            if (index >= current.length - 1) return current;
                            const next = current.slice();
                            const after = next[index + 1]!;
                            next[index + 1] = next[index]!;
                            next[index] = after;
                            return next;
                          })}><Icon name="arrow-r" extra="sm" /></button>
                          <span className="chip-remove" role="button" tabIndex={0} onClick={() => setOrderDraft((current) => current.filter((item) => item !== id))}><Icon name="x" /></span>
                        </span>
                      ))}
                    </div>
                    <div className="cycle-pool">
                      <span className="cycle-pool-label">{t("modelConfig.availableToAdd")}</span>
                      {providers.filter((provider) => !orderDraft.includes(provider.id)).map((provider) => (
                        <button type="button" key={provider.id} className="btn small outline" onClick={() => setOrderDraft((current) => [...current, provider.id])}>{provider.name}</button>
                      ))}
                    </div>
                    <div className="cycle-edit-actions">
                      <button type="button" className="btn small primary" disabled={busy} onClick={() => void saveProviderOrder()}><Icon name="check" extra="sm" />{t("modelConfig.saveOrder")}</button>
                      <button type="button" className="btn small outline" onClick={() => setOrderEdit(false)}>{t("common.cancel")}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="cycle-flow">
                      {(data?.modelProviderOrder ?? []).length === 0 ? <span className="muted small">{t("modelConfig.notConfigured")}</span> : (data?.modelProviderOrder ?? []).map((id, index) => (
                        <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          {index ? <span className="cycle-arrow"><Icon name="arrow-r" extra="sm" /></span> : null}
                          <span className="cycle-chip"><span className="mono">{id}</span></span>
                        </span>
                      ))}
                    </div>
                    <div style={{ marginTop: 12 }}><button type="button" className="btn small outline" onClick={() => { setOrderEdit(true); setOrderDraft([...(data?.modelProviderOrder ?? [])]); }}><Icon name="pencil" extra="sm" />{t("modelConfig.editOrder")}</button></div>
                  </>
                )}
              </div>
            </>
          )}
            {modelEditView && modelEditHost ? createPortal(
              <ModelParametersDialog modelEditLeaving={modelEditLeaving} setModelEdit={setModelEdit} modelEditView={modelEditView} t={t} client={client} preview={preview} modelEditHost={modelEditHost} data={data} editor={editor} persistProviderDraft={persistProviderDraft} setEditor={setEditor} toast={toast} setModelsTab={setModelsTab} />
            , document.body) : null}
          </div>
        </section>

        <section id="mcPanelRoles" role="tabpanel" aria-labelledby="mcTabRoles" hidden={shownTab !== "roles"} {...tabPanelMotion("roles")}>
          <VisionModelStatus client={client} preview={preview} />
          <div className={roleLive ? `mc-view ${pagePhaseClass(rolePhase)}` : "mc-view"} data-page-dir={pageDir(roleDir)}>
          {roleDraft ? (
            <>
              <div className="mr-toolbar">
                <button type="button" className="icon-btn" onClick={closeRoleEditor}><Icon name="arrow-l" /></button>
                <b style={{ fontSize: "var(--fs-14)" }}>{roleDraft.name}</b>
                <span className="chip-code">{roleDraft.alias}</span>
                <span className={`chip ${roleDraft.builtin ? "gray" : "purple"} xs`}>{roleDraft.builtin ? t("modelConfig.builtinRole") : t("modelConfig.customRole")}</span>
                <span className="chip blue xs">{roleDraft.scope === "project" ? "Project" : "Global"}</span>
                {!roleDraft.builtin ? (
                  <button type="button" className="btn small danger" disabled={busy} onClick={() => void deleteCustomRole(roleDraft.id)}>{t("common.delete")}</button>
                ) : null}
              </div>
              {roleDraft.issue ? (
                <div className={`role-issue-banner${roleDraft.issue.kind === "model-missing" || roleDraft.issue.kind === "provider-down" ? " err" : ""}`}>
                  <Icon name="alert" extra="sm" />
                  <div><div className="rib-title">{roleDraft.issue.detail}</div></div>
                </div>
              ) : null}
              {!roleDraft.builtin ? (
                <div className="mp-sec">
                  <h3>{t("modelConfig.identity")}</h3>
                  <p className="sec-desc">{t("modelConfig.identityDesc", { id: roleDraft.id || "id" })}</p>
                  <div className="f-grid">
                    <div className="field">
                      <label htmlFor="role-id">id</label>
                      <input
                        className="input mono"
                        id="role-id"
                        value={roleDraft.id}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          setRoleDraft({ ...roleDraft, id: nextId, alias: `@${nextId.trim()}` });
                        }}
                      />
                      <span className="desc">{t("modelConfig.roleIdHint")}</span>
                    </div>
                    <div className="field">
                      <label htmlFor="role-name">{t("modelConfig.roleName")}</label>
                      <input className="input" id="role-name" value={roleDraft.name} onChange={(event) => setRoleDraft({ ...roleDraft, name: event.target.value })} />
                    </div>
                    <div className="field span2">
                      <label htmlFor="role-desc">{t("modelConfig.roleDesc")}</label>
                      <textarea className="input" id="role-desc" rows={2} value={roleDraft.desc} onChange={(event) => setRoleDraft({ ...roleDraft, desc: event.target.value })} />
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="mp-sec">
                <h3>{t("modelConfig.modelRouting")}</h3>
                <p className="sec-desc">{t("modelConfig.modelRoutingDesc", { scope: data?.modelRoleStorage === "project" ? t("modelConfig.projectScope") : t("modelConfig.globalScope") })}</p>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="k">Primary Model</span>
                    <span className="v">
                      <RoleModelPicker
                        value={roleDraft.primary}
                        groups={groupModelsByProvider(usable.filter(model => modelAcceptsRole(roleDraft.id, model)), orderedProviders)}
                        onChange={(primary) => setRoleDraft(withRoleModel(roleDraft, primary, availableBySelector.get(primary)))}
                      />
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="k">Thinking Level</span>
                    <span className="v">
                      <RoleThinkingSeg role={roleDraft} model={availableBySelector.get(roleDraft.primary)} onChange={setRoleDraft} />
                    </span>
                  </div>
                </div>
              </div>
              <div className="mp-sec">
                <h3>{t("modelConfig.fallbackChains")}</h3>
                <p className="sec-desc">{t("modelConfig.fallbackChainsDesc")}</p>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="k">Recovery</span>
                    <span className="v">
                      <AppSelect
                        className="select"
                        value={revertPolicyDraft ?? data?.fallbackRevertPolicy ?? "cooldown-expiry"}
                        onChange={(event) => setRevertPolicyDraft(event.target.value as ModelFallbackRevertPolicy)}
                      >
                        <option value="cooldown-expiry">cooldown-expiry</option>
                        <option value="never">never</option>
                      </AppSelect>
                    </span>
                  </div>
                </div>
                <div className="cycle-pool" style={{ marginTop: 8 }}>
                  {(fallbackDraft ?? data?.fallbackChains[roleDraft.id] ?? data?.fallbackChains[roleDraft.primary] ?? []).map((selector, index, chain) => (
                    <span key={selector} className="cycle-chip">
                      <span className="mono">{selector}</span>
                      <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveUp")} disabled={index === 0} onClick={() => { const next = [...chain]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setFallbackDraft(next); }}><Icon name="chevron-u" extra="sm" /></button>
                      <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveDown")} disabled={index === chain.length - 1} onClick={() => { const next = [...chain]; [next[index + 1], next[index]] = [next[index]!, next[index + 1]!]; setFallbackDraft(next); }}><Icon name="chevron-d" extra="sm" /></button>
                      <span className="chip-remove" role="button" tabIndex={0} onClick={() => {
                        const current = fallbackDraft ?? data?.fallbackChains[roleDraft.id] ?? data?.fallbackChains[roleDraft.primary] ?? [];
                        setFallbackDraft(current.filter((item) => item !== selector));
                      }}><Icon name="x" /></span>
                    </span>
                  ))}
                </div>
                <div className="cycle-pool">
                  <span className="cycle-pool-label">{t("modelConfig.addToFallback")}</span>
                  <RoleModelPicker ariaLabel={t("modelConfig.addToFallback")} value="" groups={groupModelsByProvider(usable.filter(model => modelAcceptsRole(roleDraft.id, model) && model.selector !== roleDraft.primary && !(fallbackDraft ?? data?.fallbackChains[roleDraft.id] ?? data?.fallbackChains[roleDraft.primary] ?? []).includes(model.selector)), orderedProviders)} onChange={selector => { if (selector) setFallbackDraft([...(fallbackDraft ?? data?.fallbackChains[roleDraft.id] ?? data?.fallbackChains[roleDraft.primary] ?? []), selector]); }} />

                </div>
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn small outline" disabled={busy || !roleDraft.primary} onClick={() => void saveFallback(roleDraft.id, roleDraft.primary)}>{t("modelConfig.saveFallback")}</button>
                </div>
              </div>
              <StructuredEditor
                language="yaml"
                value={configYmlValue}
                onChange={setConfigYmlDraft}
                allowEmpty={false}
                readOnly={roleCardLocked}
                disabled={roleCardLocked}
                title={roleDraft.id}
                path={`config.yml · modelRoles.${roleDraft.id}`}
                minHeight={280}
                maxHeight={400}
                dirty={configYmlEdited}
                saving={busy}
                saveDisabled={(!configYmlDirty && !roleFormDirty) || roleCardLocked}
                onSave={(text) => void persistConfigYml(text, roleFormDirty, false)}
              />
              <div className="mp-foot">
                <button type="button" className="btn outline" onClick={closeRoleEditor}>{t("common.back")}</button>
                <span className="right"><button type="button" className="btn primary" disabled={busy} onClick={() => {
                  void (async () => {
                    if (configYmlDirty) {
                      const ok = await persistConfigYml(configYmlValue, true, !roleFormDirty);
                      if (!ok || !roleFormDirty) return;
                    }
                    await saveRole(roleDraft);
                  })();
                }}><Icon name="check" extra="sm" />{t("modelConfig.saveToStorage", { storage: data?.modelRoleStorage === "project" ? "Project" : "Global" })}</button></span>
              </div>
            </>
          ) : (
            <>
              <div className="mr-toolbar">
                <span className="seg" role="tablist" aria-label={t("modelConfig.roleScope")}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={(data?.modelRoleStorage ?? "global") === "global"}
                    className={(data?.modelRoleStorage ?? "global") === "global" ? "active" : undefined}
                    disabled={busy}
                    onClick={() => { if ((data?.modelRoleStorage ?? "global") !== "global") void setRoleStorage("global"); }}
                  >{t("modelConfig.globalScope")}</button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={(data?.modelRoleStorage ?? "global") === "project"}
                    className={(data?.modelRoleStorage ?? "global") === "project" ? "active" : undefined}
                    disabled={busy || !data?.projectScopeAvailable}
                    data-tip={data?.projectScopeAvailable ? undefined : t("modelConfig.noWorkspaceTip")}
                    onClick={() => { if (data?.projectScopeAvailable && (data?.modelRoleStorage ?? "global") !== "project") void setRoleStorage("project"); }}
                  >{t("modelConfig.projectScope")}</button>
                </span>
                <b style={{ fontSize: "var(--fs-13)" }}>{t("modelConfig.rolesTab")}</b>
                <span className="mr-count">{roles.length}</span>
                <span className="spacer" />
                <button type="button" className="btn primary" onClick={() => setCreateRoleOpen(true)}><Icon name="plus" extra="sm" />{t("modelConfig.createCustomRole")}</button>
              </div>
              {createRoleOpen ? (
                <div className="preset-banner" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input className="input mono" placeholder={t("modelConfig.roleIdPlaceholder")} value={newRole.id} onChange={(event) => setNewRole({ ...newRole, id: event.target.value })} style={{ width: 140 }} />
                  <input className="input" placeholder={t("modelConfig.roleNamePlaceholder")} value={newRole.name} onChange={(event) => setNewRole({ ...newRole, name: event.target.value })} style={{ width: 140 }} />
                  <input className="input" placeholder={t("modelConfig.roleDescPlaceholder")} value={newRole.desc} onChange={(event) => setNewRole({ ...newRole, desc: event.target.value })} style={{ flex: 1, minWidth: 160 }} />
                  <button type="button" className="btn small primary" disabled={busy} onClick={() => void createCustomRole()}>{t("common.create")}</button>
                  <button type="button" className="btn small outline" onClick={() => setCreateRoleOpen(false)}>{t("common.cancel")}</button>
                </div>
              ) : null}
              {roles.map((role) => {
                const thinking = roleThinkingUi(role, availableBySelector.get(role.primary));
                return (
                <div className={`role-row${role.issue ? " has-issue" : ""}`} data-tint={ROLE_TINTS[role.id] ?? "purple"} key={role.id}>
                  <button type="button" className="role-row-nav" onClick={() => { setRoleId(role.id); setRoleDraft({ ...role }); }}>
                    <span className="role-icon-area"><span className={`a-ic${role.issue ? " amber" : ""}`}><Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" /></span></span>
                    <span className="role-name-section">
                      <div className="role-header"><span className="r-name">{role.name}<span className="alias">{role.alias}</span></span>{role.scope === "project" ? <span className="chip blue xs">Project</span> : null}{role.builtin ? null : <span className="chip purple xs">{t("modelConfig.customRole")}</span>}</div>
                      <span className="r-desc">{formatRoleDesc(role, t)}</span>
                    </span>
                  </button>
                  <span className="role-model-section">
                    {role.issue ? <span className="role-model"><span className="model-name unavailable">{role.primary || t("modelConfig.unassigned")}</span></span> : (
                      <>
                        <RoleModelPicker
                          value={role.primary}
                          groups={groupModelsByProvider(usable.filter(model => modelAcceptsRole(role.id, model)), orderedProviders)}
                          onChange={(primary) => { void saveRole(withRoleModel(role, primary, availableBySelector.get(primary))); }}
                        />
                        <AppSelect className="effort-select" value={thinking.value} disabled={thinking.disabled} aria-label={t("modelConfig.thinkingEffort")} onChange={(event) => {
                          const { thinkingAdjustment: _mapping, ...next } = role as ModelRoleDraft;
                          if (event.target.value === "") delete next.thinking;
                          else next.thinking = event.target.value;
                          void saveRole(next);
                        }}>
                          <option value="">{t("modelAdaptation.defaultThinking")}</option>
                          {thinking.items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </AppSelect>
                      </>
                    )}
                    {!role.builtin ? (
                      <button
                        type="button"
                        className="role-delete"
                        aria-label={t("modelConfig.deleteRoleAria", { name: role.name })}
                        disabled={busy}
                        onClick={(event) => { event.stopPropagation(); void deleteCustomRole(role.id); }}
                      >
                        <Icon name="trash" extra="sm" />
                      </button>
                    ) : null}
                  </span>
                  <button type="button" className="role-chevron" aria-label={t("modelConfig.editRoleAria", { name: role.name })} onClick={() => { setRoleId(role.id); setRoleDraft({ ...role }); }}>
                    <Icon name="chevron-r" extra="sm" />
                  </button>
                </div>
                );
              })}
              <div className="mp-sec" style={{ marginTop: 20 }}>
                <h3>{t("modelConfig.cycleOrderTitle")} <span className="chip-code">Cycle Order</span></h3>
                <p className="sec-desc">{t("modelConfig.cycleOrderDesc")}</p>
                {cycleEdit ? (
                  <>
                    <div className="cycle-flow">
                      {cycleDraft.map((id, index) => {
                        const role = roles.find((item) => item.id === id);
                        if (!role) return null;
                        return (
                          <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {index ? <span className="cycle-arrow"><Icon name="arrow-r" extra="sm" /></span> : null}
                            <span className="cycle-chip"><Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" />{role.name} <span className="mono">{role.alias}</span>
                              <span className="chip-remove" role="button" tabIndex={0} onClick={() => setCycleDraft((current) => current.filter((x) => x !== id))}><Icon name="x" /></span>
                            </span>
                          </span>
                        );
                      })}
                    </div>
                    <div className="cycle-pool">
                      <span className="cycle-pool-label">{t("modelConfig.cyclePoolLabel")}</span>
                      {roles.filter((role) => !cycleDraft.includes(role.id)).map((role) => (
                        <button type="button" key={role.id} className="btn small outline" onClick={() => setCycleDraft((current) => [...current, role.id])}><Icon name="plus" extra="sm" />{role.name} <span className="mono">{role.alias}</span></button>
                      ))}
                    </div>
                    <div className="cycle-edit-actions">
                      <button type="button" className="btn small primary" disabled={busy} onClick={() => void saveCycle()}><Icon name="check" extra="sm" />{t("modelConfig.saveCycleOrder")}</button>
                      <button type="button" className="btn small outline" onClick={() => setCycleEdit(false)}>{t("common.cancel")}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="cycle-flow">
                      {(data?.cycleOrder ?? []).map((id, index) => {
                        const role = roles.find((item) => item.id === id);
                        if (!role) return null;
                        return (
                          <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {index ? <span className="cycle-arrow"><Icon name="arrow-r" extra="sm" /></span> : null}
                            <span className="cycle-chip"><Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" />{role.name} <span className="mono">{role.alias}</span></span>
                          </span>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 12 }}><button type="button" className="btn small outline" onClick={() => { setCycleEdit(true); setCycleDraft([...(data?.cycleOrder ?? [])]); }}><Icon name="pencil" extra="sm" />{t("modelConfig.editCycleOrder")}</button></div>
                  </>
                )}
              </div>
              {assignSel ? (
                <div className="preset-banner">
                  <Icon name="user" extra="sm" />
                  <span>{t("modelConfig.selectRoleForModel", { model: assignSel })}</span>
                  <span className="spacer" />
                  {roles.map((role) => (
                    <button type="button" key={role.id} className="btn small outline" onClick={() => { void saveRole({ ...role, primary: assignSel }); setAssignSel(null); }}>{role.alias}</button>
                  ))}
                  <button type="button" className="icon-btn small" onClick={() => setAssignSel(null)}><Icon name="x" extra="sm" /></button>
                </div>
              ) : null}
            </>
          )}
          </div>
        {shownTab === "roles" && !hasRoleEditor ? <ModelCompactionPane client={client} context={{ sessionId, available: runtimeAvailable, capabilities }} visible={shownTab === "roles"} models={data?.availableModels ?? []} /> : null}
</section>
        <section id="mcPanelSubagents" role="tabpanel" aria-labelledby="mcTabSubagents" hidden={shownTab !== "subagents"} {...tabPanelMotion("subagents")}>
          <SubagentsPanel
            client={client}
            preview={preview}
            models={data}
            onCount={setAgentCount}
            context={{ sessionId, available: runtimeAvailable, capabilities }}
            visible={shownTab === "subagents"}
            onAccountDirtyChange={setAccountPoolsDirty}
            onManageAccounts={() => setTab("accounts")}
            {...(agentIntent === undefined ? {} : { initialAgent: agentIntent })}
          />
</section>
        <section id="mcPanelWebSearch" role="tabpanel" aria-labelledby="mcTabWebSearch" hidden={shownTab !== "websearch"} {...tabPanelMotion("websearch")}>
          {data?.webSearch ? (
            <WebSearchPanel
              models={usable}
              sessionId={sessionId}
              visible={shownTab === "websearch"}
              onReadyCount={setWebSearchReadyCount}
              client={client}
              preview={preview}
              webSearch={data.webSearch}
              loginAvailable={data.loginAvailable}
              onSaved={() => void refresh()}
              onPreviewSave={(next) => mutateLocal((current) => ({ ...current, webSearch: next }))}
            />
          ) : (
            <div className="wsx-empty wsx-empty-page">{t("modelConfig.loadErrorTitle")}</div>
          )}
        </section>
      </div>
    </div>
  );
}
