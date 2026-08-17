import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, CSSProperties } from "react";
import type {
  AvailableModelRecord,
  CommandName,
  ConfigWriteResult,
  ModelAuthType,
  ModelCatalogEntry,
  ModelConfigReadModel,
  ModelCostMeta,
  ModelDiscoveryResult,
  ModelFallbackRevertPolicy,
  ModelOverridePatch,
  ModelPresetItem,
  ModelProviderRecord,
  ModelProviderRemoteCompaction,
  ModelProviderTestResult,
  ModelProviderUpsertInput,
  ModelRoleRecord,
  ModelRoleStorage,
  StudioClient,
} from "@omp-studio/client-contract";
import { MODEL_CONFIG_THINKING_EFFORTS } from "@omp-studio/client-contract";
import { clampRoleThinking, roleThinkingControl } from "@omp-studio/client-contract";
import { Brand, hasBrand } from "./brands";
import { Icon } from "./icons";
import { ToastHost } from "./ToastHost";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { pagePhaseClass, useDeferredKey, useDeferredPresence, useOverlayPresence } from "./pageTransition";
import { extractYamlMapEntry, mergeYamlMapEntry, parseStructured, StructuredEditor } from "./structured-editor";
import { usePreviewMode } from "./preview/PreviewContext";
import {
  MODEL_API_TYPES,
  MODEL_AUTH_TYPES,
  MODEL_THINKING,
  createPreviewModelConfig,
} from "./preview/modelConfigFixtures";
import { SubagentsPanel } from "./SubagentsPanel";
import { createPreviewAgentDefinitions } from "./preview/subagentsPreview";

export const MC_INTENT_KEY = "omp.modelConfigIntent";
const PROVIDER_ORDER_KEY = "omp.providerDisplayOrder";

export type McTab = "providers" | "roles" | "subagents";

type McIntent = { tab?: McTab; edit?: string; role?: string; assign?: string; agent?: string };

const TAB_BUTTON_ID: Record<McTab, string> = {
  providers: "mcTabProviders",
  roles: "mcTabRoles",
  subagents: "mcTabSubagents",
};

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

/** Connection-test result bound to the surface that triggered it. */
type TestResultView = ModelProviderTestResult & {
  readonly source: "list" | "editor";
  readonly providerId: string | undefined;
};

/**
 * Inline connection-test result inside a provider card. Mounts collapsed
 * (grid row 0fr) and expands one frame later, so the card stretches down
 * while the notice slides in from above.
 */
function ProviderTestRow({ result }: { result: TestResultView }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={`pv-test-shell${open ? " open" : ""}`}>
      <div className={`pv-test ${result.ok ? "ok" : "fail"}`} role="status">
        <Icon name={result.ok ? "check" : "alert"} extra="sm" />
        <div className="tr-lines">
          <b>{result.ok ? "连接成功" : "连接失败"}</b>
          <span className="mono">{result.detail} · {result.latencyMs}ms</span>
        </div>
      </div>
    </div>
  );
}

export const ROLE_ICONS: Record<string, string> = {
  default: "cpu", smol: "zap", slow: "brain", vision: "eye", plan: "layers",
  designer: "sparkles", commit: "commit", tiny: "box", task: "bot", advisor: "user",
};

/** 角色列表卡片的主题色（与 models-roles.css 的 .role-row[data-tint] 对应）。 */
export const ROLE_TINTS: Record<string, string> = {
  default: "purple", smol: "green", slow: "blue", vision: "violet", plan: "teal",
  designer: "pink", commit: "cyan", tiny: "lime", task: "orange", advisor: "indigo",
};

