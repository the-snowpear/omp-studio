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
  ModelProviderProbeInput,
  ModelProviderRecord,
  ModelProviderRemoteCompaction,
  ModelProviderTestResult,
  ModelProviderUpsertInput,
  ModelRoleRecord,
  ModelRoleStorage,
  StudioClient,
} from "@omp-studio/client-contract";
import {
  clampRoleThinking,
  isModelEnvConfigName,
  MODEL_CONFIG_THINKING_EFFORTS,
  roleThinkingControl,
} from "@omp-studio/client-contract";
import { Brand, hasBrand } from "./brands";
import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { ToastHost } from "./ToastHost";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { pagePhaseClass, useDeferredKey, useDeferredPresence, useOverlayPresence } from "./pageTransition";
import { extractYamlMapEntry, mergeYamlMapEntry, parseStructured, StructuredEditor } from "./structured-editor";
import { usePreviewMode } from "./preview/PreviewContext";
import {
  MODEL_API_TYPES,
  MODEL_AUTH_TYPES,
  MODEL_THINKING,
  createPreviewFetchedModels,
  createPreviewModelConfig,
} from "./preview/modelConfigFixtures";
import {
  candidatesToEntries,
  type FetchedModelCandidate,
  mergeImportedModels,
  pickedCount,
  setAllPicked,
  toCandidates,
  togglePicked,
} from "./models/fetchedModels";
import { SubagentsPanel } from "./SubagentsPanel";
import { createPreviewAgentDefinitions } from "./preview/subagentsPreview";

export const MC_INTENT_KEY = "omp.modelConfigIntent";
const PROVIDER_ORDER_KEY = "omp.providerDisplayOrder";

type I18nT = ReturnType<typeof useI18n>["t"];

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
  const { t } = useI18n();
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
          <b>{result.ok ? t("modelConfig.connectSuccess") : t("modelConfig.connectFailed")}</b>
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

function confirmDiscardDirty(t: I18nT): boolean {
  return window.confirm(t("modelConfig.discardDirtyConfirm"));
}

