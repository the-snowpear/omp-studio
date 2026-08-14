import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  CommandName,
  ConfigWriteResult,
  ModelAuthType,
  ModelCatalogEntry,
  ModelConfigReadModel,
  ModelPresetItem,
  ModelProviderRecord,
  ModelProviderTestResult,
  ModelProviderUpsertInput,
  ModelRoleRecord,
  StudioClient,
} from "@omp-studio/client-contract";
import { Brand, hasBrand } from "./brands";
import { Icon } from "./icons";
import { pagePhaseClass, useDeferredKey } from "./pageTransition";
import { usePreviewMode } from "./preview/PreviewContext";
import {
  MODEL_API_TYPES,
  MODEL_AUTH_TYPES,
  MODEL_THINKING,
  createPreviewModelConfig,
} from "./preview/modelConfigFixtures";

export const MC_INTENT_KEY = "omp.modelConfigIntent";

export type McTab = "providers" | "roles";

type McIntent = { tab?: McTab; edit?: string; role?: string; assign?: string };

const STATUS_META: Record<string, { label: string; chip: string; dot: string }> = {
  available: { label: "Available", chip: "green", dot: "green" },
  "not-authenticated": { label: "Not Authenticated", chip: "amber", dot: "amber" },
  disabled: { label: "Disabled", chip: "gray", dot: "" },
  offline: { label: "Offline", chip: "red", dot: "red" },
  "auth-expired": { label: "Authentication Expired", chip: "amber", dot: "amber" },
  "config-error": { label: "Configuration Error", chip: "red", dot: "red" },
  "connection-failed": { label: "Connection Failed", chip: "red", dot: "red" },
};

// 原生 = OMP 内置/运行时解析；第三方 = 用户自定义/扩展。
const SOURCE_GROUP = (source: string): "native" | "third" =>
  source === "builtin" || source === "runtime" ? "native" : "third";

const ROLE_ICONS: Record<string, string> = {
  default: "cpu", smol: "zap", slow: "brain", vision: "eye", plan: "layers",
  designer: "sparkles", commit: "commit", tiny: "box", task: "bot", advisor: "user",
};

