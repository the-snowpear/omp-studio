import type { AvailableModelRecord, ModelCatalogEntry, ModelProviderRecord } from "@omp-studio/client-contract";
import { Brand, hasBrand } from "../brands";
import { Icon, type IconName } from "../icons";
import { useI18n } from "../i18n";

export const ROLE_ICONS: Record<string, IconName> = {
  default: "cpu", smol: "zap", slow: "brain", vision: "eye", plan: "layers",
  designer: "sparkles", commit: "commit", tiny: "box", task: "bot", advisor: "user",
  memory: "brain", image: "image", web: "globe", speech: "pulse", dictation: "pulse", judge: "check", widget: "layout",
};

/** 角色列表卡片的主题色（与 models-roles.css 的 .role-row[data-tint] 对应）。 */
export const ROLE_TINTS: Record<string, string> = {
  default: "purple", smol: "green", slow: "blue", vision: "violet", plan: "teal",
  designer: "pink", commit: "cyan", tiny: "lime", task: "orange", advisor: "indigo", widget: "green",
};

export type ModelPickItem = {
  readonly thinkingConfig?: AvailableModelRecord["thinkingConfig"];
  readonly execution?: import("@omp-studio/client-contract").ModelExecutionMetadata;
  readonly provider: string;
  readonly id: string;
  readonly selector: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly image: boolean;
  readonly tools: boolean;
  readonly contextWindow?: number;
};

export type ModelPickGroup = {
  readonly providerId: string;
  readonly providerName: string;
  readonly local: boolean;
  readonly models: ReadonlyArray<ModelPickItem>;
};

function toPickItem(model: AvailableModelRecord, entry?: ModelCatalogEntry): ModelPickItem {
  const contextWindow = entry?.contextWindow ?? model.contextWindow;
  return {
    execution: { ...model, ...entry },
    thinkingConfig: entry?.thinkingConfig ?? model.thinkingConfig,
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

export function ThinkingProbe({ config }: { config: AvailableModelRecord["thinkingConfig"] }) {
  const zh = useI18n().resolvedLanguage === "zh";
  if (!config) return null;
  const levels = thinkingLevels(config, zh);
  const pending = config.unverified === true;
  return <span className={`chip xs ${pending ? "gray" : "purple"}`} data-tip={pending ? (zh ? "运行时将在首次使用时探测思考档位" : "The runtime will probe thinking levels on first use") : levels}>
    <Icon name="brain" extra="xs" />{pending ? (zh ? "待探测" : "Awaiting probe") : levels}
  </span>;
}

function thinkingLevels(config: NonNullable<AvailableModelRecord["thinkingConfig"]>, zh: boolean): string {
  return [...(config.requiresEffort ? [] : [zh ? "关闭" : "Off"]), ...config.efforts].join(" · ");
}

export function ModelPickCopy({ model, unavailableReason }: { model: ModelPickItem; unavailableReason?: string }) {
  return (
    <span className="rms-option-copy">
      <b>{model.name}</b>
      {model.selector !== model.name ? <span>{model.selector}</span> : null}
      {unavailableReason ? <span>{unavailableReason}</span> : null}
    </span>
  );
}

export function ModelThinkingBadge({ model }: { model: Pick<ModelPickItem, "reasoning" | "thinkingConfig"> | undefined }) {
  const { t, resolvedLanguage } = useI18n();
  if (!model?.reasoning && !model?.thinkingConfig) return null;
  const label = t("modelConfig.tipThinking");
  const config = model.thinkingConfig;
  const zh = resolvedLanguage === "zh";
  const detail = config?.unverified
    ? (zh ? "运行时将在首次使用时探测思考档位" : "The runtime will probe thinking levels on first use")
    : config ? thinkingLevels(config, zh) : "";
  const tip = detail ? `${label}\n${detail}` : label;
  return (
    <span className={`chip ${config?.unverified ? "gray" : "purple"} xs chip-icon`} data-tip={tip}>
      <Icon name="brain" extra="sm" />
      <span className="sr-only">{tip}</span>
    </span>
  );
}

export function ModelPickCaps({ model }: { model: ModelPickItem }) {
  const { t, resolvedLanguage } = useI18n();
  const metadata = model.execution;
  const modelInfo = [t("modelConfig.tipContext"), metadata?.serviceTiers ? `${resolvedLanguage === "zh" ? "公布的服务档位" : "Advertised service tiers"}: ${metadata.serviceTiers.join(", ") || "—"}` : "", metadata?.promptCache ? `${resolvedLanguage === "zh" ? "缓存时长（秒）" : "Cache lifetime (seconds)"}: ${Object.entries(metadata.promptCache).map(([tier, seconds]) => `${tier} ${seconds}`).join(", ") || "—"}` : ""].filter(Boolean).join("\n");
  return (
    <span className="rms-option-caps">
      <ModelThinkingBadge model={model} />
      {model.image ? <span className="chip blue xs chip-icon" data-tip={t("modelConfig.tipMultimodal")}><Icon name="image" extra="sm" /></span> : null}
      {model.tools ? <span className="chip gray xs chip-icon" data-tip={t("modelConfig.tipTools")}><Icon name="wrench" extra="sm" /></span> : null}
      <span className="chip gray xs" data-tip={modelInfo}>{fmtK(model.contextWindow)}</span>
    </span>
  );
}

export function ProviderGlyph({ id, local = false }: { id: string; local?: boolean }) {
  if (id && hasBrand(id)) return <Brand id={id} extra="sm" />;
  return <Icon name={local ? "monitor" : "server"} extra="sm" />;
}

export function fmtK(n?: number): string {
  if (!n) return "—";
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