function DiscoveryResultBlock({ result }: { result: ModelDiscoveryResult }) {
  const { t } = useI18n();
  return (
    <div className={`test-result ${result.ok ? "ok" : "fail"}`} role="status" style={{ marginTop: 10 }}>
      <Icon name={result.ok ? "check" : "alert"} extra="sm" />
      <div className="tr-lines">
        <b>{result.ok ? t("modelConfig.probeSuccess", { found: result.found, usable: result.usable }) : t("modelConfig.probeFailed")}</b>
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
  const { t } = useI18n();
  return (
    <span className="rms-option-caps">
      {model.reasoning ? <span className="chip purple xs chip-icon" data-tip={t("modelConfig.tipThinking")}><Icon name="brain" extra="sm" /></span> : null}
      {model.image ? <span className="chip blue xs chip-icon" data-tip={t("modelConfig.tipMultimodal")}><Icon name="image" extra="sm" /></span> : null}
      {model.tools ? <span className="chip gray xs chip-icon" data-tip={t("modelConfig.tipTools")}><Icon name="wrench" extra="sm" /></span> : null}
      <span className="chip gray xs" data-tip={t("modelConfig.tipContext")}>{fmtK(model.contextWindow)}</span>
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
  const { t } = useI18n();
  const selected = MODEL_CONFIG_THINKING_EFFORTS.filter((id) => value.includes(id));
  const label = selected.length > 0 ? selected.join(", ") : "low, medium, high…";

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
        data-tip={selected.length > 0 ? selected.join(", ") : t("modelConfig.tipThinking")}
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

function AuthTypeSelect({
  value,
  onChange,
}: {
  value: ModelAuthType;
  onChange: (next: ModelAuthType) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 280 });
  const { t } = useI18n();
  const selected = MODEL_AUTH_TYPES.find((item) => item.id === value) ?? MODEL_AUTH_TYPES[1];

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const next = thinkingMenuAnchor(btnRef.current, menuRef.current);
    setAnchor({ ...next, width: Math.max(next.width, 280) });
  }, [open, value]);

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

  const pick = (id: ModelAuthType) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="mc-select" style={{ maxWidth: 280 }}>
      <button
        ref={btnRef}
        type="button"
        className={`select mc-select-btn${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("modelConfig.authType")}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          if (btnRef.current) {
            const next = thinkingMenuAnchor(btnRef.current);
            setAnchor({ ...next, width: Math.max(next.width, 280) });
          }
          setOpen(true);
        }}
      >
        <span>{selected?.label ?? value}</span>
        <Icon name={open ? "chevron-u" : "chevron-d"} extra="sm" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="menu mc-select-menu"
              role="listbox"
              aria-label={t("modelConfig.authType")}
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {MODEL_AUTH_TYPES.map((item) => {
                const on = item.id === value;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`menu-item mc-select-option${on ? " is-on" : ""}`}
                    onClick={() => pick(item.id)}
                  >
                    <span className="mc-select-copy">
                      <b>{item.label}</b>
                      <span>{item.hint}</span>
                    </span>
                    {on ? <Icon name="check" extra="sm" /> : null}
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
  const { t } = useI18n();
  return (
    <span className="pm-meta">
      <span className="chip gray xs">{fmtK(model.contextWindow)} ctx</span>
      {model.maxTokens ? <span className="chip gray xs">{fmtK(model.maxTokens)} out</span> : null}
      {model.image ? <span className="chip blue xs chip-icon" data-tip={t("modelConfig.tipImage")}><Icon name="image" extra="sm" /></span> : null}
      {model.reasoning ? <span className="chip purple xs chip-icon" data-tip={t("modelConfig.tipThinking")}><Icon name="brain" extra="sm" /></span> : null}
      {model.tools ? <span className="chip gray xs chip-icon" data-tip={t("modelConfig.tipTools")}><Icon name="wrench" extra="sm" /></span> : null}
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
    envName: provider.auth.envName ?? `${provider.id.replace(/-/g, "_").toUpperCase()}_API_KEY`,
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
  input: ModelProviderProbeInput,
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

function editorTestSecret(editor: Draft): string | undefined {
  if (editor.authType === "api-key") return editor.apiKey.trim() || undefined;
  if (editor.authType === "env") return editor.envName.trim() || undefined;
  if (editor.authType === "command") return editor.command.trim() || undefined;
  return undefined;
}

function withPreviewLogin(record: ModelProviderRecord, current: ModelConfigReadModel): ModelProviderRecord {
  if (record.auth.type !== "oauth") return record;
  const login = current.loginProviders.find((item) => item.id === record.id);
  const existing = current.providers.find((item) => item.id === record.id);
  if (!login?.authenticated && !existing?.auth.hasSecret) return record;
  return {
    ...record,
    status: record.enabled ? "available" : record.status,
    statusDetail: "Logged in · Demo Account",
    auth: {
      ...record.auth,
      hasSecret: true,
      account: existing?.auth.account ?? "demo@local",
    },
  };
}

function previewProviderFromDraft(editor: Draft): ModelProviderRecord {
  return {
    id: editor.id.trim(),
    name: editor.name.trim(),
    source: "custom",
    status: editor.enabled ? "available" : "disabled",
    statusDetail: "Demo · Not written to Host",
    api: editor.api,
    ...(editor.endpointUrl ? { endpointUrl: editor.endpointUrl } : {}),
    local: editor.local,
    enabled: editor.enabled,
    ...(editor.website ? { website: editor.website } : {}),
    ...(editor.note ? { note: editor.note } : {}),
    auth: {
      type: editor.authType,
      hasSecret: editor.authType === "none"
        ? false
        : editor.authType === "env"
          ? Boolean(editor.envName.trim())
          : Boolean(editor.apiKey || editor.command),
      ...(editor.authType === "api-key" && editor.apiKey ? { apiKey: editor.apiKey } : {}),
      ...(editor.authType === "command" && editor.command
        ? { apiKey: editor.command.startsWith("!") ? editor.command : `!${editor.command}` }
        : {}),
      ...(editor.authType === "env" && editor.envName.trim() ? { envName: editor.envName.trim() } : {}),
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

function missingModelSaveError(labels: ReadonlyArray<string>, t?: (k: string, p?: any) => string): string {
  return t
    ? t("modelConfig.cannotSaveRoleNoPrimary", { labels: labels.join(", ") })
    : `Cannot save: role ${labels.join(", ")} has no primary model`;
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
  const { t } = useI18n();
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
        data-tip={t("modelConfig.tabRoles")}
        aria-label={t("modelConfig.selectRoles")}
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
              aria-label={t("modelConfig.selectRoles")}
              style={{ top: anchor.top, left: anchor.left }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="rap-head">
                <b>{t("modelConfig.selectRoles")}</b>
                <span className="mono">{selector}</span>
              </div>
              {roles.length === 0 ? (
                <div className="rap-empty">{t("modelConfig.noRoles")}</div>
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
                          {on
                            ? (wasCurrent ? t("modelConfig.current") : (role.primary || t("modelConfig.unassigned")))
                            : (wasCurrent ? t("modelConfig.willCancel") : (role.primary || t("modelConfig.unassigned")))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showSave || changeCount > 0 ? (
                <div className="rap-foot">
                  <span>{changeCount > 0 ? t("modelConfig.roleChangeCount", { count: changeCount }) : t("modelConfig.noChanges")}</span>
                  {showSave ? <button type="button" className="btn small primary" onClick={trySave}>{t("common.save")}</button> : <span className="rap-hint">{t("modelConfig.savedOnProviderSave")}</span>}
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
  const { t } = useI18n();
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

  const label = selected?.name || value || t("modelConfig.selectModel");
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
        aria-label={t("modelConfig.primaryModel")}
        data-tip={value || undefined}
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
              aria-label={t("modelConfig.pickByProvider")}
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {flat.length === 0 ? (
                <div className="rms-empty">{t("modelConfig.noAvailableModels")}</div>
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
                        <span>{t("modelConfig.currentNotInList")}</span>
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


const BUILTIN_ROLE_DESC_KEYS: Record<string, string> = {
  default: "modelConfig.roleDescDefault",
  smol: "modelConfig.roleDescFast",
  slow: "modelConfig.roleDescThinking",
  vision: "modelConfig.roleDescVision",
  plan: "modelConfig.roleDescArchitect",
  designer: "modelConfig.roleDescDesigner",
  commit: "modelConfig.roleDescCommit",
  tiny: "modelConfig.roleDescTiny",
  task: "modelConfig.roleDescSubtask",
  advisor: "modelConfig.roleDescAdvisor",
};

function formatRoleDesc(role: { id: string; desc: string; builtin?: boolean }, t: (k: string) => string): string {
  const key = BUILTIN_ROLE_DESC_KEYS[role.id];
  if (role.builtin && key) {
    return t(key);
  }
  return role.desc;
}


const PROVIDER_STATUS_DETAIL_KEYS: Record<string, string> = {
  "OMP 已解析到可用模型": "modelConfig.statusOmpResolved",
  "已从 models.yml 读取": "modelConfig.statusReadFromModelsYml",
  "已在 disabledProviders 中禁用": "modelConfig.statusDisabledInConfig",
  "已禁用": "modelConfig.statusDisabled",
  "尚未登录": "modelConfig.statusNotLoggedIn",
  "尚未配置凭据": "modelConfig.statusNoCredentials",
  "已登录 · 演示账号": "modelConfig.statusDemoAccount",
  "API Key 已保存": "modelConfig.statusApiKeySaved",
  "本地服务未运行": "modelConfig.statusLocalServiceNotRunning",
};

function formatProviderStatusDetail(detail: string | undefined, t: (k: string) => string): string {
  if (!detail) return "";
  if (PROVIDER_STATUS_DETAIL_KEYS[detail]) {
    return t(PROVIDER_STATUS_DETAIL_KEYS[detail]);
  }
  return detail;
}

export function ModelConfigPage({ client }: { client: StudioClient }) {
  const { t } = useI18n();
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
  const [fetching, setFetching] = useState(false);
  const [fetchDetail, setFetchDetail] = useState<{ ok: boolean; text: string } | null>(null);
  const [candidates, setCandidates] = useState<FetchedModelCandidate[] | null>(null);
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

    const sync = () => {
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
    };

    sync();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => sync());
      observer.observe(tabs);
      for (const btn of tabs.querySelectorAll('[role="tab"]')) {
        observer.observe(btn);
      }
      return () => observer.disconnect();
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
      toast(t("modelConfig.demoYamlUpdated"));
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
      toast(t("modelConfig.demoRoleYamlUpdated"));
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
      toast(roleUpdates.length > 0 ? t("modelConfig.demoUpdatedListAndRoles") : t("modelConfig.demoUpdatedList"));
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
      toast(t("modelConfig.demoOkMessage", { message: okMessage }));
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
      toast(t("modelConfig.demoRemoved"));
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
      toast(enabled ? t("modelConfig.demoEnabled", { name: provider.name }) : t("modelConfig.demoDisabled", { name: provider.name }));
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
      if (opts?.announce !== false) toast(t("modelConfig.demoAssignedRoles", { count: updates.length }));
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
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
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
      toast(t("modelConfig.demoRoleUpdated"));
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
      toast(t("modelConfig.savedToConfigToast"));
      setRoleId(null);
      setRoleDraft(null);
      await refresh();
    } catch (error) {
      toast(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const startLogin = async (providerId: string) => {
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
      toast(t("modelConfig.toastDemoLogin"));
      return;
    }
    if (!data?.loginAvailable) {
      toast(t("modelConfig.toastTerminalLogin", { providerId }));
      return;
    }
    setBusy(true);
    try {
      const result = await runWrite(client, "models.login.start", { providerId });
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
      toast(t("modelConfig.toastDemoLogout"));
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
        detail: t("modelConfig.detailDemoConnectHttp200"),
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
    detail: t("modelConfig.detailDemoProbeSuccess", { providerId }),
  });

  const onProbe = async (providerId: string, endpointUrl?: string, apiKey?: string, discoveryType?: string, timeoutMs?: number) => {
    if (preview) {
      setProbeResult(previewProbeResult(providerId));
      toast(t("modelConfig.toastDemoDiscoveryNoHost"));
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

  /**
   * Fetch the provider's model list over HTTP and offer it as a checklist.
   * Deliberately omits `discoveryType` so the Host picks the model-list URL and
   * auth header from the wire API — that is what makes this work for ordinary
   * providers that have no `discovery` block.
   */
  const onFetchModels = async (draft: Draft) => {
    // `editor` is the deferred-presence copy, so a click landing during the
    // editor's exit animation must not resurrect a closed form.
    if (editorState === null) return;
    const providerId = draft.id.trim();
    const endpointUrl = draft.endpointUrl.trim();
    if (!providerId || !endpointUrl) {
      toast(!providerId ? t("modelConfig.toastFillProviderIdFirst") : t("modelConfig.toastFillBaseUrlFirst"));
      return;
    }
    if (preview) {
      const demo = createPreviewFetchedModels();
      setCandidates(toCandidates(demo, draft.models, data?.availableModels ?? []));
      setFetchDetail({ ok: true, text: t("modelConfig.detailDemoFetchNoHost", { count: demo.length }) });
      setModelsTab("custom");
      toast(t("modelConfig.toastDemoAutoFetchNoHost"));
      return;
    }
    setFetching(true);
    setFetchDetail(null);
    setCandidates(null);
    try {
      const secret = editorTestSecret(draft);
      const headers = parseHeaders(draft.headersText);
      const result = await runProbe(client, {
        providerId,
        endpointUrl,
        api: draft.api,
        ...(secret ? { apiKey: secret } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(draft.discoveryTimeoutMs === undefined ? {} : { timeoutMs: draft.discoveryTimeoutMs }),
      });
      if (!result.ok) {
        setFetchDetail({ ok: false, text: `${result.detail} · ${result.latencyMs}ms` });
        return;
      }
      const next = toCandidates(result.models, draft.models, data?.availableModels ?? []);
      setCandidates(next);
      setModelsTab("custom");
      setFetchDetail({
        ok: true,
        text: next.length === 0
          ? t("modelConfig.detailEndpointEmptyList", { detail: result.detail, latencyMs: result.latencyMs })
          : t("modelConfig.detailFetchSuccessStats", { total: next.length, added: next.filter((item) => !item.existing).length, latencyMs: result.latencyMs }),
      });
    } catch (error) {
      setFetchDetail({ ok: false, text: hostErrorMessage(error, t("modelConfig.textFetchModelsFailed")) });
    } finally {
      setFetching(false);
    }
  };

  const importCandidates = (host: Draft, picked: ReadonlyArray<FetchedModelCandidate>) => {
    const entries = candidatesToEntries(host.id.trim(), picked);
    if (entries.length === 0) return;
    setEditor({ ...host, models: mergeImportedModels(host.models, entries) });
    setCandidates(null);
    setFetchDetail(null);
    setModelsTab("custom");
    toast(t("modelConfig.toastImportDraftModels", { count: entries.length }));
  };

  const refreshDiscovery = async () => {
    if (preview) {
      toast(t("modelConfig.toastDemoNoRefresh"));
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
      toast(storage === "project" ? t("modelConfig.toastDemoScopeProject") : t("modelConfig.toastDemoScopeGlobal"));
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
      toast(t("modelConfig.toastDemoCustomRoleCreated"));
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
      toast(t("modelConfig.toastDemoCustomRoleDeleted"));
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
      toast(t("modelConfig.toastDemoFallbackUpdated"));
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
      toast(t("modelConfig.toastDemoModelProviderOrderUpdated"));
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
      toast(t("modelConfig.toastDemoLocalOrderUpdated"));
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
      <a className="skip-link" href="#mcPanels">{t("common.skipToContent")}</a>
      <div className="mc-tabbar">
        <div className="mc-tabs" id="mcTabs" ref={mcTabsRef} role="tablist" aria-label={t("modelConfig.modelConfigView")} onKeyDown={onTabKey}>
          <button role="tab" id="mcTabProviders" aria-controls="mcPanelProviders" aria-selected={tab === "providers"} tabIndex={tab === "providers" ? 0 : -1} className={tab === "providers" ? "active" : undefined} onClick={() => activate("providers")}>
            <Icon name="server" extra="sm" /><span>{t("modelConfig.providersTab")}</span>
            <span className={`chip ${availCount === 0 && providers.length > 0 ? "amber" : "gray"} xs`}>{providers.length}<span className="sr-only"> {t("modelConfig.providersCountAria", { count: providers.length })}</span></span>
          </button>
          <button role="tab" id="mcTabRoles" aria-controls="mcPanelRoles" aria-selected={tab === "roles"} tabIndex={tab === "roles" ? 0 : -1} className={tab === "roles" ? "active" : undefined} onClick={() => activate("roles")}>
            <Icon name="steering" extra="sm" /><span>{t("modelConfig.rolesTab")}</span>
            <span className={`chip ${roleIssues ? "red" : "gray"} xs`}>{roles.length}<span className="sr-only"> {t("modelConfig.rolesCountAria", { count: roles.length })}</span></span>
          </button>
          <button role="tab" id="mcTabSubagents" aria-controls="mcPanelSubagents" aria-selected={tab === "subagents"} tabIndex={tab === "subagents" ? 0 : -1} className={tab === "subagents" ? "active" : undefined} onClick={() => activate("subagents")}>
            <Icon name="bot" extra="sm" /><span>{t("modelConfig.subagentsTab")}</span>
            <span className="chip gray xs">{agentCount}<span className="sr-only"> {t("modelConfig.subagentsCountAria", { count: agentCount })}</span></span>
          </button>
          <span className="mc-tab-window" ref={tabWinRef} aria-hidden="true">
            <span className="mc-tab-mirror" ref={tabMirrorRef}>
              <button type="button" tabIndex={-1}><Icon name="server" extra="sm" /><span>{t("modelConfig.providersTab")}</span><span className={`chip ${availCount === 0 && providers.length > 0 ? "amber" : "gray"} xs`}>{providers.length}<span className="sr-only"> {t("modelConfig.providersCountAria", { count: providers.length })}</span></span></button>
              <button type="button" tabIndex={-1}><Icon name="steering" extra="sm" /><span>{t("modelConfig.rolesTab")}</span><span className={`chip ${roleIssues ? "red" : "gray"} xs`}>{roles.length}<span className="sr-only"> {t("modelConfig.rolesCountAria", { count: roles.length })}</span></span></button>
              <button type="button" tabIndex={-1}><Icon name="bot" extra="sm" /><span>{t("modelConfig.subagentsTab")}</span><span className="chip gray xs">{agentCount}<span className="sr-only"> {t("modelConfig.subagentsCountAria", { count: agentCount })}</span></span></button>
            </span>
          </span>
        </div>
      </div>

      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
      {preview ? (
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
        <section id="mcPanelProviders" role="tabpanel" aria-labelledby="mcTabProviders" hidden={shownTab !== "providers"} className={tabPanelClass("providers")}>
          <div className={editorLive ? `mc-view ${pagePhaseClass(editorPhase)}` : "mc-view"}>
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
                    const account = data?.providers.find((item) => item.id === editor.id)?.auth.account;
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
                          <button type="button" className={`btn small ${authed ? "outline" : "primary"}`} disabled={busy} onClick={() => void startLogin(editor.id)}>
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
                                : preview
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
                <select className="select" style={{ maxWidth: 320 }} value={editor.api} onChange={(event) => setEditor({ ...editor, api: event.target.value })}>
                  {MODEL_API_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
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
                    {candidates.length === 0 ? (
                      <div className="pm-empty"><Icon name="box" extra="sm" />{t("modelConfig.endpointNoModels")}</div>
                    ) : candidates.map((item) => (
                      <label className={`pm-row mc-fetch-row${item.existing ? " is-off" : ""}`} key={item.id}>
                        <input type="checkbox" checked={item.picked} onChange={() => setCandidates(togglePicked(candidates, item.id))} />
                        <span className="pm-name">{item.name}</span>
                        <span className="pm-sel ellipsis">{`${editor.id || "provider"}/${item.id}`}</span>
                        <span className="pm-meta">
                          {item.contextWindow ? <span className="chip gray xs">{fmtK(item.contextWindow)} ctx</span> : null}
                          {item.maxTokens ? <span className="chip gray xs">{fmtK(item.maxTokens)} out</span> : null}
                          {item.image ? <span className="chip blue xs chip-icon" data-tip={t("modelConfig.badgeImage")}><Icon name="image" extra="sm" /></span> : null}
                          {item.reasoning ? <span className="chip purple xs chip-icon" data-tip={t("modelConfig.badgeReasoning")}><Icon name="brain" extra="sm" /></span> : null}
                          {item.enriched ? <span className="chip gray xs" data-tip={t("modelConfig.localEnrichedTip")}>{t("modelConfig.localEnriched")}</span> : null}
                          {item.existing ? <span className="chip gray xs">{t("modelConfig.alreadyExists")}</span> : null}
                        </span>
                      </label>
                    ))}
                    <div className="mc-fetch-foot">
                      {candidates.length > 0 ? (
                        <button type="button" className="btn small outline" onClick={() => setCandidates(setAllPicked(candidates, pickedCount(candidates) !== candidates.length))}>
                          {pickedCount(candidates) === candidates.length ? t("modelConfig.deselectAll") : t("modelConfig.selectAll")}
                        </button>
                      ) : null}
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
                      <select className="select" value={editor.transport} onChange={(event) => setEditor({ ...editor, transport: event.target.value as "" | "pi-native" })}>
                        <option value="">{t("modelConfig.httpSseDefault")}</option>
                        <option value="pi-native">pi-native</option>
                      </select>
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
                title={providerYamlId || t("modelConfig.providerYamlTitle")}
                path={providerYamlId ? `models.yml · providers.${providerYamlId}` : "models.yml"}
                minHeight={320}
                maxHeight={420}
                dirty={modelsYmlDirty}
                saving={busy}
                saveDisabled={!providerYamlId || (!modelsYmlDirty && !providerFormDirty)}
                saveHint={!providerYamlId ? t("modelConfig.fillProviderIdSaveHint") : providerFormDirty ? t("modelConfig.syncFormSaveHint") : ""}
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
                <button type="button" className="btn outline" disabled={preview} data-tip={preview ? t("common.demo") : undefined} onClick={() => void refresh()}><Icon name="refresh" extra="sm" />{t("modelConfig.refreshStatus")}</button>
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
                        <div className="pv-sub"><span className="pv-url ellipsis">{provider.endpointUrl || formatProviderStatusDetail(provider.statusDetail, t)}</span></div>
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
              <div className={`modal-backdrop mc-model-modal${modelEditLeaving ? " is-leaving" : ""}`} role="presentation" onMouseDown={() => { if (!modelEditLeaving) setModelEdit(null); }}>
                <div className="modal" role="dialog" aria-modal="true" aria-label={modelEditView.kind === "override" ? "Model Override" : t("modelConfig.editModel")} style={{ width: 600 }} onMouseDown={(event) => event.stopPropagation()}>
                  {modelEditView.kind === "override" ? (
                    <>
                      <div className="modal-head">Model Override · <span className="mono">{modelEditView.modelId}</span></div>
                      <div className="modal-body">
                        <p className="small muted" style={{ marginBottom: 10 }}>{t("modelConfig.overrideInheritCatalogDesc")}</p>
                        <div className="f-grid">
                          <div className="field"><label>Name</label><input className="input" placeholder={t("common.inherit")} value={modelEditView.draft.name} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, name: e.target.value } })} /></div>
                          <div className="field"><label>Context Window</label><input className="input mono" type="number" placeholder={t("common.inherit")} value={modelEditView.draft.contextWindow} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, contextWindow: e.target.value } })} /></div>
                          <div className="field"><label>Max Tokens</label><input className="input mono" type="number" placeholder={t("common.inherit")} value={modelEditView.draft.maxTokens} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, maxTokens: e.target.value } })} /></div>
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
                              <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                            </select>
                          </div>
                          <div className="field"><label>Tools</label>
                            <select className="select" value={modelEditView.draft.tools} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, tools: e.target.value as DraftOverrideForm["tools"] } })}>
                              <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                            </select>
                          </div>
                          <div className="field"><label>Image Input</label>
                            <select className="select" value={modelEditView.draft.image} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, image: e.target.value as DraftOverrideForm["image"] } })}>
                              <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
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
                          <div className="field span2"><label>{t("modelConfig.costTokensUnit")}</label>
                            <div className="cost-grid">
                              <input className="input mono" placeholder="Input" value={modelEditView.draft.costIn} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costIn: e.target.value } })} />
                              <input className="input mono" placeholder="Output" value={modelEditView.draft.costOut} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costOut: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Read" value={modelEditView.draft.costCacheR} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheR: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Write" value={modelEditView.draft.costCacheW} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheW: e.target.value } })} />
                            </div>
                          </div>
                        </div>
                        <details className="mp-advanced mc-model-adv">
                          <summary><span className="tw"><Icon name="chevron-r" extra="sm" /></span>{t("modelConfig.advancedSettings")} <span className="hint">Headers · Compaction · omitMaxOutputTokens</span></summary>
                          <div className="adv-body">
                            <div className="f-grid">
                              <div className="field"><label>Omit Max Output Tokens</label>
                                <select className="select" value={modelEditView.draft.omitMaxOutputTokens} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, omitMaxOutputTokens: e.target.value as DraftOverrideForm["omitMaxOutputTokens"] } })}>
                                  <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                                </select>
                              </div>
                              <div className="field"><label>Premium Multiplier</label>
                                <input className="input mono" placeholder={t("common.inherit")} value={modelEditView.draft.premiumMultiplier} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, premiumMultiplier: e.target.value } })} />
                              </div>
                              <div className="field span2"><label>{t("modelConfig.headersPerLine")}</label>
                                <textarea className="input mono" rows={2} placeholder={t("modelConfig.headersInheritPlaceholder")} value={modelEditView.draft.headersText} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, headersText: e.target.value } })} />
                              </div>
                              <div className="field"><label>Context Promotion Target</label>
                                <input className="input mono" placeholder="provider/model" value={modelEditView.draft.contextPromotionTarget} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, contextPromotionTarget: e.target.value } })} />
                              </div>
                              <div className="field"><label>Compaction Model</label>
                                <input className="input mono" placeholder="provider/model" value={modelEditView.draft.compactionModel} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, compactionModel: e.target.value } })} />
                              </div>
                              <div className="field"><label>Remote Compaction</label>
                                <select className="select" value={modelEditView.draft.rcEnabled} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcEnabled: e.target.value as DraftOverrideForm["rcEnabled"] } })}>
                                  <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                                </select>
                              </div>
                              <div className="field"><label>Compaction Endpoint</label>
                                <input className="input mono" placeholder={t("common.inherit")} value={modelEditView.draft.rcEndpoint} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcEndpoint: e.target.value } })} />
                              </div>
                              <div className="field span2"><label>Compaction Model（remoteCompaction.model）</label>
                                <input className="input mono" placeholder={t("common.inherit")} value={modelEditView.draft.rcModel} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcModel: e.target.value } })} />
                              </div>
                            </div>
                          </div>
                        </details>
                      </div>
                      <div className="modal-foot">
                        <button type="button" className="btn outline" onClick={() => setModelEdit(null)}>{t("common.cancel")}</button>
                        <button type="button" className="btn primary" onClick={() => {
                          if (!modelEditHost) return;
                          const { next, parsed } = applyOverrideToDraft(modelEditHost, modelEditView.modelId, modelEditView.draft);
                          if (modelEditView.providerId) {
                            setModelEdit(null);
                            void persistProviderDraft(next, parsed ? t("modelConfig.savedOverrideToast") : t("modelConfig.clearedOverrideToast"));
                            return;
                          }
                          setEditor(next);
                          setModelEdit(null);
                          toast(parsed ? t("modelConfig.writeOverrideToast") : t("modelConfig.clearedOverrideToast"));
                        }}>{t("modelConfig.saveOverride")}</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="modal-head">{modelEditView.kind === "add" ? t("modelConfig.addCustomModel") : <>{t("modelConfig.editModel")} · <span className="mono">{modelEditView.draft.id}</span></>}</div>
                      <div className="modal-body">
                        <div className="f-grid">
                          <div className="field"><label>Model ID</label>
                            <input className="input mono" value={modelEditView.draft.id} disabled={modelEditView.kind === "custom"} placeholder={t("modelConfig.modelIdPlaceholder")} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, id: e.target.value } })} />
                          </div>
                          <div className="field"><label>{t("modelConfig.displayName")}</label>
                            <input className="input" value={modelEditView.draft.name} placeholder={t("modelConfig.displayNamePlaceholder")} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, name: e.target.value } })} />
                          </div>
                          <div className="field span2"><label>API Type</label>
                            <select className="select" value={modelEditView.draft.api} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, api: e.target.value } })}>
                              <option value="inherit">{t("modelConfig.inheritProvider")}</option>
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
                          <div className="field span2"><label>{t("modelConfig.costTitle")}</label>
                            <div className="cost-grid">
                              <input className="input mono" placeholder="Input" value={modelEditView.draft.costIn} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costIn: e.target.value } })} />
                              <input className="input mono" placeholder="Output" value={modelEditView.draft.costOut} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costOut: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Read" value={modelEditView.draft.costCacheR} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheR: e.target.value } })} />
                              <input className="input mono" placeholder="Cache Write" value={modelEditView.draft.costCacheW} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, costCacheW: e.target.value } })} />
                            </div>
                          </div>
                        </div>
                        <details className="mp-advanced mc-model-adv">
                          <summary><span className="tw"><Icon name="chevron-r" extra="sm" /></span>{t("modelConfig.advancedSettings")} <span className="hint">{t("modelConfig.advancedSettingsHint")}</span></summary>
                          <div className="adv-body">
                            <div className="f-grid">
                              <div className="field span2"><label>{t("modelConfig.baseUrlOverride")}</label>
                                <input className="input mono" placeholder={t("modelConfig.baseUrlInheritPlaceholder")} value={modelEditView.draft.baseUrl} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, baseUrl: e.target.value } })} />
                              </div>
                              <div className="kv-row span2" style={{ border: "none", padding: "4px 0" }}>
                                <span className="k">Omit Max Output Tokens</span>
                                <span className="v">
                                  <button type="button" className={`switch${modelEditView.draft.omitMaxOutputTokens ? " on" : ""}`} role="switch" aria-checked={modelEditView.draft.omitMaxOutputTokens} onClick={() => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, omitMaxOutputTokens: !modelEditView.draft.omitMaxOutputTokens } })} />
                                  <span className="desc">{t("modelConfig.omitMaxOutputTokensDesc")}</span>
                                </span>
                              </div>
                              <div className="field"><label>Premium Multiplier</label>
                                <input className="input mono" placeholder={t("common.notSet")} value={modelEditView.draft.premiumMultiplier} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, premiumMultiplier: e.target.value } })} />
                              </div>
                              <div className="field span2"><label>{t("modelConfig.headersPerLine")}</label>
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
                                  <span className="desc">{t("modelConfig.remoteCompactionProviderDesc")}</span>
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
                        <button type="button" className="btn outline" onClick={() => setModelEdit(null)}>{t("common.cancel")}</button>
                        <button type="button" className="btn primary" onClick={() => {
                          if (!modelEditHost) return;
                          const entry = entryFromCustomForm(modelEditHost.id || "provider-id", modelEditView.draft);
                          if (!entry) {
                            toast(t("modelConfig.pleaseFillModelId"));
                            return;
                          }
                          const models = modelEditHost.models.slice();
                          if (modelEditView.kind === "add") {
                            if (models.some((m) => m.source === "custom" && m.id === entry.id)) {
                              toast(t("modelConfig.modelIdExists", { id: entry.id }));
                              return;
                            }
                            models.push(entry);
                          } else {
                            models[modelEditView.index] = entry;
                          }
                          const next = { ...modelEditHost, models };
                          if (modelEditView.providerId) {
                            setModelEdit(null);
                            void persistProviderDraft(next, modelEditView.kind === "add" ? t("modelConfig.addedModelToast") : t("modelConfig.savedModelToast"));
                            return;
                          }
                          setEditor(next);
                          setModelsTab("custom");
                          setModelEdit(null);
                        }}>{modelEditView.kind === "add" ? t("modelConfig.saveModel") : t("modelConfig.saveChanges")}</button>
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
                <h3>{t("modelConfig.fallbackChains")}</h3>
                <p className="sec-desc">{t("modelConfig.fallbackChainsDesc")}</p>
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
                  <span className="cycle-pool-label">{t("modelConfig.addToFallback")}</span>
                  {usable.filter((model) => model.selector !== roleDraft.primary && !(fallbackDraft ?? data?.fallbackChains[roleDraft.primary] ?? []).includes(model.selector)).slice(0, 12).map((model) => (
                    <button type="button" key={model.selector} className="btn small outline" onClick={() => {
                      const current = fallbackDraft ?? data?.fallbackChains[roleDraft.primary] ?? [];
                      setFallbackDraft([...current, model.selector]);
                    }}>{model.name}</button>
                  ))}
                </div>
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn small outline" disabled={busy || !roleDraft.primary} onClick={() => void saveFallback(roleDraft.primary)}>{t("modelConfig.saveFallback")}</button>
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
                saveHint={roleFormDirty ? t("modelConfig.syncFormHint") : ""}
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
                          groups={usableGroups}
                          onChange={(primary) => { void saveRole(withRoleModel(role, primary, availableBySelector.get(primary))); }}
                        />
                        <select className="effort-select" value={thinking.value} disabled={thinking.disabled} aria-label={t("modelConfig.thinkingEffort")} onChange={(event) => {
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