export function setModelConfigIntent(intent: McIntent): void {
  try {
    sessionStorage.setItem(MC_INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* ignore */
  }
}

function takeIntent(): McIntent | null {
  try {
    const raw = sessionStorage.getItem(MC_INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MC_INTENT_KEY);
    return JSON.parse(raw) as McIntent;
  } catch {
    return null;
  }
}

function BrandMark({ id, local, status }: { id: string; local?: boolean; status?: string }) {
  if (hasBrand(id)) {
    return <span className="pv-brand"><Brand id={id} extra="lg" /></span>;
  }
  const tone = status === "available" ? "green" : status === "disabled" ? "purple" : "amber";
  return <span className={`pv-fallback a-ic ${tone}`} aria-hidden="true"><Icon name={local ? "monitor" : "server"} extra="lg" /></span>;
}

function fmtK(n?: number): string {
  if (!n) return "—";
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

type Draft = {
  id: string;
  name: string;
  website: string;
  note: string;
  api: string;
  endpointUrl: string;
  local: boolean;
  enabled: boolean;
  authType: ModelAuthType;
  apiKey: string;
  envName: string;
  command: string;
  clearSecret: boolean;
  discoveryType: string;
  discoveryTimeoutMs?: number;
  headersText: string;
  disableStrictTools: boolean;
  transport: "" | "pi-native";
  remoteCompactionEnabled: boolean;
  remoteCompactionEndpoint: string;
  remoteCompactionModel: string;
  models: ModelCatalogEntry[];
};

function blankDraft(): Draft {
  return {
    id: "", name: "", website: "", note: "", api: "openai-completions", endpointUrl: "",
    local: false, enabled: true, authType: "api-key", apiKey: "", envName: "", command: "",
    clearSecret: false, discoveryType: "", headersText: "", disableStrictTools: false,
    transport: "", remoteCompactionEnabled: false, remoteCompactionEndpoint: "", remoteCompactionModel: "",
    models: [],
  };
}

function draftFromProvider(provider: ModelProviderRecord): Draft {
  return {
    id: provider.id,
    name: provider.name,
    website: provider.website ?? "",
    note: provider.note ?? "",
    api: provider.api,
    endpointUrl: provider.endpointUrl ?? "",
    local: provider.local,
    enabled: provider.enabled,
    authType: provider.auth.type,
    apiKey: "",
    envName: "",
    command: "",
    clearSecret: false,
    discoveryType: provider.discovery?.type ?? "",
    ...(provider.discovery?.timeoutMs === undefined ? {} : { discoveryTimeoutMs: provider.discovery.timeoutMs }),
    headersText: Object.entries(provider.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n"),
    disableStrictTools: provider.disableStrictTools ?? false,
    transport: provider.transport ?? "",
    remoteCompactionEnabled: provider.remoteCompaction?.enabled ?? false,
    remoteCompactionEndpoint: provider.remoteCompaction?.endpoint ?? "",
    remoteCompactionModel: provider.remoteCompaction?.model ?? "",
    models: provider.models.map((model) => ({ ...model })),
  };
}

function draftFromPreset(preset: ModelPresetItem): Draft {
  return {
    ...blankDraft(),
    id: preset.id,
    name: preset.name,
    api: preset.api,
    endpointUrl: preset.endpoint ?? "",
    local: Boolean(preset.local),
    authType: preset.auth[0] ?? "api-key",
    envName: `${preset.id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    discoveryType: preset.discovery ?? "",
  };
}

async function waitReceipt<T>(client: StudioClient, requestId: string): Promise<T> {
  return await new Promise((resolve, reject) => {
    const unsub = client.subscribe({ scope: "command", requestId: requestId as never }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      unsub();
      if (event.receipt.status === "completed") resolve(event.receipt.result as T);
      else if (event.receipt.status === "failed") reject(event.receipt.error);
      else reject({ code: "INTERNAL_ERROR", message: event.receipt.status });
    });
  });
}

async function runWrite<T extends Extract<CommandName, `models.${string}`>>(
  client: StudioClient,
  name: T,
  input: Parameters<StudioClient["command"]>[1] extends never ? never : unknown,
): Promise<ConfigWriteResult> {
  const handle = await client.command(name, input as never);
  return waitReceipt<ConfigWriteResult>(client, handle.requestId);
}

async function runTest(
  client: StudioClient,
  input: { readonly providerId?: string; readonly api?: string; readonly endpointUrl?: string; readonly apiKey?: string },
): Promise<ModelProviderTestResult> {
  const handle = await client.command("models.provider.test", input as never);
  return waitReceipt<ModelProviderTestResult>(client, handle.requestId);
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function ModelConfigPage({ client }: { client: StudioClient }) {
  const { preview } = usePreviewMode();
  const [tab, setTab] = useState<McTab>("providers");
  const { shown: shownTab, phase: tabPhase } = useDeferredKey(tab);
  const [data, setData] = useState<ModelConfigReadModel | null>(preview ? createPreviewModelConfig() : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "native" | "third">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<Draft | null>(null);
  const [editExisting, setEditExisting] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetQuery, setPresetQuery] = useState("");
  const [presetSel, setPresetSel] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<ModelRoleRecord | null>(null);
  const [assignSel, setAssignSel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ModelProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cycleEdit, setCycleEdit] = useState(false);
  const [cycleDraft, setCycleDraft] = useState<string[]>([]);
  const loaded = useRef(false);
  const mcTabsRef = useRef<HTMLDivElement>(null);
  const tabWinRef = useRef<HTMLSpanElement>(null);
  const tabMirrorRef = useRef<HTMLSpanElement>(null);

  const refresh = useCallback(async () => {
    if (preview) {
      setData(createPreviewModelConfig());
      setLoadError(null);
      return;
    }
    try {
      const next = await client.query("models.get", {});
      setData(next);
      setLoadError(next.unavailableReason ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "models.get failed";
      setLoadError(message);
      setData(null);
    }
  }, [client, preview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const intent = takeIntent();
    if (!intent) return;
    if (intent.tab === "roles" || intent.role || intent.assign) setTab("roles");
    if (intent.edit) {
      setTab("providers");
    }
    if (intent.assign) setAssignSel(intent.assign);
    if (intent.role) setRoleId(intent.role);
  }, []);

  useEffect(() => {
    if (!data || !roleId || roleDraft) return;
    const role = data.roles.find((item) => item.id === roleId);
    if (role) setRoleDraft({ ...role });
  }, [data, roleId, roleDraft]);

  const providers = data?.providers ?? [];
  const roles = data?.roles ?? [];
  const presets = data?.presets ?? [];
  const filtered = providers.filter((item) => {
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
    const matchesSource = sourceFilter === "all" || SOURCE_GROUP(item.source) === sourceFilter;
    return matchesQuery && matchesSource;
  });
  const availCount = providers.filter((item) => item.enabled && item.status === "available").length;
  const roleIssues = roles.filter((role) => role.issue).length;

  // 把滑动选中气泡对准当前激活的 tab 按钮：窗口盖在其上，镜像反向位移保持
  // 克隆与基础层对齐（与 SecondaryPage 的 page-nav 同一套算法）。
  useLayoutEffect(() => {
    const tabs = mcTabsRef.current;
    const win = tabWinRef.current;
    const mirror = tabMirrorRef.current;
    if (!tabs || !win || !mirror) return;
    const active = tabs.querySelector<HTMLElement>(`#mcTab${tab === "providers" ? "Providers" : "Roles"}`);
    if (!active) return;
    win.style.left = `${active.offsetLeft}px`;
    win.style.width = `${active.offsetWidth}px`;
    mirror.style.left = `${-active.offsetLeft}px`;
  }, [tab, providers.length, roles.length]);

  const activate = (next: McTab, focus = false) => {
    setTab(next);
    if (focus) document.getElementById(next === "providers" ? "mcTabProviders" : "mcTabRoles")?.focus();
  };

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys: McTab[] = ["providers", "roles"];
    const index = keys.indexOf(tab);
    let next: McTab | null = null;
    if (event.key === "ArrowRight") next = keys[(index + 1) % keys.length] ?? "providers";
    else if (event.key === "ArrowLeft") next = keys[(index - 1 + keys.length) % keys.length] ?? "providers";
    else if (event.key === "Home") next = "providers";
    else if (event.key === "End") next = "roles";
    if (!next) return;
    event.preventDefault();
    activate(next, true);
  };

  const toast = (text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 3200);
  };

  const mutateLocal = (recipe: (current: ModelConfigReadModel) => ModelConfigReadModel) => {
    setData((current) => recipe(current ?? createPreviewModelConfig()));
  };

  const saveProvider = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!editor) return;
    if (!editor.id.trim() || !editor.name.trim()) {
      toast("名称和 Provider ID 不能为空");
      return;
    }
    if (preview) {
      const record: ModelProviderRecord = {
        id: editor.id.trim(),
        name: editor.name.trim(),
        source: "custom",
        status: editor.enabled ? "available" : "disabled",
        statusDetail: "演示 · 未写入 Host",
        api: editor.api,
        ...(editor.endpointUrl ? { endpointUrl: editor.endpointUrl } : {}),
        local: editor.local,
        enabled: editor.enabled,
        ...(editor.website ? { website: editor.website } : {}),
        ...(editor.note ? { note: editor.note } : {}),
        auth: { type: editor.authType, hasSecret: Boolean(editor.apiKey || editor.command) },
        ...(editor.discoveryType ? { discovery: { type: editor.discoveryType } } : {}),
        ...(Object.keys(parseHeaders(editor.headersText)).length > 0 ? { headers: parseHeaders(editor.headersText) } : {}),
        ...(editor.disableStrictTools ? { disableStrictTools: true } : {}),
        ...(editor.transport ? { transport: editor.transport } : {}),
        ...(editor.remoteCompactionEnabled || editor.remoteCompactionEndpoint || editor.remoteCompactionModel
          ? {
              remoteCompaction: {
                ...(editor.remoteCompactionEnabled ? { enabled: true } : {}),
                ...(editor.remoteCompactionEndpoint ? { endpoint: editor.remoteCompactionEndpoint } : {}),
                ...(editor.remoteCompactionModel ? { model: editor.remoteCompactionModel } : {}),
              },
            }
          : {}),
        models: editor.models,
      };
      mutateLocal((current) => ({
        ...current,
        providers: [...current.providers.filter((item) => item.id !== record.id), record],
      }));
      setEditor(null);
      toast("演示：已更新本地列表，未写入 models.yml");
      return;
    }
    setBusy(true);
    try {
      const input: ModelProviderUpsertInput = {
        id: editor.id.trim(),
        name: editor.name.trim(),
        api: editor.api,
        ...(editor.endpointUrl ? { endpointUrl: editor.endpointUrl } : {}),
        ...(editor.website ? { website: editor.website } : {}),
        ...(editor.note ? { note: editor.note } : {}),
        local: editor.local,
        enabled: editor.enabled,
        auth: {
          type: editor.authType,
          ...(editor.apiKey ? { apiKey: editor.apiKey } : {}),
          ...(editor.envName ? { envName: editor.envName } : {}),
          ...(editor.command ? { command: editor.command } : {}),
          ...(editor.clearSecret ? { clearSecret: true } : {}),
        },
        discovery: editor.discoveryType
          ? { type: editor.discoveryType, ...(editor.discoveryTimeoutMs === undefined ? {} : { timeoutMs: editor.discoveryTimeoutMs }) }
          : null,
        headers: parseHeaders(editor.headersText),
        disableStrictTools: editor.disableStrictTools,
        transport: editor.transport || null,
        remoteCompaction: editor.remoteCompactionEnabled || editor.remoteCompactionEndpoint || editor.remoteCompactionModel
          ? {
              ...(editor.remoteCompactionEnabled ? { enabled: true } : {}),
              ...(editor.remoteCompactionEndpoint ? { endpoint: editor.remoteCompactionEndpoint } : {}),
              ...(editor.remoteCompactionModel ? { model: editor.remoteCompactionModel } : {}),
            }
          : null,
        models: editor.models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          reasoning: model.reasoning,
          image: model.image,
        })),
        ...(data?.contentHash ? { expectedHash: data.contentHash } : {}),
      };
      const result = await runWrite(client, "models.provider.upsert", input);
      toast(result.message ?? "已保存");
      setEditor(null);
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async (id: string) => {
    if (preview) {
      mutateLocal((current) => ({ ...current, providers: current.providers.filter((item) => item.id !== id) }));
      toast("演示：已从本地列表移除");
      return;
    }
    setBusy(true);
    try {
      await runWrite(client, "models.provider.delete", { id, ...(data?.contentHash ? { expectedHash: data.contentHash } : {}) });
      toast("已从 models.yml 删除");
      setEditor(null);
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (provider: ModelProviderRecord) => {
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        providers: current.providers.map((item) => item.id === provider.id ? { ...item, enabled: !item.enabled, status: item.enabled ? "disabled" : "available" } : item),
      }));
      return;
    }
    setBusy(true);
    try {
      await runWrite(client, "models.provider.upsert", {
        id: provider.id,
        name: provider.name,
        api: provider.api,
        ...(provider.endpointUrl ? { endpointUrl: provider.endpointUrl } : {}),
        enabled: !provider.enabled,
        auth: { type: provider.auth.type },
        ...(data?.contentHash ? { expectedHash: data.contentHash } : {}),
      });
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "更新失败");
    } finally {
      setBusy(false);
    }
  };

  const saveRole = async (role: ModelRoleRecord) => {
    const selector = role.thinking && role.thinking !== "off" ? `${role.primary}:${role.thinking}` : role.primary;
    if (!role.primary) {
      toast("请先选择主模型");
      return;
    }
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        roles: current.roles.map((item) => {
          if (item.id !== role.id) return item;
          const { issue: _ignored, ...rest } = role;
          return rest;
        }),
      }));
      toast("演示：已更新本地角色，未写入 config.yml");
      setRoleId(null);
      setRoleDraft(null);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roles.set", { roleId: role.id, selector });
      toast(result.message ?? "已保存到全局 config.yml");
      setRoleId(null);
      setRoleDraft(null);
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const startLogin = async (providerId: string) => {
    if (preview || !data?.loginAvailable) {
      toast(`请在终端运行 omp login ${providerId}`);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.login.start", { providerId });
      toast(result.message ?? "登录完成");
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : `登录失败，请运行 omp login ${providerId}`);
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (providerId?: string, api?: string, endpointUrl?: string, apiKey?: string) => {
    if (preview) {
      toast("演示：测试连接不写 Host");
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
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, latencyMs: 0, detail: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setTesting(false);
    }
  };

  const saveCycle = async () => {
    if (preview) {
      mutateLocal((current) => ({ ...current, cycleOrder: cycleDraft.slice() }));
      toast("演示：已更新本地顺序");
      setCycleEdit(false);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.cycleOrder.set", { order: cycleDraft.slice() });
      toast(result.message ?? "已保存顺序");
      setCycleEdit(false);
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const usable = useMemo(() => {
    const models = data?.availableModels ?? [];
    return models.filter((model) =>
      providers.some((provider) => provider.id === model.provider && provider.enabled && provider.status !== "disabled"),
    );
  }, [data, providers]);

  return (
    <div className="page-wide" id="mcRoot">
      <a className="skip-link" href="#mcPanels">跳到内容</a>
      <div className="mc-tabbar">
        <div className="mc-tabs" id="mcTabs" ref={mcTabsRef} role="tablist" aria-label="模型配置视图" onKeyDown={onTabKey}>
          <button role="tab" id="mcTabProviders" aria-controls="mcPanelProviders" aria-selected={tab === "providers"} tabIndex={tab === "providers" ? 0 : -1} className={tab === "providers" ? "active" : undefined} onClick={() => activate("providers")}>
            <Icon name="server" extra="sm" /><span>供应商</span>
            <span className={`chip ${availCount === 0 && providers.length > 0 ? "amber" : "gray"} xs`}>{providers.length}<span className="sr-only"> 个供应商</span></span>
          </button>
          <button role="tab" id="mcTabRoles" aria-controls="mcPanelRoles" aria-selected={tab === "roles"} tabIndex={tab === "roles" ? 0 : -1} className={tab === "roles" ? "active" : undefined} onClick={() => activate("roles")}>
            <Icon name="steering" extra="sm" /><span>角色</span>
            <span className={`chip ${roleIssues ? "red" : "gray"} xs`}>{roles.length}<span className="sr-only"> 个角色</span></span>
          </button>
          <span className="mc-tab-window" ref={tabWinRef} aria-hidden="true">
            <span className="mc-tab-mirror" ref={tabMirrorRef}>
              <button type="button" tabIndex={-1}><Icon name="server" extra="sm" /><span>供应商</span><span className={`chip ${availCount === 0 && providers.length > 0 ? "amber" : "gray"} xs`}>{providers.length}<span className="sr-only"> 个供应商</span></span></button>
              <button type="button" tabIndex={-1}><Icon name="steering" extra="sm" /><span>角色</span><span className={`chip ${roleIssues ? "red" : "gray"} xs`}>{roles.length}<span className="sr-only"> 个角色</span></span></button>
            </span>
          </span>
        </div>
      </div>

      {flash ? <div className="preset-banner" role="status"><Icon name="info" extra="sm" /><span>{flash}</span></div> : null}
      {testResult ? (
        <div className={`test-result ${testResult.ok ? "ok" : "fail"}`} role="status">
          <Icon name={testResult.ok ? "check" : "alert"} extra="sm" />
          <div className="tr-lines">
            <b>{testResult.ok ? "连接成功" : "连接失败"}</b>
            <span className="mono">{testResult.detail} · {testResult.latencyMs}ms</span>
          </div>
        </div>
      ) : null}
      {preview ? (
        <div className="role-issue-banner">
          <Icon name="info" extra="sm" />
          <div>
            <div className="rib-title">当前是演示数据，不是本机 ~/.omp 配置</div>
            <div className="rib-text">关掉顶栏右上角「预览」后再进本页，才会直接读取 ~/.omp/agent/models.yml 和 config.yml。</div>
          </div>
        </div>
      ) : null}
      {!preview && !data && !loadError ? <div className="preset-banner" role="status"><Icon name="refresh" extra="sm" /><span>正在读取本机 OMP 配置…</span></div> : null}
      {!preview && loadError ? <div className="role-issue-banner"><Icon name="alert" extra="sm" /><div><div className="rib-title">读取说明</div><div className="rib-text">{loadError}</div></div></div> : null}

      <div id="mcPanels" tabIndex={-1}>
        <section id="mcPanelProviders" role="tabpanel" aria-labelledby="mcTabProviders" hidden={shownTab !== "providers"} className={shownTab === "providers" ? pagePhaseClass(tabPhase) : undefined}>
          {editor ? (
            <form className="mp-editor" onSubmit={(event) => void saveProvider(event)}>
              <div className="mr-toolbar">
                <button type="button" className="icon-btn" onClick={() => setEditor(null)} data-tip="返回供应商列表"><Icon name="arrow-l" /></button>
                {hasBrand(editor.id) ? <Brand id={editor.id} extra="lg" /> : null}
                <b style={{ fontSize: "var(--fs-14)" }}>{editExisting ? `编辑 · ${editor.name}` : "新建供应商"}</b>
                {presetSel ? <span className="chip blue xs">预设模板：{presetSel}</span> : <span className="chip purple xs">自定义供应商</span>}
              </div>

              {!editExisting ? (
                <div className={`preset-entry${presetOpen ? " open" : ""}`}>
                  <button type="button" className="preset-toggle" aria-expanded={presetOpen} onClick={() => setPresetOpen((value) => !value)}>
                    <span className="tw"><Icon name="chevron-r" /></span>
                    <Icon name="layers" extra="sm" />
                    <b>从预设模板创建</b>
                    <span className="hint">选择后自动预填写配置</span>
                    <span className="spacer" />
                    <span className="chip gray xs">{presets.reduce((n, group) => n + group.items.length, 0)} 个预设</span>
                  </button>
                  {presetOpen ? (
                    <div className="preset-body">
                      <input className="input preset-search" placeholder="搜索预设 Provider…" value={presetQuery} onChange={(event) => setPresetQuery(event.target.value)} />
                      {presets.map((group) => {
                        const items = group.items.filter((item) => !presetQuery || item.name.toLowerCase().includes(presetQuery.toLowerCase()) || item.id.includes(presetQuery.toLowerCase()));
                        if (!items.length) return null;
                        return (
                          <div key={group.group}>
                            <div className="preset-group-label">{group.group} · {items.length}</div>
                            <div className="preset-grid">
                              {items.map((item) => (
                                <button type="button" key={item.id} className={`preset-item${presetSel === item.id ? " sel" : ""}`} onClick={() => { setEditor(draftFromPreset(item)); setPresetSel(item.id); }}>
                                  <span className="pi-name">{hasBrand(item.id) ? <Brand id={item.id} extra="sm" /> : null}{item.name}{item.popular ? <span className="chip purple xs">常用</span> : null}{item.local ? <span className="chip blue xs">本地</span> : null}</span>
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
                <h3>基础信息</h3>
                <div className="f-grid">
                  <div className="field"><label htmlFor="f-name">供应商名称</label><input className="input" id="f-name" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></div>
                  <div className="field">
                    <label htmlFor="f-id">Provider ID</label>
                    <input className="input mono" id="f-id" value={editor.id} readOnly={editExisting} onChange={(event) => setEditor({ ...editor, id: event.target.value })} />
                    <span className="desc">Model Selector 形如 <span className="chip-code">{editor.id || "provider-id"}/model-id</span></span>
                  </div>
                  <div className="field"><label htmlFor="f-site">官网链接</label><input className="input mono" id="f-site" value={editor.website} onChange={(event) => setEditor({ ...editor, website: event.target.value })} /></div>
                  <div className="field"><label htmlFor="f-note">备注</label><input className="input" id="f-note" value={editor.note} onChange={(event) => setEditor({ ...editor, note: event.target.value })} /></div>
                </div>

                <div className="mp-sec-divider" aria-hidden="true" />

                <h3>认证</h3>
                <select className="select" style={{ maxWidth: 280 }} value={editor.authType} onChange={(event) => setEditor({ ...editor, authType: event.target.value as ModelAuthType })}>
                  {MODEL_AUTH_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <div className="auth-box">
                  {editor.authType === "oauth" ? (
                    <div className="auth-status">
                      <Icon name="key" extra="sm" />
                      <span>OAuth 走 OMP login。{data?.loginAvailable ? "可尝试应用内登录。" : "本轮若未接上浏览器回调，请用终端 `omp login`。"}</span>
                      <button type="button" className="btn small primary" disabled={busy || preview || !data?.loginAvailable} title={data?.loginAvailable ? undefined : `请运行 omp login ${editor.id || "<provider>"}`} onClick={() => void startLogin(editor.id)}>登录</button>
                    </div>
                  ) : null}
                  {editor.authType === "api-key" ? (
                    <div className="field">
                      <label htmlFor="f-key">API Key</label>
                      <input className="input mono" id="f-key" type="password" value={editor.apiKey} placeholder="留空则保留已保存密钥" onChange={(event) => setEditor({ ...editor, apiKey: event.target.value, clearSecret: false })} />
                      <label className="desc" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                        <input type="checkbox" checked={editor.clearSecret} onChange={(event) => setEditor({ ...editor, clearSecret: event.target.checked })} />
                        清除已保存密钥
                      </label>
                    </div>
                  ) : null}
                  {editor.authType === "env" ? (
                    <div className="field">
                      <label htmlFor="f-env">Environment Variable Name</label>
                      <input className="input mono" id="f-env" value={editor.envName} onChange={(event) => setEditor({ ...editor, envName: event.target.value })} />
                      <span className="desc">OMP 启动时从环境读取，不把密钥写入 models.yml</span>
                    </div>
                  ) : null}
                  {editor.authType === "command" ? (
                    <div className="field">
                      <label htmlFor="f-cmd">获取 Secret 的命令</label>
                      <input className="input mono" id="f-cmd" value={editor.command} placeholder="!op read op://dev/openai/api-key" onChange={(event) => setEditor({ ...editor, command: event.target.value })} />
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

                <h3>API 类型</h3>
                <select className="select" style={{ maxWidth: 320 }} value={editor.api} onChange={(event) => setEditor({ ...editor, api: event.target.value })}>
                  {MODEL_API_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </div>

              <div className="mp-sec">
                <h3>自定义模型</h3>
                <p className="sec-desc">为这个 Provider 声明模型行。角色与工作台按 <span className="chip-code">{editor.id || "provider-id"}/model-id</span> 引用。</p>
                {editor.models.map((model, index) => (
                  <div className="mdl-edit" key={`${model.id}-${index}`}>
                    <div className="me-head">
                      <span className="mono">{model.id || "新模型"}</span>
                      <span className="spacer" />
                      <button type="button" className="icon-btn small" onClick={() => setEditor({ ...editor, models: editor.models.filter((_, i) => i !== index) })}><Icon name="trash" extra="sm" /></button>
                    </div>
                    <div className="f-grid">
                      <div className="field">
                        <label>Model ID</label>
                        <input className="input mono" value={model.id} onChange={(event) => {
                          const models = editor.models.slice();
                          models[index] = { ...model, id: event.target.value, selector: `${editor.id}/${event.target.value}` };
                          setEditor({ ...editor, models });
                        }} />
                      </div>
                      <div className="field">
                        <label>显示名称</label>
                        <input className="input" value={model.name} onChange={(event) => {
                          const models = editor.models.slice();
                          models[index] = { ...model, name: event.target.value };
                          setEditor({ ...editor, models });
                        }} />
                      </div>
                      <div className="field">
                        <label>Context Window</label>
                        <input className="input mono" type="number" value={model.contextWindow ?? ""} onChange={(event) => {
                          const models = editor.models.slice();
                          const next = { ...model };
                          if (event.target.value === "") delete next.contextWindow;
                          else next.contextWindow = Number(event.target.value);
                          models[index] = next;
                          setEditor({ ...editor, models });
                        }} />
                      </div>
                      <div className="field">
                        <label>Max Output Tokens</label>
                        <input className="input mono" type="number" value={model.maxTokens ?? ""} onChange={(event) => {
                          const models = editor.models.slice();
                          const next = { ...model };
                          if (event.target.value === "") delete next.maxTokens;
                          else next.maxTokens = Number(event.target.value);
                          models[index] = next;
                          setEditor({ ...editor, models });
                        }} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 16, marginTop: 10, alignItems: "center" }}>
                      <label className="desc" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={model.reasoning} onChange={(event) => {
                          const models = editor.models.slice();
                          models[index] = { ...model, reasoning: event.target.checked };
                          setEditor({ ...editor, models });
                        }} /> Reasoning
                      </label>
                      <label className="desc" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={model.image} onChange={(event) => {
                          const models = editor.models.slice();
                          models[index] = { ...model, image: event.target.checked };
                          setEditor({ ...editor, models });
                        }} /> Image Input
                      </label>
                    </div>
                  </div>
                ))}
                <button type="button" className="btn small outline" onClick={() => setEditor({
                  ...editor,
                  models: [...editor.models, { id: "", name: "", selector: "", image: false, reasoning: false, tools: true, status: "available", source: "custom" }],
                })}><Icon name="plus" extra="sm" />添加模型</button>
              </div>

              <details className="mp-advanced">
                <summary><span className="tw"><Icon name="chevron-r" extra="sm" /></span>高级设置 <span className="hint">Custom Headers · Strict Tools · Transport · Remote Compaction</span></summary>
                <div className="adv-body">
                  <div className="f-grid">
                    <div className="field span2">
                      <label>Custom Headers（每行一个 Header: Value）</label>
                      <textarea className="input mono" rows={3} value={editor.headersText} placeholder={"X-Org-Id: org-123\nX-Api-Version: 2"} onChange={(event) => setEditor({ ...editor, headersText: event.target.value })} />
                    </div>
                    <div className="kv-row" style={{ border: "none", padding: "4px 0" }}>
                      <span className="k">Disable Strict Tools</span>
                      <span className="v">
                        <button type="button" className={`switch${editor.disableStrictTools ? " on" : ""}`} role="switch" aria-checked={editor.disableStrictTools} onClick={() => setEditor({ ...editor, disableStrictTools: !editor.disableStrictTools })} />
                        <span className="desc">放宽工具调用 Schema 校验</span>
                      </span>
                    </div>
                    <div className="field">
                      <label>Transport</label>
                      <select className="select" value={editor.transport} onChange={(event) => setEditor({ ...editor, transport: event.target.value as "" | "pi-native" })}>
                        <option value="">HTTP / SSE（默认）</option>
                        <option value="pi-native">pi-native</option>
                      </select>
                    </div>
                    <div className="kv-row span2" style={{ border: "none", padding: "4px 0" }}>
                      <span className="k">Remote Compaction</span>
                      <span className="v">
                        <button type="button" className={`switch${editor.remoteCompactionEnabled ? " on" : ""}`} role="switch" aria-checked={editor.remoteCompactionEnabled} onClick={() => setEditor({ ...editor, remoteCompactionEnabled: !editor.remoteCompactionEnabled })} />
                        <span className="desc">由 Provider 端执行上下文压缩</span>
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

              <div className="mp-sec">
                <h3>models.yml 预览</h3>
                <pre className="yml-preview">{preview ? "# 演示模式不会写入\n" : (data?.generatedModelsYml || "providers: {}\n")}</pre>
              </div>

              <div className="mp-foot">
                <button type="button" className="btn outline" onClick={() => setEditor(null)}>取消</button>
                {editExisting && !preview ? (
                  confirmDelete ? (
                    <span className="confirm-delete" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="desc">删除会移除 models.yml 中的该供应商，引用其模型的角色会变为不可用。</span>
                      <button type="button" className="btn danger" disabled={busy} onClick={() => void deleteProvider(editor.id)}>确认删除</button>
                      <button type="button" className="btn outline" onClick={() => setConfirmDelete(false)}>取消</button>
                    </span>
                  ) : (
                    <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Icon name="trash" extra="sm" />删除</button>
                  )
                ) : null}
                <span className="right">
                  <button type="button" className="btn outline" disabled={busy || testing} onClick={() => void onTest(editExisting ? editor.id : undefined, editor.api, editor.endpointUrl, editor.apiKey || undefined)}>{testing ? "测试中…" : "测试连接"}</button>
                  <button type="submit" className="btn primary" disabled={busy}><Icon name="check" extra="sm" />{editExisting ? "保存修改" : "添加供应商"}</button>
                </span>
              </div>
            </form>
          ) : (
            <>
              <div className="mr-toolbar">
                <input className="input" placeholder="搜索供应商名称或 Provider ID…" value={query} onChange={(event) => setQuery(event.target.value)} />
                <span className="mr-count">{providers.length} 个供应商 · {availCount} 个可用</span>
                <span className="seg src-filter" role="tablist" aria-label="供应商来源筛选">
                  <button type="button" className={sourceFilter === "all" ? "active" : undefined} onClick={() => setSourceFilter("all")}>全部</button>
                  <button type="button" className={sourceFilter === "native" ? "active" : undefined} onClick={() => setSourceFilter("native")}>原生</button>
                  <button type="button" className={sourceFilter === "third" ? "active" : undefined} onClick={() => setSourceFilter("third")}>第三方</button>
                </span>
                <span className="spacer" />
                <button type="button" className="btn outline" disabled={preview} title={preview ? "演示模式不刷新 Host" : undefined} onClick={() => void refresh()}><Icon name="refresh" extra="sm" />刷新状态</button>
                <button type="button" className="btn primary" onClick={() => { setEditor(blankDraft()); setEditExisting(false); setPresetOpen(false); setPresetSel(null); setConfirmDelete(false); setTestResult(null); }}><Icon name="plus" extra="sm" />添加供应商</button>
              </div>
              {filtered.length === 0 ? <div className="empty"><Icon name="search" />{providers.length === 0 ? "还没有供应商。添加一个或确认本机 omp 可用。" : "没有匹配的供应商"}</div> : null}
              {filtered.map((provider) => {
                const open = expanded.has(provider.id);
                const st = STATUS_META[provider.status] ?? STATUS_META.available;
                const cardCls = !provider.enabled || provider.status === "disabled" ? "is-disabled"
                  : ["config-error", "connection-failed", "offline"].includes(provider.status) ? "is-error"
                    : ["not-authenticated", "auth-expired"].includes(provider.status) ? "is-warn" : "";
                return (
                  <div className={`pv-card ${cardCls}`} data-id={provider.id} key={provider.id}>
                    <div className="pv-head">
                      <BrandMark id={provider.id} local={provider.local} status={provider.status} />
                      <div className="pv-title">
                        <div className="pv-name">
                          <span>{provider.name}</span>
                          <span className="chip-code">{provider.id}</span>
                          <span className={`chip ${SOURCE_GROUP(provider.source) === "native" ? "blue" : "gray"} xs`}>{SOURCE_GROUP(provider.source) === "native" ? "原生" : "第三方"}</span>
                          <span className="pv-count"><span className={`pv-dot dot ${st?.dot || "gray"}`} />{provider.models.length} 个模型</span>
                        </div>
                        <div className="pv-sub"><span className="pv-url ellipsis">{provider.endpointUrl || provider.statusDetail}</span></div>
                      </div>
                      <div className="pv-acts">
                        <button type="button" className="pv-act is-action" disabled={busy || testing} data-tip="测试连接" title="测试连接" onClick={() => void onTest(provider.id)}><Icon name="pulse" /></button>
                        <button type="button" className="pv-act is-action" disabled title="Discovery 刷新不在本轮范围"><Icon name="refresh" /></button>
                        <button type="button" className="pv-act is-action is-edit" onClick={() => { setEditor(draftFromProvider(provider)); setEditExisting(true); setConfirmDelete(false); setTestResult(null); }}><Icon name="pencil" /></button>
                        <button type="button" className="pv-act is-action is-copy" onClick={() => { void navigator.clipboard.writeText(provider.id); toast(`已复制 ${provider.id}`); }}><Icon name="copy" /></button>
                        <span className="pv-act is-switch">
                          <button type="button" className={`switch${provider.enabled ? " on" : ""}`} role="switch" aria-checked={provider.enabled} disabled={busy} onClick={() => void toggleEnabled(provider)} />
                        </span>
                        <button type="button" className="pv-act is-expand" aria-expanded={open} onClick={() => setExpanded((set) => {
                          const next = new Set(set);
                          if (next.has(provider.id)) next.delete(provider.id); else next.add(provider.id);
                          return next;
                        })}>
                          <span style={{ display: "inline-flex", transform: `rotate(${open ? 90 : 0}deg)` }}><Icon name="chevron-r" /></span>
                        </button>
                      </div>
                    </div>
                    {open ? (
                      <div className="pv-models">
                        {provider.models.length === 0 ? <div className="pm-empty"><Icon name="box" extra="sm" />暂无模型</div> : provider.models.map((model) => (
                          <div className={`pm-row${model.status !== "available" ? " is-off" : ""}`} key={model.selector}>
                            <span className="pm-name"><span className={`dot ${model.status === "available" ? "green" : "amber"}`} />{model.name}</span>
                            <span className="pm-sel ellipsis">{model.selector}</span>
                            <span className="pm-meta">
                              <span className="chip gray xs">{fmtK(model.contextWindow)} ctx</span>
                              {model.image ? <span className="chip blue xs"><Icon name="image" extra="sm" />图</span> : null}
                              {model.reasoning ? <span className="chip purple xs">Reasoning</span> : null}
                              {model.tools ? <span className="chip gray xs">Tools</span> : null}
                            </span>
                            <button type="button" className="icon-btn small" onClick={() => { void navigator.clipboard.writeText(model.selector); toast(`已复制 ${model.selector}`); }}><Icon name="copy" extra="sm" /></button>
                            <button type="button" className="icon-btn small" onClick={() => { setAssignSel(model.selector); setTab("roles"); }}><Icon name="user" extra="sm" /></button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </section>

        <section id="mcPanelRoles" role="tabpanel" aria-labelledby="mcTabRoles" hidden={shownTab !== "roles"} className={shownTab === "roles" ? pagePhaseClass(tabPhase) : undefined}>
          {roleDraft ? (
            <>
              <div className="mr-toolbar">
                <button type="button" className="icon-btn" onClick={() => { setRoleDraft(null); setRoleId(null); }}><Icon name="arrow-l" /></button>
                <b style={{ fontSize: "var(--fs-14)" }}>{roleDraft.name}</b>
                <span className="chip-code">{roleDraft.alias}</span>
                <span className="chip gray xs">内置角色</span>
              </div>
              {roleDraft.issue ? (
                <div className={`role-issue-banner${roleDraft.issue.kind === "model-missing" || roleDraft.issue.kind === "provider-down" ? " err" : ""}`}>
                  <Icon name="alert" extra="sm" />
                  <div><div className="rib-title">{roleDraft.issue.detail}</div></div>
                </div>
              ) : null}
              <div className="mp-sec">
                <h3>模型路由</h3>
                <p className="sec-desc">角色只决定「用哪个模型、以什么思考强度」。本轮写入全局 <span className="chip-code">modelRoles</span>。</p>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="k">Primary Model</span>
                    <span className="v">
                      <select className="select" style={{ maxWidth: 340 }} value={roleDraft.primary} onChange={(event) => setRoleDraft({ ...roleDraft, primary: event.target.value })}>
                        {!usable.some((item) => item.selector === roleDraft.primary) && roleDraft.primary ? <option value={roleDraft.primary}>⚠ {roleDraft.primary}</option> : null}
                        {usable.map((item) => <option key={item.selector} value={item.selector}>{item.name} · {item.selector}</option>)}
                      </select>
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="k">Thinking Level</span>
                    <span className="v">
                      <span className="seg" role="tablist">
                        {MODEL_THINKING.map((item) => (
                          <button type="button" key={item.id} className={(roleDraft.thinking || "off") === item.id ? "active" : undefined} onClick={() => {
                            const next = { ...roleDraft };
                            if (item.id === "off") delete next.thinking;
                            else next.thinking = item.id;
                            setRoleDraft(next);
                          }}>{item.label}</button>
                        ))}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
              <div className="mp-sec">
                <h3>config.yml 预览</h3>
                <pre className="yml-preview">{data?.generatedConfigYml || "modelRoles: {}\n"}</pre>
              </div>
              <div className="mp-foot">
                <button type="button" className="btn outline" onClick={() => { setRoleDraft(null); setRoleId(null); }}>返回</button>
                <span className="right"><button type="button" className="btn primary" disabled={busy} onClick={() => void saveRole(roleDraft)}><Icon name="check" extra="sm" />保存到 Global</button></span>
              </div>
            </>
          ) : (
            <>
              <div className="mr-toolbar">
                <b style={{ fontSize: "var(--fs-13)" }}>内置角色</b>
                <span className="mr-count">{roles.length} 个</span>
                <span className="spacer" />
                <button type="button" className="btn primary" disabled title="创建自定义角色不在本轮范围"><Icon name="plus" extra="sm" />创建自定义角色</button>
              </div>
              {roles.map((role) => (
                <button type="button" className={`role-row${role.issue ? " has-issue" : ""}`} key={role.id} onClick={() => { setRoleId(role.id); setRoleDraft({ ...role }); }}>
                  <span className="role-icon-area"><span className={`a-ic ${role.issue ? "amber" : "purple"}`}><Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" /></span></span>
                  <span className="role-main-area">
                    <span className="role-name-section">
                      <div className="role-header"><span className="r-name">{role.name}<span className="alias">{role.alias}</span></span></div>
                      <span className="r-desc">{role.desc}</span>
                    </span>
                    <span className="role-model-section">
                      {role.issue ? <span className="role-model"><span className="model-name unavailable">{role.primary || "未分配"}</span></span> : (
                        <>
                          <select className="model-select" value={role.primary} onClick={(event) => event.stopPropagation()} onChange={(event) => {
                            event.stopPropagation();
                            void saveRole({ ...role, primary: event.target.value });
                          }}>
                            {usable.map((item) => <option key={item.selector} value={item.selector}>{item.selector}</option>)}
                            {role.primary && !usable.some((item) => item.selector === role.primary) ? <option value={role.primary}>{role.primary}</option> : null}
                          </select>
                          <select className="effort-select" value={role.thinking || "off"} aria-label="推理强度" onClick={(event) => event.stopPropagation()} onChange={(event) => {
                            event.stopPropagation();
                            const next = { ...role };
                            if (event.target.value === "off") delete next.thinking;
                            else next.thinking = event.target.value;
                            void saveRole(next);
                          }}>
                            {MODEL_THINKING.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                          </select>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="role-chevron"><Icon name="chevron-r" extra="sm" /></span>
                </button>
              ))}
              <div className="mp-sec" style={{ marginTop: 20 }}>
                <h3>快速模型切换顺序 <span className="chip-code">Cycle Order</span></h3>
                <p className="sec-desc">工作台循环切换模型时按此顺序轮转。</p>
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
                      <span className="cycle-pool-label">可加入循环的角色</span>
                      {roles.filter((role) => !cycleDraft.includes(role.id)).map((role) => (
                        <button type="button" key={role.id} className="btn small outline" onClick={() => setCycleDraft((current) => [...current, role.id])}><Icon name="plus" extra="sm" />{role.name} <span className="mono">{role.alias}</span></button>
                      ))}
                    </div>
                    <div className="cycle-edit-actions">
                      <button type="button" className="btn small primary" disabled={busy} onClick={() => void saveCycle()}><Icon name="check" extra="sm" />保存顺序</button>
                      <button type="button" className="btn small outline" onClick={() => setCycleEdit(false)}>取消</button>
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
                    <div style={{ marginTop: 12 }}><button type="button" className="btn small outline" onClick={() => { setCycleEdit(true); setCycleDraft([...(data?.cycleOrder ?? [])]); }}><Icon name="pencil" extra="sm" />编辑顺序</button></div>
                  </>
                )}
              </div>
              {assignSel ? (
                <div className="preset-banner">
                  <Icon name="user" extra="sm" />
                  <span>为 <span className="chip-code">{assignSel}</span> 选择角色</span>
                  <span className="spacer" />
                  {roles.map((role) => (
                    <button type="button" key={role.id} className="btn small outline" onClick={() => { void saveRole({ ...role, primary: assignSel }); setAssignSel(null); }}>{role.alias}</button>
                  ))}
                  <button type="button" className="icon-btn small" onClick={() => setAssignSel(null)}><Icon name="x" extra="sm" /></button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