export function setModelConfigIntent(intent: McIntent): void {
  try {
    sessionStorage.setItem(MC_INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* ignore */
  }
}

let modelConfigDirty = false;
export function modelConfigHasUnsavedChanges(): boolean {
  return modelConfigDirty;
}

function confirmDiscardDirty(): boolean {
  return window.confirm("有未保存的更改，确定放弃吗？");
}

function DiscoveryResultBlock({ result }: { result: ModelDiscoveryResult }) {
  return (
    <div className={`test-result ${result.ok ? "ok" : "fail"}`} role="status" style={{ marginTop: 10 }}>
      <Icon name={result.ok ? "check" : "alert"} extra="sm" />
      <div className="tr-lines">
        <b>{result.ok ? `探测成功 · ${result.found} found / ${result.usable} usable` : "探测失败"}</b>
        <span className="mono">{result.detail} · {result.latencyMs}ms</span>
        {result.models.length > 0 ? (
          <span className="mono">{result.models.slice(0, 12).map((model) => model.id).join(" · ")}{result.models.length > 12 ? ` · +${result.models.length - 12}` : ""}</span>
        ) : null}
      </div>
    </div>
  );
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

function readProviderOrder(): string[] {
  try {
    const raw = localStorage.getItem(PROVIDER_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

function writeProviderOrder(order: ReadonlyArray<string>): void {
  try {
    localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* localStorage may be blocked; UI order stays in-memory. */
  }
}

function sameOrder(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function mergeProviderOrder(ids: ReadonlyArray<string>, saved: ReadonlyArray<string>): string[] {
  const known = new Set(ids);
  const fromSaved = saved.filter((id) => known.has(id));
  const seen = new Set(fromSaved);
  return [...fromSaved, ...ids.filter((id) => !seen.has(id))];
}

function sortProviders(
  providers: ReadonlyArray<ModelProviderRecord>,
  order: ReadonlyArray<string>,
): ModelProviderRecord[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => {
      const ai = rank.get(a.provider.id) ?? Number.POSITIVE_INFINITY;
      const bi = rank.get(b.provider.id) ?? Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.index - b.index;
    })
    .map((item) => item.provider);
}

export type ModelPickItem = {
  readonly provider: string;
  readonly id: string;
  readonly selector: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly image: boolean;
  readonly tools: boolean;
  readonly contextWindow?: number;
};

type ModelPickGroup = {
  readonly providerId: string;
  readonly providerName: string;
  readonly local: boolean;
  readonly models: ReadonlyArray<ModelPickItem>;
};

function toPickItem(model: AvailableModelRecord, entry?: ModelCatalogEntry): ModelPickItem {
  const contextWindow = entry?.contextWindow ?? model.contextWindow;
  return {
    provider: model.provider,
    id: model.id,
    selector: model.selector,
    name: entry?.name || model.name,
    reasoning: entry?.reasoning ?? model.reasoning,
    image: entry?.image ?? model.image === true,
    tools: entry?.tools ?? model.tools !== false,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

export function groupModelsByProvider(
  models: ReadonlyArray<AvailableModelRecord>,
  providers: ReadonlyArray<ModelProviderRecord>,
): ModelPickGroup[] {
  const buckets = new Map<string, AvailableModelRecord[]>();
  for (const model of models) {
    const list = buckets.get(model.provider);
    if (list) list.push(model);
    else buckets.set(model.provider, [model]);
  }
  const groups: ModelPickGroup[] = [];
  for (const provider of providers) {
    const items = buckets.get(provider.id);
    if (!items?.length) continue;
    const bySelector = new Map(provider.models.map((entry) => [entry.selector, entry]));
    const byId = new Map(provider.models.map((entry) => [entry.id, entry]));
    groups.push({
      providerId: provider.id,
      providerName: provider.name,
      local: provider.local,
      models: items.map((item) => {
        const entry = bySelector.get(item.selector) ?? byId.get(item.id);
        return entry ? toPickItem(item, entry) : toPickItem(item);
      }),
    });
    buckets.delete(provider.id);
  }
  for (const [providerId, items] of buckets) {
    groups.push({ providerId, providerName: providerId, local: false, models: items.map((item) => toPickItem(item)) });
  }
  return groups;
}

function flattenModelGroups(
  groups: ReadonlyArray<ModelPickGroup>,
  orphan?: string,
): ModelPickItem[] {
  const items = groups.flatMap((group) => group.models);
  if (orphan && !items.some((item) => item.selector === orphan)) {
    return [{ provider: "", id: orphan, selector: orphan, name: orphan, reasoning: false, image: false, tools: false }, ...items];
  }
  return items;
}

export function ModelPickCaps({ model }: { model: ModelPickItem }) {
  return (
    <span className="rms-option-caps">
      {model.reasoning ? <span className="chip purple xs chip-icon" title="思考"><Icon name="brain" extra="sm" /></span> : null}
      {model.image ? <span className="chip blue xs chip-icon" title="多模态"><Icon name="image" extra="sm" /></span> : null}
      {model.tools ? <span className="chip gray xs chip-icon" title="工具"><Icon name="wrench" extra="sm" /></span> : null}
      <span className="chip gray xs" title="上下文窗口">{fmtK(model.contextWindow)}</span>
    </span>
  );
}

const PROVIDER_CARD_GAP = 10;
const PROVIDER_DRAG_SETTLE_MS = 250;

type DragCard = {
  id: string;
  el: HTMLElement;
  relTop: number;
  height: number;
};

function permuteVisible(
  full: ReadonlyArray<string>,
  visible: ReadonlyArray<string>,
  nextVisible: ReadonlyArray<string>,
): string[] {
  const known = new Set(visible);
  const queue = nextVisible.slice();
  return full.map((id) => (known.has(id) ? queue.shift() ?? id : id));
}

function siblingShift(index: number, origin: number, over: number, slot: number): number {
  if (origin < over && index > origin && index <= over) return -slot;
  if (origin > over && index >= over && index < origin) return slot;
  return 0;
}

function insertionIndex(items: ReadonlyArray<DragCard>, visualCenterRel: number): number {
  if (items.length === 0) return 0;
  for (let index = 0; index < items.length - 1; index++) {
    const current = items[index];
    const next = items[index + 1];
    if (!current || !next) continue;
    const boundary = (current.relTop + current.height / 2 + next.relTop + next.height / 2) / 2;
    if (visualCenterRel < boundary) return index;
  }
  return items.length - 1;
}

function destinationTranslateY(items: ReadonlyArray<DragCard>, originIndex: number, overIndex: number): number {
  const dragged = items[originIndex];
  if (!dragged) return 0;
  const visible = items.map((item) => item.id);
  const nextVisible = visible.slice();
  const [moved] = nextVisible.splice(originIndex, 1);
  if (!moved) return 0;
  nextVisible.splice(overIndex, 0, moved);
  const heightById = new Map(items.map((item) => [item.id, item.height]));
  let top = items[0]?.relTop ?? 0;
  for (const id of nextVisible) {
    if (id === dragged.id) break;
    top += (heightById.get(id) ?? 0) + PROVIDER_CARD_GAP;
  }
  return top - dragged.relTop;
}

function BrandMark({ id, local, status }: { id: string; local?: boolean; status?: string }) {
  if (hasBrand(id)) {
    return <span className="pv-brand"><Brand id={id} extra="lg" /></span>;
  }
  const tone = status === "available" ? "green" : status === "disabled" ? "purple" : "amber";
  return <span className={`pv-fallback a-ic ${tone}`} aria-hidden="true"><Icon name={local ? "monitor" : "server"} extra="lg" /></span>;
}

export function ProviderGlyph({ id, local = false }: { id: string; local?: boolean }) {
  if (id && hasBrand(id)) return <Brand id={id} extra="sm" />;
  return <Icon name={local ? "monitor" : "server"} extra="sm" />;
}

function fmtK(n?: number): string {
  if (!n) return "—";
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function toggleThinkingEffort(current: readonly string[], id: string): string[] {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return MODEL_CONFIG_THINKING_EFFORTS.filter((item) => next.has(item));
}

function thinkingMenuAnchor(btn: HTMLElement, menu?: HTMLElement | null): { top: number; left: number; width: number } {
  const rect = btn.getBoundingClientRect();
  const width = Math.max(rect.width, menu?.offsetWidth ?? 0);
  const height = menu?.offsetHeight ?? 220;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - height - 4);
  }
  return { top, left, width };
}

function ThinkingEffortSelect({
  value,
  onChange,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 168 });
  const selected = MODEL_CONFIG_THINKING_EFFORTS.filter((id) => value.includes(id));
  const label = selected.length > 0 ? selected.join(", ") : "off, low, medium…";

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    setAnchor(thinkingMenuAnchor(btnRef.current, menuRef.current));
  }, [open, selected.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div className="thinking-effort-dd">
      <button
        ref={btnRef}
        type="button"
        className={`select thinking-effort-btn${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="thinking effort"
        title={selected.length > 0 ? selected.join(", ") : "thinking effort"}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          if (btnRef.current) setAnchor(thinkingMenuAnchor(btnRef.current));
          setOpen(true);
        }}
      >
        <span>{label}</span>
        <Icon name="chevron-d" extra="sm" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu thinking-effort-menu"
              role="listbox"
              aria-multiselectable="true"
              aria-label="thinking effort"
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {MODEL_CONFIG_THINKING_EFFORTS.map((id) => {
                const on = selected.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`pick-role${on ? " is-on" : ""}`}
                    onClick={() => onChange(toggleThinkingEffort(value, id))}
                  >
                    <span className={`pick-check${on ? " on" : ""}`}>{on ? <Icon name="check" extra="sm" /> : null}</span>
                    <span className="pick-copy"><b className="mono">{id}</b></span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

type DraftOverride = { -readonly [K in keyof ModelOverridePatch]?: ModelOverridePatch[K] };

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
  discoveryType: string;
  discoveryTimeoutMs?: number;
  headersText: string;
  disableStrictTools: boolean;
  transport: "" | "pi-native";
  remoteCompactionEnabled: boolean;
  remoteCompactionEndpoint: string;
  remoteCompactionModel: string;
  models: ModelCatalogEntry[];
  modelOverrides: Record<string, DraftOverride>;
};

type ModelsTab = "catalog" | "discovery" | "custom";

type ModelEditState =
  | { kind: "override"; modelId: string; draft: DraftOverrideForm; providerId?: string }
  | { kind: "custom"; index: number; draft: CustomModelForm; providerId?: string }
  | { kind: "add"; draft: CustomModelForm; providerId?: string };

type DraftOverrideForm = {
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: "" | "true" | "false";
  tools: "" | "true" | "false";
  image: "" | "true" | "false";
  costIn: string;
  costOut: string;
  costCacheR: string;
  costCacheW: string;
  omitMaxOutputTokens: "" | "true" | "false";
  premiumMultiplier: string;
  headersText: string;
  contextPromotionTarget: string;
  compactionModel: string;
  rcEnabled: "" | "true" | "false";
  rcEndpoint: string;
  rcModel: string;
  thinking: string[];
};

type CustomModelForm = {
  id: string;
  name: string;
  api: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  tools: boolean;
  image: boolean;
  thinking: string[];
  costIn: string;
  costOut: string;
  costCacheR: string;
  costCacheW: string;
  omitMaxOutputTokens: boolean;
  premiumMultiplier: string;
  headersText: string;
  contextPromotionTarget: string;
  compactionModel: string;
  baseUrl: string;
  rcEnabled: boolean;
  rcEndpoint: string;
  rcModel: string;
};

function headersTextFrom(headers?: Readonly<Record<string, string>>): string {
  return Object.entries(headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
}

function costFromFields(costIn: string, costOut: string, cacheRead: string, cacheWrite: string): ModelCostMeta | undefined {
  const input = parseOptionalNumber(costIn);
  const output = parseOptionalNumber(costOut);
  const read = parseOptionalNumber(cacheRead);
  const write = parseOptionalNumber(cacheWrite);
  if (input === undefined && output === undefined && read === undefined && write === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(read === undefined ? {} : { cacheRead: read }),
    ...(write === undefined ? {} : { cacheWrite: write }),
  };
}

function triState(value: "" | "true" | "false"): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function rcFromParts(
  enabled: boolean | undefined,
  endpoint: string,
  model: string,
): ModelProviderRemoteCompaction | undefined {
  const ep = endpoint.trim();
  const id = model.trim();
  if (enabled === undefined && !ep && !id) return undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(ep ? { endpoint: ep } : {}),
    ...(id ? { model: id } : {}),
  };
}

function blankOverrideForm(from?: DraftOverride): DraftOverrideForm {
  return {
    name: from?.name ?? "",
    contextWindow: from?.contextWindow !== undefined ? String(from.contextWindow) : "",
    maxTokens: from?.maxTokens !== undefined ? String(from.maxTokens) : "",
    reasoning: from?.reasoning === undefined ? "" : from.reasoning ? "true" : "false",
    tools: from?.tools === undefined ? "" : from.tools ? "true" : "false",
    image: from?.image === undefined ? "" : from.image ? "true" : "false",
    costIn: from?.cost?.input !== undefined ? String(from.cost.input) : "",
    costOut: from?.cost?.output !== undefined ? String(from.cost.output) : "",
    costCacheR: from?.cost?.cacheRead !== undefined ? String(from.cost.cacheRead) : "",
    costCacheW: from?.cost?.cacheWrite !== undefined ? String(from.cost.cacheWrite) : "",
    omitMaxOutputTokens: from?.omitMaxOutputTokens === undefined ? "" : from.omitMaxOutputTokens ? "true" : "false",
    premiumMultiplier: from?.premiumMultiplier !== undefined ? String(from.premiumMultiplier) : "",
    headersText: headersTextFrom(from?.headers),
    contextPromotionTarget: from?.contextPromotionTarget ?? "",
    compactionModel: from?.compactionModel ?? "",
    rcEnabled: from?.remoteCompaction?.enabled === undefined ? "" : from.remoteCompaction.enabled ? "true" : "false",
    rcEndpoint: from?.remoteCompaction?.endpoint ?? "",
    rcModel: from?.remoteCompaction?.model ?? "",
    thinking: [...(from?.thinking ?? [])],
  };
}

function blankCustomForm(from?: ModelCatalogEntry): CustomModelForm {
  return {
    id: from?.id ?? "",
    name: from?.name ?? "",
    api: from?.api ?? "inherit",
    contextWindow: from?.contextWindow !== undefined ? String(from.contextWindow) : "128000",
    maxTokens: from?.maxTokens !== undefined ? String(from.maxTokens) : "16384",
    reasoning: from?.reasoning ?? false,
    tools: from?.tools ?? true,
    image: from?.image ?? false,
    costIn: from?.cost?.input !== undefined ? String(from.cost.input) : "",
    costOut: from?.cost?.output !== undefined ? String(from.cost.output) : "",
    costCacheR: from?.cost?.cacheRead !== undefined ? String(from.cost.cacheRead) : "",
    costCacheW: from?.cost?.cacheWrite !== undefined ? String(from.cost.cacheWrite) : "",
    omitMaxOutputTokens: from?.omitMaxOutputTokens ?? false,
    premiumMultiplier: from?.premiumMultiplier !== undefined ? String(from.premiumMultiplier) : "",
    headersText: headersTextFrom(from?.headers),
    contextPromotionTarget: from?.contextPromotionTarget ?? "",
    compactionModel: from?.compactionModel ?? "",
    baseUrl: from?.baseUrl ?? "",
    rcEnabled: from?.remoteCompaction?.enabled ?? false,
    rcEndpoint: from?.remoteCompaction?.endpoint ?? "",
    rcModel: from?.remoteCompaction?.model ?? "",
    thinking: [...(from?.thinking ?? [])],
  };
}

function parseOptionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function overrideFromForm(form: DraftOverrideForm): DraftOverride | null {
  const next: DraftOverride = {};
  if (form.name.trim()) next.name = form.name.trim();
  const ctx = parseOptionalNumber(form.contextWindow);
  if (ctx !== undefined) next.contextWindow = ctx;
  const max = parseOptionalNumber(form.maxTokens);
  if (max !== undefined) next.maxTokens = max;
  const reasoning = triState(form.reasoning);
  if (reasoning !== undefined) next.reasoning = reasoning;
  const tools = triState(form.tools);
  if (tools !== undefined) next.tools = tools;
  const image = triState(form.image);
  if (image !== undefined) next.image = image;
  const cost = costFromFields(form.costIn, form.costOut, form.costCacheR, form.costCacheW);
  if (cost) next.cost = cost;
  const omit = triState(form.omitMaxOutputTokens);
  if (omit !== undefined) next.omitMaxOutputTokens = omit;
  const premium = parseOptionalNumber(form.premiumMultiplier);
  if (premium !== undefined) next.premiumMultiplier = premium;
  const headers = parseHeaders(form.headersText);
  if (Object.keys(headers).length > 0) next.headers = headers;
  if (form.contextPromotionTarget.trim()) next.contextPromotionTarget = form.contextPromotionTarget.trim();
  if (form.compactionModel.trim()) next.compactionModel = form.compactionModel.trim();
  const rc = rcFromParts(triState(form.rcEnabled), form.rcEndpoint, form.rcModel);
  if (rc) next.remoteCompaction = rc;
  if (form.reasoning === "true" && form.thinking.length > 0) next.thinking = [...form.thinking];
  return Object.keys(next).length > 0 ? next : null;
}

function applyOverrideToDraft(host: Draft, modelId: string, form: DraftOverrideForm): { next: Draft; parsed: DraftOverride | null } {
  const parsed = overrideFromForm(form);
  const modelOverrides = { ...host.modelOverrides };
  if (parsed) modelOverrides[modelId] = parsed;
  else delete modelOverrides[modelId];
  const models = host.models.map((model) => {
    if (model.id !== modelId || (model.source !== "catalog" && model.source !== "extension")) return model;
    if (!parsed) return model;
    return {
      ...model,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.contextWindow === undefined ? {} : { contextWindow: parsed.contextWindow }),
      ...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }),
      ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
      ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
      ...(parsed.image === undefined ? {} : { image: parsed.image }),
      ...(parsed.cost === undefined ? {} : { cost: parsed.cost }),
      ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
    };
  });
  return { next: { ...host, modelOverrides, models }, parsed };
}

function entryFromCustomForm(providerId: string, form: CustomModelForm): ModelCatalogEntry | null {
  const id = form.id.trim();
  if (!id) return null;
  const contextWindow = parseOptionalNumber(form.contextWindow);
  const maxTokens = parseOptionalNumber(form.maxTokens);
  const cost = costFromFields(form.costIn, form.costOut, form.costCacheR, form.costCacheW);
  const premium = parseOptionalNumber(form.premiumMultiplier);
  const headers = parseHeaders(form.headersText);
  const rc = rcFromParts(form.rcEnabled ? true : undefined, form.rcEndpoint, form.rcModel);
  return {
    id,
    name: form.name.trim() || id,
    selector: `${providerId}/${id}`,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    reasoning: form.reasoning,
    tools: form.tools,
    image: form.image,
    ...(cost ? { cost } : {}),
    status: "available",
    source: "custom",
    ...(form.api && form.api !== "inherit" ? { api: form.api } : {}),
    ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
    ...(form.omitMaxOutputTokens ? { omitMaxOutputTokens: true } : {}),
    ...(premium === undefined ? {} : { premiumMultiplier: premium }),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(form.contextPromotionTarget.trim() ? { contextPromotionTarget: form.contextPromotionTarget.trim() } : {}),
    ...(form.compactionModel.trim() ? { compactionModel: form.compactionModel.trim() } : {}),
    ...(rc ? { remoteCompaction: rc } : {}),
    ...(form.reasoning && form.thinking.length > 0 ? { thinking: [...form.thinking] } : {}),
  };
}

function ModelCaps({ model }: { model: ModelCatalogEntry }) {
  return (
    <span className="pm-meta">
      <span className="chip gray xs">{fmtK(model.contextWindow)} ctx</span>
      {model.maxTokens ? <span className="chip gray xs">{fmtK(model.maxTokens)} out</span> : null}
      {model.image ? <span className="chip blue xs chip-icon" title="支持图片输入"><Icon name="image" extra="sm" /></span> : null}
      {model.reasoning ? <span className="chip purple xs chip-icon" title="Reasoning"><Icon name="brain" extra="sm" /></span> : null}
      {model.tools ? <span className="chip gray xs chip-icon" title="Tools"><Icon name="wrench" extra="sm" /></span> : null}
      {model.cost?.input !== undefined || model.cost?.output !== undefined
        ? <span className="chip gray xs">${model.cost.input ?? "—"}/${model.cost.output ?? "—"}</span>
        : null}
    </span>
  );
}

function blankDraft(): Draft {
  return {
    id: "", name: "", website: "", note: "", api: "openai-completions", endpointUrl: "",
    local: false, enabled: true, authType: "api-key", apiKey: "", envName: "", command: "",
    discoveryType: "", headersText: "", disableStrictTools: false,
    transport: "", remoteCompactionEnabled: false, remoteCompactionEndpoint: "", remoteCompactionModel: "",
    models: [], modelOverrides: {},
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
    apiKey: provider.auth.type === "api-key" && provider.auth.apiKey && !provider.auth.apiKey.startsWith("!")
      ? provider.auth.apiKey
      : "",
    envName: `${provider.id.replace(/-/g, "_").toUpperCase()}_API_KEY`,
    command: provider.auth.type === "command" && provider.auth.apiKey ? provider.auth.apiKey : "",
    discoveryType: provider.discovery?.type ?? "",
    ...(provider.discovery?.timeoutMs === undefined ? {} : { discoveryTimeoutMs: provider.discovery.timeoutMs }),
    headersText: Object.entries(provider.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n"),
    disableStrictTools: provider.disableStrictTools ?? false,
    transport: provider.transport ?? "",
    remoteCompactionEnabled: provider.remoteCompaction?.enabled ?? false,
    remoteCompactionEndpoint: provider.remoteCompaction?.endpoint ?? "",
    remoteCompactionModel: provider.remoteCompaction?.model ?? "",
    models: provider.models.map((model) => ({ ...model })),
    modelOverrides: { ...(provider.modelOverrides ?? {}) },
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

async function runProbe(
  client: StudioClient,
  input: { readonly providerId: string; readonly endpointUrl?: string; readonly apiKey?: string; readonly discoveryType?: string; readonly timeoutMs?: number },
): Promise<ModelDiscoveryResult> {
  const handle = await client.command("models.provider.probe", input as never);
  return waitReceipt<ModelDiscoveryResult>(client, handle.requestId);
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

function sameStringList(left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string> | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function catalogDraftEqual(left: ModelCatalogEntry, right: ModelCatalogEntry): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.selector === right.selector
    && left.status === right.status
    && left.source === right.source
    && left.reasoning === right.reasoning
    && left.tools === right.tools
    && left.image === right.image
    && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens
    && left.api === right.api
    && left.baseUrl === right.baseUrl
    && left.cost?.input === right.cost?.input
    && left.cost?.output === right.cost?.output
    && left.cost?.cacheRead === right.cost?.cacheRead
    && left.cost?.cacheWrite === right.cost?.cacheWrite
    && sameStringList(left.thinking, right.thinking);
}

function overrideDraftEqual(left: DraftOverride | undefined, right: DraftOverride | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.name === right.name
    && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens
    && left.reasoning === right.reasoning
    && left.tools === right.tools
    && left.image === right.image
    && left.omitMaxOutputTokens === right.omitMaxOutputTokens
    && left.premiumMultiplier === right.premiumMultiplier
    && left.contextPromotionTarget === right.contextPromotionTarget
    && left.compactionModel === right.compactionModel
    && sameStringList(left.thinking, right.thinking)
    && (left.cost?.input === right.cost?.input && left.cost?.output === right.cost?.output && left.cost?.cacheRead === right.cost?.cacheRead && left.cost?.cacheWrite === right.cost?.cacheWrite);
}

function draftsEqual(left: Draft, right: Draft): boolean {
  if (left.id !== right.id
    || left.name !== right.name
    || left.website !== right.website
    || left.note !== right.note
    || left.api !== right.api
    || left.endpointUrl !== right.endpointUrl
    || left.local !== right.local
    || left.enabled !== right.enabled
    || left.authType !== right.authType
    || left.apiKey !== right.apiKey
    || left.envName !== right.envName
    || left.command !== right.command
    || left.discoveryType !== right.discoveryType
    || left.discoveryTimeoutMs !== right.discoveryTimeoutMs
    || left.headersText !== right.headersText
    || left.disableStrictTools !== right.disableStrictTools
    || left.transport !== right.transport
    || left.remoteCompactionEnabled !== right.remoteCompactionEnabled
    || left.remoteCompactionEndpoint !== right.remoteCompactionEndpoint
    || left.remoteCompactionModel !== right.remoteCompactionModel) {
    return false;
  }
  if (left.models.length !== right.models.length) return false;
  if (!left.models.every((model, index) => {
    const other = right.models[index];
    return other !== undefined && catalogDraftEqual(model, other);
  })) return false;
  const leftKeys = Object.keys(left.modelOverrides);
  const rightKeys = Object.keys(right.modelOverrides);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => overrideDraftEqual(left.modelOverrides[key], right.modelOverrides[key]));
}

function rolesEqual(left: ModelRoleRecord, right: ModelRoleRecord): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.desc === right.desc
    && left.primary === right.primary
    && (left.thinking || "off") === (right.thinking || "off");
}

function roleSelector(role: ModelRoleRecord): string {
  return role.thinking && role.thinking !== "off" ? `${role.primary}:${role.thinking}` : role.primary;
}

function withRoleModel(
  role: ModelRoleRecord,
  primary: string,
  model: AvailableModelRecord | undefined,
): ModelRoleRecord {
  const thinking = clampRoleThinking(role.thinking, model);
  const { issue: _ignored, thinking: _thinking, ...rest } = role;
  return thinking ? { ...rest, primary, thinking } : { ...rest, primary };
}

function roleThinkingUi(role: Pick<ModelRoleRecord, "thinking">, model: AvailableModelRecord | undefined) {
  const control = roleThinkingControl(model);
  return {
    items: MODEL_THINKING.filter((item) => control.ids.includes(item.id)),
    disabled: control.disabled,
    value: clampRoleThinking(role.thinking, model) || "off",
  };
}

function RoleThinkingSeg({
  role,
  model,
  onChange,
}: {
  role: ModelRoleRecord;
  model: AvailableModelRecord | undefined;
  onChange: (next: ModelRoleRecord) => void;
}) {
  const thinking = roleThinkingUi(role, model);
  return (
    <span className={`seg${thinking.disabled ? " is-disabled" : ""}`} role="tablist">
      {thinking.items.map((item) => (
        <button type="button" key={item.id} className={thinking.value === item.id ? "active" : undefined} disabled={thinking.disabled} onClick={() => {
          const next = { ...role };
          if (item.id === "off") delete next.thinking;
          else next.thinking = item.id;
          onChange(next);
        }}>{item.label}</button>
      ))}
    </span>
  );
}

function providerUpsertFromDraft(editor: Draft, contentHash?: string): ModelProviderUpsertInput {
  return {
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
    models: editor.models.filter((model) => model.source === "custom").map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      reasoning: model.reasoning,
      image: model.image,
      tools: model.tools,
      ...(model.cost ? { cost: model.cost } : {}),
      ...(model.api ? { api: model.api } : {}),
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.omitMaxOutputTokens ? { omitMaxOutputTokens: true } : {}),
      ...(model.premiumMultiplier === undefined ? {} : { premiumMultiplier: model.premiumMultiplier }),
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.contextPromotionTarget ? { contextPromotionTarget: model.contextPromotionTarget } : {}),
      ...(model.compactionModel ? { compactionModel: model.compactionModel } : {}),
      ...(model.remoteCompaction ? { remoteCompaction: model.remoteCompaction } : {}),
      ...(model.thinking && model.thinking.length > 0 ? { thinking: [...model.thinking] } : {}),
    })),
    modelOverrides: Object.keys(editor.modelOverrides).length > 0 ? editor.modelOverrides : null,
    ...(contentHash ? { expectedHash: contentHash } : {}),
  };
}

function previewProviderFromDraft(editor: Draft): ModelProviderRecord {
  return {
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
    auth: {
      type: editor.authType,
      hasSecret: Boolean(editor.apiKey || editor.command),
      ...(editor.apiKey ? { apiKey: editor.apiKey } : {}),
    },
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
    ...(Object.keys(editor.modelOverrides).length > 0 ? { modelOverrides: editor.modelOverrides } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readModelRoles(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainRecord(value) || !isPlainRecord(value.modelRoles)) return out;
  for (const [key, item] of Object.entries(value.modelRoles)) {
    if (typeof item === "string" && item.trim()) out[key] = item.trim();
  }
  return out;
}

function parseRoleSelector(selector: string): { primary: string; thinking?: string } {
  const idx = selector.lastIndexOf(":");
  if (idx > 0) {
    const suffix = selector.slice(idx + 1);
    if (suffix !== "off" && MODEL_THINKING.some((item) => item.id === suffix)) {
      return { primary: selector.slice(0, idx), thinking: suffix };
    }
  }
  return { primary: selector };
}

function applyRoleSelector(role: ModelRoleRecord, selector: string): ModelRoleRecord {
  const parsed = parseRoleSelector(selector);
  const { issue: _ignored, thinking: _thinking, ...rest } = role;
  return parsed.thinking
    ? { ...rest, primary: parsed.primary, thinking: parsed.thinking }
    : { ...rest, primary: parsed.primary };
}

function assignedRoleIds(roles: ReadonlyArray<ModelRoleRecord>, selector: string): string[] {
  return roles.filter((role) => role.primary === selector).map((role) => role.id);
}

function roleAssignDiff(picked: ReadonlyArray<string>, baseline: ReadonlyArray<string>): { added: string[]; removed: string[] } {
  const base = new Set(baseline);
  return {
    added: picked.filter((id) => !base.has(id)),
    removed: baseline.filter((id) => !picked.includes(id)),
  };
}

function roleAssignModCount(
  picked: ReadonlyArray<string> | undefined,
  roles: ReadonlyArray<ModelRoleRecord>,
  selector: string,
): number {
  if (!picked) return 0;
  const { added, removed } = roleAssignDiff(picked, assignedRoleIds(roles, selector));
  return added.length + removed.length;
}

function missingModelSaveError(labels: ReadonlyArray<string>): string {
  return `无法保存：角色 ${labels.join("、")} 取消后没有主模型，请先设置另一个模型`;
}

function nextRolePrimaries(
  roles: ReadonlyArray<ModelRoleRecord>,
  drafts: Record<string, ReadonlyArray<string>>,
): Map<string, string> {
  const current = new Map<string, string>();
  for (const role of roles) {
    if (role.primary) current.set(role.id, role.primary);
  }
  const next = new Map(current);
  for (const [selector, picked] of Object.entries(drafts)) {
    const pickedSet = new Set(picked);
    for (const [roleId, sel] of current) {
      if (sel === selector && !pickedSet.has(roleId) && next.get(roleId) === selector) next.delete(roleId);
    }
    for (const roleId of picked) next.set(roleId, selector);
  }
  return next;
}

function missingRoleLabels(
  roles: ReadonlyArray<ModelRoleRecord>,
  drafts: Record<string, ReadonlyArray<string>>,
): string[] {
  const next = nextRolePrimaries(roles, drafts);
  return roles.filter((role) => role.primary && !next.has(role.id)).map((role) => role.alias);
}

function rolePrimaryUpdates(
  roles: ReadonlyArray<ModelRoleRecord>,
  drafts: Record<string, ReadonlyArray<string>>,
): Array<{ role: ModelRoleRecord; selector: string }> {
  const next = nextRolePrimaries(roles, drafts);
  const out: Array<{ role: ModelRoleRecord; selector: string }> = [];
  for (const role of roles) {
    const selector = next.get(role.id) ?? "";
    if (selector !== (role.primary ?? "")) out.push({ role, selector });
  }
  return out;
}

function withRolePrimaryUpdates(
  current: ModelConfigReadModel,
  updates: ReadonlyArray<{ role: ModelRoleRecord; selector: string }>,
): ModelConfigReadModel {
  const byId = new Map(updates.map((item) => [item.role.id, item.selector]));
  const models = current.availableModels;
  const nextRoles = current.roles.map((role) => {
    if (!byId.has(role.id)) return role;
    const selector = byId.get(role.id) ?? "";
    if (!selector) {
      const { issue: _ignored, thinking: _thinking, ...rest } = role;
      return { ...rest, primary: "" };
    }
    const model = models.find((item) => item.selector === selector);
    return withRoleModel(role, selector, model);
  });
  const generatedConfigYml = `modelRoles:\n${nextRoles
    .filter((role) => role.primary)
    .map((role) => `  ${role.id}: ${roleSelector(role)}`)
    .join("\n")}${nextRoles.some((role) => role.primary) ? "\n" : ""}`;
  return { ...current, roles: nextRoles, generatedConfigYml };
}

function RoleAssignControl({
  selector,
  open,
  roles,
  disabled,
  modCount,
  showSave,
  initialPicked,
  onToggle,
  onDraftChange,
  onCommit,
  onError,
}: {
  selector: string;
  open: boolean;
  roles: ReadonlyArray<ModelRoleRecord>;
  disabled?: boolean;
  modCount: number;
  showSave: boolean;
  initialPicked?: ReadonlyArray<string>;
  onToggle: (selector: string | null) => void;
  onDraftChange?: (selector: string, picked: string[]) => void;
  onCommit?: (selector: string, addedIds: string[], removedIds: string[]) => void;
  onError: (message: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const [picked, setPicked] = useState<string[]>([]);
  const baselineRef = useRef<string[]>([]);
  const pickedRef = useRef<string[]>([]);
  const rolesRef = useRef(roles);
  const errorRef = useRef(onError);
  const commitRef = useRef(onCommit);
  const draftRef = useRef(onDraftChange);
  const initialRef = useRef(initialPicked);
  pickedRef.current = picked;
  rolesRef.current = roles;
  errorRef.current = onError;
  commitRef.current = onCommit;
  draftRef.current = onDraftChange;
  initialRef.current = initialPicked;

  const trySave = () => {
    const { added, removed } = roleAssignDiff(pickedRef.current, baselineRef.current);
    commitRef.current?.(selector, added, removed);
    onToggle(null);
  };

  const dismiss = () => onToggle(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const width = popRef.current?.offsetWidth ?? 280;
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 4);
    }
    setAnchor({ top, left });
  }, [open, picked.length, roles.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      dismiss();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onToggle]);

  useEffect(() => {
    if (!open || showSave) return;
    draftRef.current?.(selector, picked);
  }, [open, showSave, selector, picked]);

  const baseline = new Set(baselineRef.current);
  const { added, removed } = roleAssignDiff(picked, baselineRef.current);
  const changeCount = added.length + removed.length;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn small role-assign-btn${open ? " is-open" : ""}`}
        title="选择角色"
        aria-label="选择角色"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) {
            dismiss();
            return;
          }
          const nextBaseline = assignedRoleIds(rolesRef.current, selector);
          baselineRef.current = nextBaseline;
          setPicked(initialRef.current ? [...initialRef.current] : nextBaseline);
          if (btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            const left = Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288));
            setAnchor({ top: rect.bottom + 4, left });
          }
          onToggle(selector);
        }}
      >
        <Icon name="user" extra="sm" />
        {modCount > 0 ? <span className="role-assign-badge">{modCount > 99 ? "99+" : modCount}</span> : null}
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="menu role-assign-pop"
              role="listbox"
              aria-multiselectable="true"
              aria-label="选择角色"
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="rap-head">
                <b>选择角色</b>
                <span className="mono">{selector}</span>
              </div>
              {roles.length === 0 ? (
                <div className="rap-empty">还没有角色</div>
              ) : (
                <div className="rap-list">
                  {roles.map((role) => {
                    const on = picked.includes(role.id);
                    const wasCurrent = baseline.has(role.id);
                    return (
                      <button
                        type="button"
                        key={role.id}
                        className={`menu-item pick-role${on ? " is-on" : ""}`}
                        role="option"
                        aria-selected={on}
                        onClick={() => {
                          setPicked((currentIds) => (
                            currentIds.includes(role.id)
                              ? currentIds.filter((id) => id !== role.id)
                              : [...currentIds, role.id]
                          ));
                        }}
                      >
                        <span className={`pick-check${on ? " on" : ""}`} aria-hidden="true">
                          {on ? <Icon name="check" extra="sm" /> : null}
                        </span>
                        <Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" />
                        <span className="pick-copy">
                          <b>{role.name}</b>
                          <span className="mono muted small">{role.alias}</span>
                        </span>
                        <span className="hint ellipsis">
                          {on ? (wasCurrent ? "当前" : (role.primary || "未分配")) : (wasCurrent ? "将取消" : (role.primary || "未分配"))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showSave || changeCount > 0 ? (
                <div className="rap-foot">
                  <span>{changeCount > 0 ? `将修改 ${changeCount} 个角色` : "未更改"}</span>
                  {showSave ? <button type="button" className="btn small primary" onClick={trySave}>保存</button> : <span className="rap-hint">保存供应商时生效</span>}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function RoleModelPicker({
  value,
  groups,
  disabled,
  onChange,
}: {
  value: string;
  groups: ReadonlyArray<ModelPickGroup>;
  disabled?: boolean;
  onChange: (selector: string) => void;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 300 });
  const [active, setActive] = useState(value);
  const activeRef = useRef(active);
  const onChangeRef = useRef(onChange);
  activeRef.current = active;
  onChangeRef.current = onChange;
  const flat = useMemo(() => flattenModelGroups(groups, value), [groups, value]);
  const selected = flat.find((item) => item.selector === value);
  const selectedGroup = groups.find((group) => group.models.some((item) => item.selector === value));

  const place = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 380);
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 4);
    }
    setAnchor({ top, left, width });
  };

  const dismiss = () => setOpen(false);

  const pick = (selector: string) => {
    onChangeRef.current(selector);
    dismiss();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, groups.length, flat.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = popRef.current?.querySelector<HTMLElement>("[data-active='true']");
    node?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    setActive(value);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        btnRef.current?.focus();
        return;
      }
      const currentActive = activeRef.current;
      const index = Math.max(0, flat.findIndex((item) => item.selector === currentActive));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (flat.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = flat[(index + delta + flat.length) % flat.length];
        if (next) setActive(next.selector);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        const first = flat[0];
        if (first) setActive(first.selector);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        const last = flat[flat.length - 1];
        if (last) setActive(last.selector);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const current = flat.find((item) => item.selector === currentActive) ?? flat[index];
        if (current) pick(current.selector);
      }
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      dismiss();
    };
    const onReposition = () => place();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, flat, value]);

  const label = selected?.name || value || "选择模型";
  const missing = Boolean(value) && !selectedGroup;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`rms-trigger${open ? " is-open" : ""}${missing ? " is-missing" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="主模型"
        title={value || undefined}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (open && event.detail === 0) return;
          if (open) {
            dismiss();
            return;
          }
          setActive(value);
          setOpen(true);
        }}
      >
        <span className="rms-brand" aria-hidden="true">
          <ProviderGlyph id={selectedGroup?.providerId || selected?.provider || ""} local={selectedGroup?.local ?? false} />
        </span>
        <span className="rms-copy">
          <span className="rms-name">{label}</span>
        </span>
        <Icon name={open ? "chevron-u" : "chevron-d"} extra="sm" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              id={listId}
              className="menu rms-pop"
              role="listbox"
              aria-label="按供应商选择模型"
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {flat.length === 0 ? (
                <div className="rms-empty">没有可用模型</div>
              ) : (
                <>
                  {missing ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected={value === active}
                      data-active={active === value ? "true" : undefined}
                      className={`menu-item rms-option is-missing${active === value ? " is-active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(value)}
                    >
                      <span className="rms-option-copy">
                        <b>{value}</b>
                        <span>当前值不在可用列表</span>
                      </span>
                    </button>
                  ) : null}
                  {groups.map((group) => (
                    <div className="rms-group" key={group.providerId} role="group" aria-label={group.providerName}>
                      <div className="rms-group-label">
                        <span className="rms-brand" aria-hidden="true">
                          <ProviderGlyph id={group.providerId} local={group.local} />
                        </span>
                        <span className="rms-group-name">{group.providerName}</span>
                        <span className="rms-group-count">{group.models.length}</span>
                      </div>
                      {group.models.map((model) => {
                        const on = model.selector === value;
                        const isActive = model.selector === active;
                        return (
                          <button
                            type="button"
                            key={model.selector}
                            role="option"
                            aria-selected={on}
                            data-active={isActive ? "true" : undefined}
                            className={`menu-item rms-option${on ? " is-on" : ""}${isActive ? " is-active" : ""}`}
                            title={model.selector}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => pick(model.selector)}
                          >
                            <span className="rms-option-copy">
                              <b>{model.name}</b>
                              {model.id !== model.name ? <span>{model.id}</span> : null}
                            </span>
                            <ModelPickCaps model={model} />
                            {on ? <Icon name="check" extra="sm" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function ModelConfigPage({ client }: { client: StudioClient }) {
  const { preview } = usePreviewMode();
  const [tab, setTab] = useState<McTab>("providers");
  const { shown: shownTab, phase: tabPhase } = useDeferredKey(tab);
  /* First paint must not play tabpanel page-in: it stacks on the shell/page-body
     translateY and Chromium flashes native placeholder glyphs at the wrong size.
     Arm only after a real tab change, same idea as useDeferredPresence `live`.
     useDeferredKey now reports "out" on the click paint, so the outgoing panel
     gets page-out rather than a one-frame page-in flash. */
  const tabMotionLive = useRef(false);
  if (!Object.is(tab, shownTab)) tabMotionLive.current = true;
  const tabPanelClass = (id: McTab) => (shownTab === id && tabMotionLive.current ? pagePhaseClass(tabPhase) : undefined);
  const [data, setData] = useState<ModelConfigReadModel | null>(preview ? createPreviewModelConfig() : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "native" | "third">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editorState, setEditor] = useState<Draft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const { shown: editor, phase: editorPhase, live: editorLive } = useDeferredPresence(editorState);
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
  const { shown: roleDraft, phase: rolePhase, live: roleLive } = useDeferredPresence(roleDraftState);
  const [assignSel, setAssignSel] = useState<string | null>(null);
  const [assignPopSel, setAssignPopSel] = useState<string | null>(null);
  const [assignModCounts, setAssignModCounts] = useState<Record<string, number>>({});
  const [roleAssignDraft, setRoleAssignDraft] = useState<Record<string, string[]>>({});
  const [agentIntent, setAgentIntent] = useState<string | undefined>(undefined);
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
  const [createRoleOpen, setCreateRoleOpen] = useState(false);
  const [newRole, setNewRole] = useState({ id: "", name: "", desc: "" });
  const [fallbackDraft, setFallbackDraft] = useState<string[] | null>(null);
  const [revertPolicyDraft, setRevertPolicyDraft] = useState<ModelFallbackRevertPolicy | null>(null);
  const [modelsTab, setModelsTab] = useState<ModelsTab>("custom");
  const [modelEdit, setModelEdit] = useState<ModelEditState | null>(null);
  const { shown: modelEditView, leaving: modelEditLeaving } = useOverlayPresence(modelEdit);
  const [displayOrder, setDisplayOrder] = useState<string[]>(() => readProviderOrder());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragPhase, setDragPhase] = useState<"dragging" | "settling">("dragging");
  const loaded = useRef(false);
  const mcTabsRef = useRef<HTMLDivElement>(null);
  const tabWinRef = useRef<HTMLSpanElement>(null);
  const tabMirrorRef = useRef<HTMLSpanElement>(null);
  const tabWinPrimed = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const orderRef = useRef(displayOrder);
  const clearDragStylesRef = useRef(false);
  const settleGenRef = useRef(0);
  const dragLockRef = useRef(false);
  orderRef.current = displayOrder;

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
    }
  }, [hasProviderEditor]);

  useEffect(() => {
    if (editorState && providerBaseline === null) setProviderBaseline(editorState);
  }, [editorState, providerBaseline]);

  useEffect(() => {
    if (!editorState) return;
    setModelsYmlDraft(null);
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

  useLayoutEffect(() => {
    if (!clearDragStylesRef.current) return;
    clearDragStylesRef.current = false;
    const root = listRef.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>(".pv-card")) {
      el.style.transition = "transform 0s";
      el.style.transform = "";
    }
    void root.offsetHeight;
    for (const el of root.querySelectorAll<HTMLElement>(".pv-card")) {
      el.style.removeProperty("transition");
      el.style.removeProperty("transform");
    }
  }, [draggingId, displayOrder]);

  const orderedProviders = useMemo(() => sortProviders(providers, displayOrder), [providers, displayOrder]);
  const filtered = orderedProviders.filter((item) => {
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
    const active = tabs.querySelector<HTMLElement>(`#${TAB_BUTTON_ID[tab]}`);
    if (!active) return;
    const animate = tabWinPrimed.current;
    if (!animate) {
      win.style.transition = "none";
      mirror.style.transition = "none";
    }
    win.style.left = `${active.offsetLeft}px`;
    win.style.width = `${active.offsetWidth}px`;
    mirror.style.left = `${-active.offsetLeft}px`;
    if (!animate) {
      void win.offsetWidth;
      win.style.removeProperty("transition");
      mirror.style.removeProperty("transition");
      tabWinPrimed.current = true;
    }
  }, [tab, providers.length, roles.length, agentCount]);

  const activate = (next: McTab, focus = false) => {
    setTab(next);
    if (focus) document.getElementById(TAB_BUTTON_ID[next])?.focus();
  };

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys: McTab[] = ["providers", "roles", "subagents"];
    const index = keys.indexOf(tab);
    let next: McTab | null = null;
    if (event.key === "ArrowRight") next = keys[(index + 1) % keys.length] ?? "providers";
    else if (event.key === "ArrowLeft") next = keys[(index - 1 + keys.length) % keys.length] ?? "providers";
    else if (event.key === "Home") next = "providers";
    else if (event.key === "End") next = "subagents";
    if (!next) return;
    event.preventDefault();
    activate(next, true);
  };

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
  const modelsYmlValue = modelsYmlDraft ?? modelsYmlSliceSource;
  const configYmlValue = configYmlDraft ?? configYmlSliceSource;
  const modelsYmlDirty = modelsYmlDraft !== null && modelsYmlDraft !== modelsYmlSliceSource;
  const configYmlDirty = configYmlDraft !== null && configYmlDraft !== configYmlSliceSource;
  const providerFormDirty = Boolean(
    editorState && providerBaseline && !draftsEqual(editorState, providerBaseline),
  );
  const roleFormDirty = Boolean(
    roleDraftState && roleBaseline && !rolesEqual(roleDraftState, roleBaseline),
  );
  const fallbackDirty = Boolean(
    roleDraftState && (
      (fallbackDraft !== null && !sameStringList(fallbackDraft, data?.fallbackChains[roleDraftState.primary] ?? []))
      || (revertPolicyDraft !== null && revertPolicyDraft !== (data?.fallbackRevertPolicy ?? "cooldown-expiry"))
    ),
  );

  useEffect(() => {
    modelConfigDirty = providerFormDirty || roleFormDirty || modelsYmlDirty || configYmlDirty || fallbackDirty;
    return () => {
      modelConfigDirty = false;
    };
  }, [providerFormDirty, roleFormDirty, modelsYmlDirty, configYmlDirty, fallbackDirty]);

  const onProviderDragPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    if (dragLockRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const root = listRef.current;
    if (!root) return;
    const listRect = root.getBoundingClientRect();
    const items: DragCard[] = [...root.querySelectorAll<HTMLElement>(".pv-card")].flatMap((el) => {
      const cardId = el.dataset.id;
      if (!cardId) return [];
      const rect = el.getBoundingClientRect();
      return [{ id: cardId, el, relTop: rect.top - listRect.top, height: rect.height }];
    });
    const originIndex = items.findIndex((item) => item.id === id);
    const dragged = items[originIndex];
    if (originIndex < 0 || !dragged) return;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    dragLockRef.current = true;
    settleGenRef.current += 1;
    setDragPhase("dragging");
    setDraggingId(id);
    document.body.classList.add("is-pv-sorting");
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    const startY = event.clientY;
    const slot = dragged.height + PROVIDER_CARD_GAP;
    let overIndex = originIndex;

    const applyShifts = (over: number) => {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!item || index === originIndex) continue;
        const shift = siblingShift(index, originIndex, over, slot);
        item.el.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : "";
      }
    };

    const stopCursor = () => {
      document.body.classList.remove("is-pv-sorting");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    };

    const move = (next: PointerEvent) => {
      next.preventDefault();
      const dy = next.clientY - startY;
      dragged.el.style.transform = `translate3d(0, ${dy}px, 0)`;
      const nextOver = insertionIndex(items, dragged.relTop + dragged.height / 2 + dy);
      if (nextOver === overIndex) return;
      overIndex = nextOver;
      applyShifts(overIndex);
    };

    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      stopCursor();
      const destY = destinationTranslateY(items, originIndex, overIndex);
      const gen = ++settleGenRef.current;
      setDragPhase("settling");
      dragged.el.style.transition = "transform var(--dur-slow) var(--ease-ios), scale var(--dur-slow) var(--ease-ios)";
      requestAnimationFrame(() => {
        if (gen !== settleGenRef.current) return;
        dragged.el.style.transform = `translate3d(0, ${destY}px, 0)`;
      });

      const finish = () => {
        if (gen !== settleGenRef.current) return;
        dragLockRef.current = false;
        clearDragStylesRef.current = true;
        setDraggingId(null);
        setDragPhase("dragging");
        if (overIndex === originIndex) return;
        const visible = items.map((item) => item.id);
        const nextVisible = visible.slice();
        const [moved] = nextVisible.splice(originIndex, 1);
        if (!moved) return;
        nextVisible.splice(overIndex, 0, moved);
        const nextOrder = permuteVisible(orderRef.current, visible, nextVisible);
        if (sameOrder(nextOrder, orderRef.current)) return;
        orderRef.current = nextOrder;
        setDisplayOrder(nextOrder);
        writeProviderOrder(nextOrder);
      };

      window.setTimeout(finish, PROVIDER_DRAG_SETTLE_MS);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const mutateLocal = (recipe: (current: ModelConfigReadModel) => ModelConfigReadModel) => {
    setData((current) => recipe(current ?? createPreviewModelConfig()));
  };

  const mergeContentHash = (hash: string | undefined) => {
    if (!hash) return;
    mutateLocal((current) => ({ ...current, contentHash: hash }));
  };

  const persistModelsYml = async (text: string, overlayForm: boolean, close: boolean): Promise<boolean> => {
    if (!providerYamlId) {
      toast("请先填写 Provider ID");
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
      toast("名称和 Provider ID 不能为空");
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
      toast("演示：已更新本地 YAML，未写入 Host");
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
      toast(result.message ?? "已写入 models.yml");
      setModelsYmlDraft(null);
      if (overlayForm && draft) setProviderBaseline(draft);
      mergeContentHash(result.contentHash);
      if (close) setEditor(null);
      await refresh();
      return true;
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const persistConfigYml = async (text: string, overlayForm: boolean, close: boolean): Promise<boolean> => {
    if (!roleYamlId) {
      toast("角色 id 不能为空");
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
      toast("演示：已更新本地角色 YAML，未写入 Host");
      return true;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roles.write", { roles: rolesMap });
      toast(result.message ?? "已保存到 config.yml");
      setConfigYmlDraft(null);
      if (overlayForm && draft) setRoleBaseline(draft);
      if (close) {
        setRoleDraft(null);
        setRoleId(null);
      }
      await refresh();
      return true;
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!editorState) return;
    if (!editorState.id.trim() || !editorState.name.trim()) {
      toast("名称和 Provider ID 不能为空");
      return;
    }
    const roleUpdates = rolePrimaryUpdates(roles, roleAssignDraft);
    if (modelsYmlDirty) {
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
        let next: ModelConfigReadModel = {
          ...current,
          providers: [...current.providers.filter((item) => item.id !== record.id), record],
        };
        if (roleUpdates.length > 0) next = withRolePrimaryUpdates(next, roleUpdates);
        return next;
      });
      setRoleAssignDraft({});
      setEditor(null);
      toast(roleUpdates.length > 0 ? "演示：已更新本地列表与角色，未写入 Host" : "演示：已更新本地列表，未写入 models.yml");
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
      toast(roleUpdates.length > 0 ? `${result.message ?? "已保存"} · 已更新 ${roleUpdates.length} 个角色` : (result.message ?? "已保存"));
      setEditor(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const persistProviderDraft = async (draft: Draft, okMessage: string) => {
    if (!draft.id.trim() || !draft.name.trim()) {
      toast("名称和 Provider ID 不能为空");
      return;
    }
    if (preview) {
      const record = previewProviderFromDraft(draft);
      mutateLocal((current) => ({
        ...current,
        providers: [...current.providers.filter((item) => item.id !== record.id), record],
      }));
      toast(`演示：${okMessage}，未写入 models.yml`);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.provider.upsert", providerUpsertFromDraft(draft, data?.contentHash));
      mergeContentHash(result.contentHash);
      toast(result.message ?? okMessage);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
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
      toast(hostErrorMessage(error, "删除失败"));
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
      toast(enabled ? `演示：已启用 ${provider.name}` : `演示：已禁用 ${provider.name}`);
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
      toast(enabled ? `已启用 ${provider.name}` : `已禁用 ${provider.name}，其模型不再参与路由`);
    } catch (error) {
      if (snapshot) setData(snapshot);
      else applyEnabledLocal(provider.id, provider.enabled);
      toast(hostErrorMessage(error, "更新失败"));
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
      if (opts?.announce !== false) toast(`演示：已将模型分配给 ${updates.length} 个角色，未写入 config.yml`);
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
    if (opts?.announce !== false) toast(last?.message ?? `已将模型分配给 ${updates.length} 个角色`);
    if (opts?.refreshAfter !== false) await refresh();
  };

  const assignModelToRoles = async (selector: string, roleIds: ReadonlyArray<string>) => {
    const targets = roles.filter((role) => roleIds.includes(role.id) && role.primary !== selector);
    if (targets.length === 0) return;
    if (preview) {
      await applyRolePrimaryUpdates(targets.map((role) => ({ role, selector })));
      return;
    }
    setBusy(true);
    try {
      await applyRolePrimaryUpdates(targets.map((role) => ({ role, selector })));
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
    } finally {
      setBusy(false);
    }
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
        toast("角色 id 只能使用小写字母、数字、连字符和下划线");
        return;
      }
      if (!name) {
        toast("请填写角色名称");
        return;
      }
      const taken = roles.some((item) => item.id === id && item.id !== (baseline?.id ?? role.id));
      if (taken) {
        toast("该角色 id 已被占用");
        return;
      }
    } else if (!role.primary) {
      toast("请先选择主模型");
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
      toast("演示：已更新本地角色，未写入 config.yml");
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
        toast("请先选择主模型");
        return;
      }
      toast("已保存到 config.yml");
      setRoleId(null);
      setRoleDraft(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const startLogin = async (providerId: string) => {
    if (preview) {
      toast("演示：不会发起 Host 登录");
      return;
    }
    if (!data?.loginAvailable) {
      toast(`请在终端运行 omp login ${providerId}`);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.login.start", { providerId });
      toast(result.message ?? "登录完成");
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, `登录失败，请运行 omp login ${providerId}`));
    } finally {
      setBusy(false);
    }
  };

  const logoutProvider = async (providerId: string) => {
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        loginProviders: current.loginProviders.map((item) => item.id === providerId ? { ...item, authenticated: false } : item),
      }));
      toast("演示：已登出，未写入 Host");
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.login.logout", { providerId });
      toast(result.message ?? `已登出 ${providerId}`);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "登出失败"));
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
        detail: "演示：模拟连接成功 · HTTP 200",
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
      setTestResult({ source, providerId, ok: false, latencyMs: 0, detail: hostErrorMessage(error, "测试失败") });
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
    detail: `演示：探测 ${providerId} 成功`,
  });

  const onProbe = async (providerId: string, endpointUrl?: string, apiKey?: string, discoveryType?: string, timeoutMs?: number) => {
    if (preview) {
      setProbeResult(previewProbeResult(providerId));
      toast("演示：Discovery 探测未调用 Host");
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
        detail: hostErrorMessage(error, "探测失败"),
      });
    } finally {
      setProbing(false);
    }
  };

  const refreshDiscovery = async () => {
    if (preview) {
      toast("演示：不会执行 omp models refresh");
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.discovery.refresh", {});
      toast(result.message ?? "已重新扫描 Discovery 缓存");
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "刷新失败"));
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
      toast(storage === "project" ? "演示：已切到 Project 作用域" : "演示：已恢复全局");
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roleStorage.set", { storage });
      toast(result.message ?? "已更新角色作用域");
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "切换作用域失败"));
    } finally {
      setBusy(false);
    }
  };

  const createCustomRole = async () => {
    const id = newRole.id.trim();
    const name = newRole.name.trim() || id;
    if (!id) {
      toast("请填写角色 id");
      return;
    }
    if (preview) {
      mutateLocal((current) => ({
        ...current,
        roles: [...current.roles, {
          id,
          alias: `@${id}`,
          name,
          desc: newRole.desc.trim() || "自定义角色",
          builtin: false,
          primary: "",
          scope: current.modelRoleStorage,
        }],
      }));
      setCreateRoleOpen(false);
      setNewRole({ id: "", name: "", desc: "" });
      toast("演示：已创建自定义角色，未写入 Host");
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roles.create", {
        id,
        name,
        ...(newRole.desc.trim() ? { desc: newRole.desc.trim() } : {}),
      });
      toast(result.message ?? `已创建角色 ${id}`);
      setCreateRoleOpen(false);
      setNewRole({ id: "", name: "", desc: "" });
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "创建角色失败"));
    } finally {
      setBusy(false);
    }
  };

  const deleteCustomRole = async (roleId: string) => {
    if (preview) {
      mutateLocal((current) => ({ ...current, roles: current.roles.filter((role) => role.id !== roleId) }));
      setRoleDraft(null);
      setRoleId(null);
      toast("演示：已删除自定义角色");
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.roles.delete", { roleId });
      toast(result.message ?? `已删除角色 ${roleId}`);
      setRoleDraft(null);
      setRoleId(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "删除角色失败"));
    } finally {
      setBusy(false);
    }
  };

  const saveFallback = async (primary: string) => {
    const chains = { ...(data?.fallbackChains ?? {}) };
    const nextChain = [...(fallbackDraft ?? chains[primary] ?? [])];
    if (nextChain.length > 0) chains[primary] = nextChain;
    else delete chains[primary];
    const revertPolicy = revertPolicyDraft ?? data?.fallbackRevertPolicy ?? "cooldown-expiry";
    if (preview) {
      mutateLocal((current) => ({ ...current, fallbackChains: chains, fallbackRevertPolicy: revertPolicy }));
      setFallbackDraft(nextChain);
      setRevertPolicyDraft(revertPolicy);
      toast("演示：已更新 Fallback，未写入 Host");
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.fallback.set", { chains, revertPolicy });
      toast(result.message ?? "已保存 Fallback 链");
      setFallbackDraft(nextChain);
      setRevertPolicyDraft(revertPolicy);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "保存 Fallback 失败"));
    } finally {
      setBusy(false);
    }
  };

  const saveProviderOrder = async () => {
    if (preview) {
      mutateLocal((current) => ({ ...current, modelProviderOrder: orderDraft.slice() }));
      toast("演示：已更新 modelProviderOrder，未写入 Host");
      setOrderEdit(false);
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.providerOrder.set", { order: orderDraft.slice() });
      toast(result.message ?? "已保存 modelProviderOrder");
      setOrderEdit(false);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, "保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const closeProviderEditor = () => {
    if ((providerFormDirty || modelsYmlDirty) && !confirmDiscardDirty()) return;
    setEditor(null);
  };

  const closeRoleEditor = () => {
    if ((roleFormDirty || configYmlDirty || fallbackDirty) && !confirmDiscardDirty()) return;
    setRoleDraft(null);
    setRoleId(null);
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
      toast(hostErrorMessage(error, "保存失败"));
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
  const usableGroups = useMemo(() => groupModelsByProvider(usable, orderedProviders), [usable, orderedProviders]);
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
            image: entry.image,
            tools: entry.tools,
            ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
            ...(entry.cost ? { cost: entry.cost } : {}),
            thinking: entry.thinking,
          });
        } else if (!current) {
          map.set(entry.selector, {
            provider: provider.id,
            id: entry.id,
            selector: entry.selector,
            name: entry.name,
            reasoning: entry.reasoning,
            image: entry.image,
            tools: entry.tools,
            ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
            ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
            ...(entry.cost ? { cost: entry.cost } : {}),
          });
        }
      }
    }
    return map;
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
          <button role="tab" id="mcTabSubagents" aria-controls="mcPanelSubagents" aria-selected={tab === "subagents"} tabIndex={tab === "subagents" ? 0 : -1} className={tab === "subagents" ? "active" : undefined} onClick={() => activate("subagents")}>
            <Icon name="bot" extra="sm" /><span>子代理</span>
            <span className="chip gray xs">{agentCount}<span className="sr-only"> 个子代理</span></span>
          </button>
          <span className="mc-tab-window" ref={tabWinRef} aria-hidden="true">
            <span className="mc-tab-mirror" ref={tabMirrorRef}>
              <button type="button" tabIndex={-1}><Icon name="server" extra="sm" /><span>供应商</span><span className={`chip ${availCount === 0 && providers.length > 0 ? "amber" : "gray"} xs`}>{providers.length}<span className="sr-only"> 个供应商</span></span></button>
              <button type="button" tabIndex={-1}><Icon name="steering" extra="sm" /><span>角色</span><span className={`chip ${roleIssues ? "red" : "gray"} xs`}>{roles.length}<span className="sr-only"> 个角色</span></span></button>
              <button type="button" tabIndex={-1}><Icon name="bot" extra="sm" /><span>子代理</span><span className="chip gray xs">{agentCount}<span className="sr-only"> 个子代理</span></span></button>
            </span>
          </span>
        </div>
      </div>

      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
      {preview ? (
        <div className="role-issue-banner mc-page-banner">
          <Icon name="info" extra="sm" />
          <div>
            <div className="rib-title">当前是演示数据，不是本机 ~/.omp 配置</div>
            <div className="rib-text">关掉顶栏右上角「预览」后再进本页，才会直接读取 ~/.omp/agent/models.yml 和 config.yml。</div>
          </div>
        </div>
      ) : null}
      {!preview && loadError ? <div className="role-issue-banner mc-page-banner"><Icon name="alert" extra="sm" /><div><div className="rib-title">读取说明</div><div className="rib-text">{loadError}</div></div></div> : null}

      <div id="mcPanels" tabIndex={-1}>
        <section id="mcPanelProviders" role="tabpanel" aria-labelledby="mcTabProviders" hidden={shownTab !== "providers"} className={tabPanelClass("providers")}>
          <div className={editorLive ? `mc-view ${pagePhaseClass(editorPhase)}` : "mc-view"}>
          {editor ? (
            <>
            <form className="mp-editor" onSubmit={(event) => void saveProvider(event)}>
              <div className="mr-toolbar">
                <button type="button" className="icon-btn" onClick={closeProviderEditor}><Icon name="arrow-l" /></button>
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
                                <button type="button" key={item.id} className={`preset-item${presetSel === item.id ? " sel" : ""}`} onClick={() => { setProviderBaseline(null); setEditor(draftFromPreset(item)); setPresetSel(item.id); }}>
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
                      <span>
                        {data?.loginProviders.find((item) => item.id === editor.id)?.authenticated
                          ? "已登录本机 OAuth 凭据。"
                          : data?.loginAvailable ? "可尝试应用内登录。" : "请用终端 `omp login`。"}
                      </span>
                      <button type="button" className="btn small primary" disabled={busy} onClick={() => void startLogin(editor.id)}>
                        {data?.loginProviders.find((item) => item.id === editor.id)?.authenticated ? "重新登录" : "登录"}
                      </button>
                      {data?.loginProviders.find((item) => item.id === editor.id)?.authenticated ? (
                        <button type="button" className="btn small outline" disabled={busy} onClick={() => void logoutProvider(editor.id)}>登出</button>
                      ) : null}
                    </div>
                  ) : null}
                  {editor.authType === "api-key" ? (
                    <div className="field">
                      <label htmlFor="f-key">API Key</label>
                      <div className="pwd-input">
                        <input
                          className="input mono"
                          id="f-key"
                          type={showKey ? "text" : "password"}
                          value={editor.apiKey}
                          placeholder="留空则保留已保存密钥"
                          autoComplete="off"
                          onChange={(event) => setEditor({ ...editor, apiKey: event.target.value })}
                        />
                        <button
                          type="button"
                          className="pwd-toggle"
                          aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                          aria-pressed={showKey}
                          title={showKey ? "隐藏 API Key" : "显示 API Key"}
                          onClick={() => setShowKey((value) => !value)}
                        >
                          <Icon name={showKey ? "eye-off" : "eye"} extra="sm" />
                        </button>
                      </div>
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
                <h3>模型</h3>
                <p className="sec-desc">该 Provider 下的模型 — 角色与工作台按 <span className="chip-code">{editor.id || "provider-id"}/model-id</span> 引用。</p>
                <div className="seg" role="tablist" aria-label="模型来源" style={{ marginBottom: 10 }}>
                  <button type="button" role="tab" aria-selected={modelsTab === "catalog"} className={modelsTab === "catalog" ? "active" : undefined} onClick={() => setModelsTab("catalog")}>OMP Catalog</button>
                  {editor.discoveryType ? (
                    <button type="button" role="tab" aria-selected={modelsTab === "discovery"} className={modelsTab === "discovery" ? "active" : undefined} onClick={() => setModelsTab("discovery")}>Runtime Discovery</button>
                  ) : null}
                  <button type="button" role="tab" aria-selected={modelsTab === "custom"} className={modelsTab === "custom" ? "active" : undefined} onClick={() => setModelsTab("custom")}>Custom Models</button>
                </div>

                {modelsTab === "catalog" ? (() => {
                  const catalog = editor.models.filter((m) => m.source === "catalog" || m.source === "extension");
                  if (catalog.length === 0) {
                    return <div className="pm-empty"><Icon name="box" extra="sm" />该 Provider 暂无 OMP Catalog 模型</div>;
                  }
                  return catalog.map((model) => {
                    const sel = model.selector || `${editor.id}/${model.id}`;
                    return (
                      <div className={`mdl-edit${model.status !== "available" ? " is-off" : ""}`} key={sel}>
                        <div className="me-head">
                          <span className="mono">{model.id}</span>
                          <span className="muted small">{model.name}</span>
                          <span className="spacer" />
                          <button type="button" className="icon-btn small" title="编辑 Override" onClick={() => setModelEdit({ kind: "override", modelId: model.id, draft: blankOverrideForm(editor.modelOverrides[model.id]) })}><Icon name="pencil" extra="sm" /></button>
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
                    <div className="kv-row"><span className="k">Timeout（ms）</span><span className="v">
                      <input className="input mono" type="number" style={{ width: 120 }} value={editor.discoveryTimeoutMs ?? ""} onChange={(event) => {
                        const next = { ...editor };
                        if (event.target.value === "") delete next.discoveryTimeoutMs;
                        else next.discoveryTimeoutMs = Number(event.target.value);
                        setEditor(next);
                      }} />
                    </span></div>
                    <div className="kv-row">
                      <span className="k">探测 / 扫描</span>
                      <span className="v" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" className="btn small outline" disabled={busy || probing} onClick={() => void onProbe(editor.id, editor.endpointUrl || undefined, editor.apiKey || undefined, editor.discoveryType || undefined, editor.discoveryTimeoutMs)}>
                          {probing ? "探测中…" : "探测"}
                        </button>
                        <button type="button" className="btn small outline" disabled={busy} onClick={() => void refreshDiscovery()}>重新扫描</button>
                      </span>
                    </div>
                    {probeResult ? <DiscoveryResultBlock result={probeResult} /> : null}
                    <p className="sec-desc" style={{ marginTop: 8 }}>探测只读远端模型列表，不写盘。重新扫描会执行 <span className="chip-code">omp models refresh</span> 并刷新 models.db。</p>
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
                            <span className="mono">{model.id || "新模型"}</span>
                            <span className="muted small">{model.name}</span>
                            <span className="spacer" />
                            <button type="button" className="icon-btn small" title="编辑模型" onClick={() => setModelEdit({ kind: "custom", index, draft: blankCustomForm(model) })}><Icon name="pencil" extra="sm" /></button>
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
                            <button type="button" className="icon-btn small" title="删除模型" onClick={() => {
                              const models = editor.models.filter((_, i) => i !== index);
                              setEditor({ ...editor, models });
                            }}><Icon name="trash" extra="sm" /></button>
                          </div>
                          <ModelCaps model={model} />
                        </div>
                      );
                    })}
                    <button type="button" className="btn outline" onClick={() => setModelEdit({ kind: "add", draft: blankCustomForm() })}><Icon name="plus" extra="sm" />添加模型</button>
                  </>
                ) : null}
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

              <StructuredEditor
                language="yaml"
                value={modelsYmlValue}
                onChange={setModelsYmlDraft}
                allowEmpty={false}
                title={providerYamlId || "供应商代码块"}
                path={providerYamlId ? `models.yml · providers.${providerYamlId}` : "models.yml"}
                minHeight={320}
                maxHeight={420}
                dirty={modelsYmlDirty}
                saving={busy}
                saveDisabled={!providerYamlId || (!modelsYmlDirty && !providerFormDirty)}
                saveHint={!providerYamlId ? "先填写 Provider ID" : providerFormDirty ? "将同步表单" : ""}
                onSave={(text) => void persistModelsYml(text, providerFormDirty, false)}
              />

              <div className="mp-foot">
                <button type="button" className="btn outline" onClick={closeProviderEditor}>取消</button>
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
                  {testResult && testResult.source === "editor" ? (
                    <span className={`test-result inline ${testResult.ok ? "ok" : "fail"}`} role="status">
                      <Icon name={testResult.ok ? "check" : "alert"} extra="sm" />
                      <div className="tr-lines">
                        <b>{testResult.ok ? "连接成功" : "连接失败"}</b>
                        <span className="mono">{testResult.detail} · {testResult.latencyMs}ms</span>
                      </div>
                    </span>
                  ) : null}
                  <button type="button" className="btn outline" disabled={busy || testing} onClick={() => void onTest("editor", editExisting ? editor.id : undefined, editor.api, editor.endpointUrl, editor.apiKey || undefined)}>{testing ? "测试中…" : "测试连接"}</button>
                  <button type="submit" className="btn primary" disabled={busy}><Icon name="check" extra="sm" />{editExisting ? "保存修改" : "添加供应商"}</button>
                </span>
              </div>
            </form>

            </>
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
                <button type="button" className="btn primary" onClick={() => { setModelEdit(null); setEditor(blankDraft()); setEditExisting(false); setPresetOpen(false); setPresetSel(null); setConfirmDelete(false); setTestResult(null); }}><Icon name="plus" extra="sm" />添加供应商</button>
              </div>
              {!data && !loadError ? (
                <div className="pv-list is-pending" role="status">
                  <Icon name="refresh" extra="sm" />
                  <span>正在读取本机 OMP 配置…</span>
                </div>
              ) : (
              <>
              {filtered.length === 0 ? <div className="empty"><Icon name="search" />{providers.length === 0 ? "还没有供应商。添加一个或确认本机 omp 可用。" : "没有匹配的供应商"}</div> : null}
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
                        aria-label={`拖动调整 ${provider.name} 的显示顺序`}
                        title="拖动调整顺序"
                        onPointerDown={(event) => onProviderDragPointerDown(event, provider.id)}
                      />
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
                        <button type="button" className={`pv-act is-action${testing ? " is-testing" : ""}`} disabled={busy || testing} data-tip="测试连接" aria-label="测试连接" onClick={() => void onTest("list", provider.id)}><Icon name="pulse" /></button>
                        <button type="button" className="pv-act is-action" disabled={busy} data-tip="刷新模型（omp models refresh）" aria-label="刷新模型" onClick={() => void refreshDiscovery()}><Icon name="refresh" /></button>
                        <button type="button" className="pv-act is-action is-edit" data-tip="编辑供应商" aria-label="编辑供应商" onClick={() => { setModelEdit(null); setEditor(draftFromProvider(provider)); setEditExisting(true); setConfirmDelete(false); setTestResult(null); }}><Icon name="pencil" /></button>
                        <button type="button" className="pv-act is-action is-copy" data-tip="复制 Provider ID" aria-label="复制 Provider ID" onClick={() => { void navigator.clipboard.writeText(provider.id); toast(`已复制 ${provider.id}`); }}><Icon name="copy" /></button>
                        <span className="pv-act is-switch">
                          <button
                            type="button"
                            className={`switch${provider.enabled ? " on" : ""}`}
                            role="switch"
                            aria-checked={provider.enabled}
                            aria-label={provider.enabled ? `禁用 ${provider.name}` : `启用 ${provider.name}`}
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
                        {provider.models.length === 0 ? <div className="pm-empty"><Icon name="box" extra="sm" />暂无模型</div> : provider.models.map((model, index) => (
                          <div className={`pm-row${model.status !== "available" ? " is-off" : ""}`} key={model.selector} style={{ "--pm-i": index } as CSSProperties}>
                            <span className="pm-name"><span className={`dot ${model.status === "available" ? "green" : "amber"}`} />{model.name}</span>
                            <span className="pm-sel ellipsis">{model.selector}</span>
                            <span className="pm-meta">
                              <span className="chip gray xs">{fmtK(model.contextWindow)} ctx</span>
                              {model.image ? <span className="chip blue xs chip-icon" title="支持图片输入"><Icon name="image" extra="sm" /></span> : null}
                              {model.reasoning ? <span className="chip purple xs chip-icon" title="Reasoning"><Icon name="brain" extra="sm" /></span> : null}
                              {model.tools ? <span className="chip gray xs chip-icon" title="Tools"><Icon name="wrench" extra="sm" /></span> : null}
                            </span>
                            <button type="button" className="icon-btn small" title="复制 Model Selector" onClick={() => { void navigator.clipboard.writeText(model.selector); toast(`已复制 ${model.selector}`); }}><Icon name="copy" extra="sm" /></button>
                            {(model.source === "catalog" || model.source === "extension") ? (
                              <button type="button" className="icon-btn small" title="编辑 Override" onClick={() => {
                                setModelEdit({ kind: "override", modelId: model.id, draft: blankOverrideForm(provider.modelOverrides?.[model.id]), providerId: provider.id });
                              }}><Icon name="pencil" extra="sm" /></button>
                            ) : model.source === "custom" ? (
                              <button type="button" className="icon-btn small" title="编辑模型" onClick={() => {
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
                <h3>歧义模型供应商顺序 <span className="chip-code">modelProviderOrder</span></h3>
                <p className="sec-desc">当多个供应商提供同一 model-id 时，OMP 按此顺序选供应商。卡片拖拽只改本机显示顺序，不会写入这项。</p>
                {orderEdit ? (
                  <>
                    <div className="cycle-pool">
                      {orderDraft.map((id, index) => (
                        <span key={id} className="cycle-chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <span className="mono">{id}</span>
                          <button type="button" className="icon-btn small" disabled={index === 0} aria-label="上移" onClick={() => setOrderDraft((current) => {
                            if (index === 0) return current;
                            const next = current.slice();
                            const prev = next[index - 1]!;
                            next[index - 1] = next[index]!;
                            next[index] = prev;
                            return next;
                          })}><Icon name="arrow-l" extra="sm" /></button>
                          <button type="button" className="icon-btn small" disabled={index === orderDraft.length - 1} aria-label="下移" onClick={() => setOrderDraft((current) => {
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
                      <span className="cycle-pool-label">可加入</span>
                      {providers.filter((provider) => !orderDraft.includes(provider.id)).map((provider) => (
                        <button type="button" key={provider.id} className="btn small outline" onClick={() => setOrderDraft((current) => [...current, provider.id])}>{provider.name}</button>
                      ))}
                    </div>
                    <div className="cycle-edit-actions">
                      <button type="button" className="btn small primary" disabled={busy} onClick={() => void saveProviderOrder()}><Icon name="check" extra="sm" />保存顺序</button>
                      <button type="button" className="btn small outline" onClick={() => setOrderEdit(false)}>取消</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="cycle-flow">
                      {(data?.modelProviderOrder ?? []).length === 0 ? <span className="muted small">尚未设置</span> : (data?.modelProviderOrder ?? []).map((id, index) => (
                        <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          {index ? <span className="cycle-arrow"><Icon name="arrow-r" extra="sm" /></span> : null}
                          <span className="cycle-chip"><span className="mono">{id}</span></span>
                        </span>
                      ))}
                    </div>
                    <div style={{ marginTop: 12 }}><button type="button" className="btn small outline" onClick={() => { setOrderEdit(true); setOrderDraft([...(data?.modelProviderOrder ?? [])]); }}><Icon name="pencil" extra="sm" />编辑顺序</button></div>
                  </>
                )}
              </div>
            </>
          )}
            {modelEditView && modelEditHost ? createPortal(
              <div className={`modal-backdrop mc-model-modal${modelEditLeaving ? " is-leaving" : ""}`} role="presentation" onMouseDown={() => { if (!modelEditLeaving) setModelEdit(null); }}>
                <div className="modal" role="dialog" aria-modal="true" aria-label={modelEditView.kind === "override" ? "Model Override" : "编辑模型"} style={{ width: 600 }} onMouseDown={(event) => event.stopPropagation()}>
                  {modelEditView.kind === "override" ? (
                    <>
                      <div className="modal-head">Model Override · <span className="mono">{modelEditView.modelId}</span></div>
                      <div className="modal-body">
                        <p className="small muted" style={{ marginBottom: 10 }}>只覆盖需要修改的字段，其余继承 OMP Catalog。留空即不覆盖。</p>
                        <div className="f-grid">
                          <div className="field"><label>Name</label><input className="input" placeholder="继承" value={modelEditView.draft.name} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, name: e.target.value } })} /></div>
                          <div className="field"><label>Context Window</label><input className="input mono" type="number" placeholder="继承" value={modelEditView.draft.contextWindow} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, contextWindow: e.target.value } })} /></div>
                          <div className="field"><label>Max Tokens</label><input className="input mono" type="number" placeholder="继承" value={modelEditView.draft.maxTokens} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, maxTokens: e.target.value } })} /></div>
                          <div className="field"><label>Reasoning</label>
                            <select className="select" value={modelEditView.draft.reasoning} onChange={(e) => {
                              const reasoning = e.target.value as DraftOverrideForm["reasoning"];
                              setModelEdit({
                                ...modelEditView,
                                draft: {
                                  ...modelEditView.draft,
                                  reasoning,
                                  thinking: reasoning === "true" ? modelEditView.draft.thinking : [],
                                },
                              });
                            }}>
                              <option value="">继承</option><option value="true">开</option><option value="false">关</option>
                            </select>
                          </div>
                          <div className="field"><label>Tools</label>
                            <select className="select" value={modelEditView.draft.tools} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, tools: e.target.value as DraftOverrideForm["tools"] } })}>
                              <option value="">继承</option><option value="true">开</option><option value="false">关</option>
                            </select>
                          </div>
                          <div className="field"><label>Image Input</label>
                            <select className="select" value={modelEditView.draft.image} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, image: e.target.value as DraftOverrideForm["image"] } })}>
                              <option value="">继承</option><option value="true">开</option><option value="false">关</option>
                            </select>
                          </div>
                          {modelEditView.draft.reasoning === "true" ? (
                            <div className="field"><label>thinking effort</label>
                              <ThinkingEffortSelect
                                value={modelEditView.draft.thinking}
                                onChange={(thinking) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, thinking } })}
                              />
                            </div>
                          ) : null}
                          <div className="field span2"><label>Cost（$/M tokens，留空表示继承）</label>
                            <div className="cost-grid">
                              <input className="input mono" placeholder="Input" value={modelEditView.draft.costIn} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costIn: e.target.value } })} />
                              <input className="input mono" placeholder="Output" value={modelEditView.draft.costOut} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costOut: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Read" value={modelEditView.draft.costCacheR} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheR: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Write" value={modelEditView.draft.costCacheW} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheW: e.target.value } })} />
                            </div>
                          </div>
                        </div>
                        <details className="mp-advanced mc-model-adv">
                          <summary><span className="tw"><Icon name="chevron-r" extra="sm" /></span>高级设置 <span className="hint">Headers · Compaction · omitMaxOutputTokens</span></summary>
                          <div className="adv-body">
                            <div className="f-grid">
                              <div className="field"><label>Omit Max Output Tokens</label>
                                <select className="select" value={modelEditView.draft.omitMaxOutputTokens} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, omitMaxOutputTokens: e.target.value as DraftOverrideForm["omitMaxOutputTokens"] } })}>
                                  <option value="">继承</option><option value="true">开</option><option value="false">关</option>
                                </select>
                              </div>
                              <div className="field"><label>Premium Multiplier</label>
                                <input className="input mono" placeholder="继承" value={modelEditView.draft.premiumMultiplier} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, premiumMultiplier: e.target.value } })} />
                              </div>
                              <div className="field span2"><label>Headers（每行一个 Header: Value）</label>
                                <textarea className="input mono" rows={2} placeholder="留空继承供应商" value={modelEditView.draft.headersText} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, headersText: e.target.value } })} />
                              </div>
                              <div className="field"><label>Context Promotion Target</label>
                                <input className="input mono" placeholder="provider/model" value={modelEditView.draft.contextPromotionTarget} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, contextPromotionTarget: e.target.value } })} />
                              </div>
                              <div className="field"><label>Compaction Model</label>
                                <input className="input mono" placeholder="provider/model" value={modelEditView.draft.compactionModel} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, compactionModel: e.target.value } })} />
                              </div>
                              <div className="field"><label>Remote Compaction</label>
                                <select className="select" value={modelEditView.draft.rcEnabled} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcEnabled: e.target.value as DraftOverrideForm["rcEnabled"] } })}>
                                  <option value="">继承</option><option value="true">开</option><option value="false">关</option>
                                </select>
                              </div>
                              <div className="field"><label>Compaction Endpoint</label>
                                <input className="input mono" placeholder="继承" value={modelEditView.draft.rcEndpoint} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcEndpoint: e.target.value } })} />
                              </div>
                              <div className="field span2"><label>Compaction Model（remoteCompaction.model）</label>
                                <input className="input mono" placeholder="继承" value={modelEditView.draft.rcModel} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcModel: e.target.value } })} />
                              </div>
                            </div>
                          </div>
                        </details>
                      </div>
                      <div className="modal-foot">
                        <button type="button" className="btn outline" onClick={() => setModelEdit(null)}>取消</button>
                        <button type="button" className="btn primary" onClick={() => {
                          if (!modelEditHost) return;
                          const { next, parsed } = applyOverrideToDraft(modelEditHost, modelEditView.modelId, modelEditView.draft);
                          if (modelEditView.providerId) {
                            setModelEdit(null);
                            void persistProviderDraft(next, parsed ? "已保存 Override" : "已清除 Override");
                            return;
                          }
                          setEditor(next);
                          setModelEdit(null);
                          toast(parsed ? "已写入 Override（保存供应商后生效）" : "已清除 Override");
                        }}>保存 Override</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="modal-head">{modelEditView.kind === "add" ? "添加自定义模型" : <>编辑模型 · <span className="mono">{modelEditView.draft.id}</span></>}</div>
                      <div className="modal-body">
                        <div className="f-grid">
                          <div className="field"><label>Model ID</label>
                            <input className="input mono" value={modelEditView.draft.id} disabled={modelEditView.kind === "custom"} placeholder="如 gpt-example" onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, id: e.target.value } })} />
                          </div>
                          <div className="field"><label>显示名称</label>
                            <input className="input" value={modelEditView.draft.name} placeholder="如 GPT Example" onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, name: e.target.value } })} />
                          </div>
                          <div className="field span2"><label>API Type</label>
                            <select className="select" value={modelEditView.draft.api} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, api: e.target.value } })}>
                              <option value="inherit">Inherit Provider（跟随供应商）</option>
                              {MODEL_API_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                            </select>
                          </div>
                          <div className="field"><label>Context Window</label>
                            <input className="input mono" type="number" value={modelEditView.draft.contextWindow} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, contextWindow: e.target.value } })} />
                          </div>
                          <div className="field"><label>Max Output Tokens</label>
                            <input className="input mono" type="number" value={modelEditView.draft.maxTokens} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, maxTokens: e.target.value } })} />
                          </div>
                          <div className={`field${modelEditView.draft.reasoning ? "" : " span2"}`}>
                            <label>&nbsp;</label>
                            <div className="mc-caps-row">
                              <label className="desc">
                                <input type="checkbox" checked={modelEditView.draft.reasoning} onChange={(e) => {
                                  const reasoning = e.target.checked;
                                  setModelEdit({
                                    ...modelEditView,
                                    draft: {
                                      ...modelEditView.draft,
                                      reasoning,
                                      thinking: reasoning ? modelEditView.draft.thinking : [],
                                    },
                                  });
                                }} /> Reasoning
                              </label>
                              <label className="desc">
                                <input type="checkbox" checked={modelEditView.draft.tools} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, tools: e.target.checked } })} /> Tools
                              </label>
                              <label className="desc">
                                <input type="checkbox" checked={modelEditView.draft.image} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, image: e.target.checked } })} /> Image Input
                              </label>
                            </div>
                          </div>
                          {modelEditView.draft.reasoning ? (
                            <div className="field">
                              <label>thinking effort</label>
                              <ThinkingEffortSelect
                                value={modelEditView.draft.thinking}
                                onChange={(thinking) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, thinking } })}
                              />
                            </div>
                          ) : null}
                          <div className="field span2"><label>Cost（$/M tokens，留空表示未知）</label>
                            <div className="cost-grid">
                              <input className="input mono" placeholder="Input" value={modelEditView.draft.costIn} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costIn: e.target.value } })} />
                              <input className="input mono" placeholder="Output" value={modelEditView.draft.costOut} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costOut: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Read" value={modelEditView.draft.costCacheR} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheR: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Write" value={modelEditView.draft.costCacheW} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheW: e.target.value } })} />
                            </div>
                          </div>
                        </div>
                        <details className="mp-advanced mc-model-adv">
                          <summary><span className="tw"><Icon name="chevron-r" extra="sm" /></span>高级设置 <span className="hint">Base URL · Headers · Compaction · omitMaxOutputTokens</span></summary>
                          <div className="adv-body">
                            <div className="f-grid">
                              <div className="field span2"><label>Base URL <span className="muted">（可选，覆盖供应商）</span></label>
                                <input className="input mono" placeholder="留空跟随供应商" value={modelEditView.draft.baseUrl} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, baseUrl: e.target.value } })} />
                              </div>
                              <div className="kv-row span2" style={{ border: "none", padding: "4px 0" }}>
                                <span className="k">Omit Max Output Tokens</span>
                                <span className="v">
                                  <button type="button" className={`switch${modelEditView.draft.omitMaxOutputTokens ? " on" : ""}`} role="switch" aria-checked={modelEditView.draft.omitMaxOutputTokens} onClick={() => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, omitMaxOutputTokens: !modelEditView.draft.omitMaxOutputTokens } })} />
                                  <span className="desc">请求里不带 max tokens，本地预算仍用上面的值</span>
                                </span>
                              </div>
                              <div className="field"><label>Premium Multiplier</label>
                                <input className="input mono" placeholder="未设" value={modelEditView.draft.premiumMultiplier} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, premiumMultiplier: e.target.value } })} />
                              </div>
                              <div className="field span2"><label>Headers（每行一个 Header: Value）</label>
                                <textarea className="input mono" rows={2} placeholder="X-Model: value" value={modelEditView.draft.headersText} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, headersText: e.target.value } })} />
                              </div>
                              <div className="field"><label>Context Promotion Target</label>
                                <input className="input mono" placeholder="provider/model" value={modelEditView.draft.contextPromotionTarget} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, contextPromotionTarget: e.target.value } })} />
                              </div>
                              <div className="field"><label>Compaction Model</label>
                                <input className="input mono" placeholder="provider/model" value={modelEditView.draft.compactionModel} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, compactionModel: e.target.value } })} />
                              </div>
                              <div className="kv-row span2" style={{ border: "none", padding: "4px 0" }}>
                                <span className="k">Remote Compaction</span>
                                <span className="v">
                                  <button type="button" className={`switch${modelEditView.draft.rcEnabled ? " on" : ""}`} role="switch" aria-checked={modelEditView.draft.rcEnabled} onClick={() => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcEnabled: !modelEditView.draft.rcEnabled } })} />
                                  <span className="desc">由 Provider 端执行上下文压缩</span>
                                </span>
                              </div>
                              <div className="field"><label>Compaction Endpoint</label>
                                <input className="input mono" value={modelEditView.draft.rcEndpoint} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcEndpoint: e.target.value } })} />
                              </div>
                              <div className="field"><label>Remote Compaction Model</label>
                                <input className="input mono" value={modelEditView.draft.rcModel} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcModel: e.target.value } })} />
                              </div>
                            </div>
                          </div>
                        </details>
                      </div>
                      <div className="modal-foot">
                        <button type="button" className="btn outline" onClick={() => setModelEdit(null)}>取消</button>
                        <button type="button" className="btn primary" onClick={() => {
                          if (!modelEditHost) return;
                          const entry = entryFromCustomForm(modelEditHost.id || "provider-id", modelEditView.draft);
                          if (!entry) {
                            toast("请填写 Model ID");
                            return;
                          }
                          const models = modelEditHost.models.slice();
                          if (modelEditView.kind === "add") {
                            if (models.some((m) => m.source === "custom" && m.id === entry.id)) {
                              toast(`模型 ${entry.id} 已存在`);
                              return;
                            }
                            models.push(entry);
                          } else {
                            models[modelEditView.index] = entry;
                          }
                          const next = { ...modelEditHost, models };
                          if (modelEditView.providerId) {
                            setModelEdit(null);
                            void persistProviderDraft(next, modelEditView.kind === "add" ? "已添加模型" : "已保存模型");
                            return;
                          }
                          setEditor(next);
                          setModelsTab("custom");
                          setModelEdit(null);
                        }}>{modelEditView.kind === "add" ? "保存模型" : "保存修改"}</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            , document.body) : null}
          </div>
        </section>

        <section id="mcPanelRoles" role="tabpanel" aria-labelledby="mcTabRoles" hidden={shownTab !== "roles"} className={tabPanelClass("roles")}>
          <div className={roleLive ? `mc-view ${pagePhaseClass(rolePhase)}` : "mc-view"}>
          {roleDraft ? (
            <>
              <div className="mr-toolbar">
                <button type="button" className="icon-btn" onClick={closeRoleEditor}><Icon name="arrow-l" /></button>
                <b style={{ fontSize: "var(--fs-14)" }}>{roleDraft.name}</b>
                <span className="chip-code">{roleDraft.alias}</span>
                <span className={`chip ${roleDraft.builtin ? "gray" : "purple"} xs`}>{roleDraft.builtin ? "内置角色" : "自定义角色"}</span>
                <span className="chip blue xs">{roleDraft.scope === "project" ? "Project" : "Global"}</span>
                {!roleDraft.builtin ? (
                  <button type="button" className="btn small danger" disabled={busy} onClick={() => void deleteCustomRole(roleDraft.id)}>删除</button>
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
                  <h3>身份</h3>
                  <p className="sec-desc">写入全局 <span className="chip-code">modelTags</span>。id 是角色别名（<span className="chip-code">@{roleDraft.id || "id"}</span>）的来源。</p>
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
                      <span className="desc">小写字母开头，可含数字、连字符、下划线</span>
                    </div>
                    <div className="field">
                      <label htmlFor="role-name">名称</label>
                      <input className="input" id="role-name" value={roleDraft.name} onChange={(event) => setRoleDraft({ ...roleDraft, name: event.target.value })} />
                    </div>
                    <div className="field span2">
                      <label htmlFor="role-desc">说明</label>
                      <textarea className="input" id="role-desc" rows={2} value={roleDraft.desc} onChange={(event) => setRoleDraft({ ...roleDraft, desc: event.target.value })} />
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="mp-sec">
                <h3>模型路由</h3>
                <p className="sec-desc">角色只决定「用哪个模型、以什么思考强度」。写入当前 <span className="chip-code">modelRoles</span> 作用域（{data?.modelRoleStorage === "project" ? "项目" : "全局"}）。</p>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="k">Primary Model</span>
                    <span className="v">
                      <RoleModelPicker
                        value={roleDraft.primary}
                        groups={usableGroups}
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
                <h3>Fallback 链</h3>
                <p className="sec-desc">写入 <span className="chip-code">retry.fallbackChains</span>，按 Primary Model 的 selector 作为键。Recovery 对应 <span className="chip-code">retry.fallbackRevertPolicy</span>。</p>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="k">Recovery</span>
                    <span className="v">
                      <select
                        className="select"
                        value={revertPolicyDraft ?? data?.fallbackRevertPolicy ?? "cooldown-expiry"}
                        onChange={(event) => setRevertPolicyDraft(event.target.value as ModelFallbackRevertPolicy)}
                      >
                        <option value="cooldown-expiry">cooldown-expiry</option>
                        <option value="never">never</option>
                      </select>
                    </span>
                  </div>
                </div>
                <div className="cycle-pool" style={{ marginTop: 8 }}>
                  {(fallbackDraft ?? data?.fallbackChains[roleDraft.primary] ?? []).map((selector) => (
                    <span key={selector} className="cycle-chip">
                      <span className="mono">{selector}</span>
                      <span className="chip-remove" role="button" tabIndex={0} onClick={() => {
                        const current = fallbackDraft ?? data?.fallbackChains[roleDraft.primary] ?? [];
                        setFallbackDraft(current.filter((item) => item !== selector));
                      }}><Icon name="x" /></span>
                    </span>
                  ))}
                </div>
                <div className="cycle-pool">
                  <span className="cycle-pool-label">加入 Fallback</span>
                  {usable.filter((model) => model.selector !== roleDraft.primary && !(fallbackDraft ?? data?.fallbackChains[roleDraft.primary] ?? []).includes(model.selector)).slice(0, 12).map((model) => (
                    <button type="button" key={model.selector} className="btn small outline" onClick={() => {
                      const current = fallbackDraft ?? data?.fallbackChains[roleDraft.primary] ?? [];
                      setFallbackDraft([...current, model.selector]);
                    }}>{model.name}</button>
                  ))}
                </div>
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn small outline" disabled={busy || !roleDraft.primary} onClick={() => void saveFallback(roleDraft.primary)}>保存 Fallback</button>
                </div>
              </div>
              <StructuredEditor
                language="yaml"
                value={configYmlValue}
                onChange={setConfigYmlDraft}
                allowEmpty={false}
                title={roleDraft.id}
                path={`config.yml · modelRoles.${roleDraft.id}`}
                minHeight={280}
                maxHeight={400}
                dirty={configYmlDirty}
                saving={busy}
                saveDisabled={!configYmlDirty && !roleFormDirty}
                saveHint={roleFormDirty ? "将同步表单" : ""}
                onSave={(text) => void persistConfigYml(text, roleFormDirty, false)}
              />
              <div className="mp-foot">
                <button type="button" className="btn outline" onClick={closeRoleEditor}>返回</button>
                <span className="right"><button type="button" className="btn primary" disabled={busy} onClick={() => {
                  void (async () => {
                    if (configYmlDirty) {
                      const ok = await persistConfigYml(configYmlValue, true, !roleFormDirty);
                      if (!ok || !roleFormDirty) return;
                    }
                    await saveRole(roleDraft);
                  })();
                }}><Icon name="check" extra="sm" />保存到 {data?.modelRoleStorage === "project" ? "Project" : "Global"}</button></span>
              </div>
            </>
          ) : (
            <>
              <div className="mr-toolbar">
                <span className="seg" role="tablist" aria-label="角色作用域">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={(data?.modelRoleStorage ?? "global") === "global"}
                    className={(data?.modelRoleStorage ?? "global") === "global" ? "active" : undefined}
                    disabled={busy}
                    onClick={() => { if ((data?.modelRoleStorage ?? "global") !== "global") void setRoleStorage("global"); }}
                  >全局</button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={(data?.modelRoleStorage ?? "global") === "project"}
                    className={(data?.modelRoleStorage ?? "global") === "project" ? "active" : undefined}
                    disabled={busy || !data?.projectScopeAvailable}
                    title={data?.projectScopeAvailable ? undefined : "未打开工作区"}
                    onClick={() => { if (data?.projectScopeAvailable && (data?.modelRoleStorage ?? "global") !== "project") void setRoleStorage("project"); }}
                  >项目</button>
                </span>
                <b style={{ fontSize: "var(--fs-13)" }}>角色</b>
                <span className="mr-count">{roles.length} 个</span>
                <span className="spacer" />
                <button type="button" className="btn primary" onClick={() => setCreateRoleOpen(true)}><Icon name="plus" extra="sm" />创建自定义角色</button>
              </div>
              {createRoleOpen ? (
                <div className="preset-banner" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input className="input mono" placeholder="id（小写）" value={newRole.id} onChange={(event) => setNewRole({ ...newRole, id: event.target.value })} style={{ width: 140 }} />
                  <input className="input" placeholder="名称" value={newRole.name} onChange={(event) => setNewRole({ ...newRole, name: event.target.value })} style={{ width: 140 }} />
                  <input className="input" placeholder="说明（可选）" value={newRole.desc} onChange={(event) => setNewRole({ ...newRole, desc: event.target.value })} style={{ flex: 1, minWidth: 160 }} />
                  <button type="button" className="btn small primary" disabled={busy} onClick={() => void createCustomRole()}>创建</button>
                  <button type="button" className="btn small outline" onClick={() => setCreateRoleOpen(false)}>取消</button>
                </div>
              ) : null}
              {roles.map((role) => {
                const thinking = roleThinkingUi(role, availableBySelector.get(role.primary));
                return (
                <div className={`role-row${role.issue ? " has-issue" : ""}`} data-tint={ROLE_TINTS[role.id] ?? "purple"} key={role.id}>
                  <button type="button" className="role-row-nav" onClick={() => { setRoleId(role.id); setRoleDraft({ ...role }); }}>
                    <span className="role-icon-area"><span className={`a-ic${role.issue ? " amber" : ""}`}><Icon name={ROLE_ICONS[role.id] ?? "cpu"} extra="sm" /></span></span>
                    <span className="role-name-section">
                      <div className="role-header"><span className="r-name">{role.name}<span className="alias">{role.alias}</span></span>{role.scope === "project" ? <span className="chip blue xs">Project</span> : null}{role.builtin ? null : <span className="chip purple xs">自定义</span>}</div>
                      <span className="r-desc">{role.desc}</span>
                    </span>
                  </button>
                  <span className="role-model-section">
                    {role.issue ? <span className="role-model"><span className="model-name unavailable">{role.primary || "未分配"}</span></span> : (
                      <>
                        <RoleModelPicker
                          value={role.primary}
                          groups={usableGroups}
                          onChange={(primary) => { void saveRole(withRoleModel(role, primary, availableBySelector.get(primary))); }}
                        />
                        <select className="effort-select" value={thinking.value} disabled={thinking.disabled} aria-label="推理强度" onChange={(event) => {
                          const next = { ...role };
                          if (event.target.value === "off") delete next.thinking;
                          else next.thinking = event.target.value;
                          void saveRole(next);
                        }}>
                          {thinking.items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                      </>
                    )}
                    {!role.builtin ? (
                      <button
                        type="button"
                        className="role-delete"
                        aria-label={`删除 ${role.name}`}
                        disabled={busy}
                        onClick={(event) => { event.stopPropagation(); void deleteCustomRole(role.id); }}
                      >
                        <Icon name="trash" extra="sm" />
                      </button>
                    ) : null}
                  </span>
                  <button type="button" className="role-chevron" aria-label={`编辑 ${role.name}`} onClick={() => { setRoleId(role.id); setRoleDraft({ ...role }); }}>
                    <Icon name="chevron-r" extra="sm" />
                  </button>
                </div>
                );
              })}
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
          </div>
        </section>
        <section id="mcPanelSubagents" role="tabpanel" aria-labelledby="mcTabSubagents" hidden={shownTab !== "subagents"} className={tabPanelClass("subagents")}>
          <SubagentsPanel
            client={client}
            preview={preview}
            models={data}
            onCount={setAgentCount}
            {...(agentIntent === undefined ? {} : { initialAgent: agentIntent })}
          />
        </section>
      </div>
    </div>
  );
}
