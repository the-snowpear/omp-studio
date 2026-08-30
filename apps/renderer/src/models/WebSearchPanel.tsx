/**
 * Web Search configuration panel (4th tab of the model-config page).
 *
 * Dual-zone layout mirroring the runtime's chain semantics: a hero card that
 * previews the *effective* chain (explicit `providers.webSearchOrder` first,
 * then the auto chain of credential-ready engines in built-in order), a
 * draggable priority-chain list, and a searchable provider library with
 * credential filters. Edits the OMP-native web search settings
 * (`web_search.enabled`, `providers.webSearch*`, `searxng.*`, `exa.*`);
 * all writes go through the single `models.webSearch.set` command, while
 * preview mode only mutates the demo read model.
 */

import { useEffect, useMemo, useState } from "react";
import type { ModelWebSearchSetInput, StudioClient, WebSearchConfigReadModel, WebSearchProviderRecord } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { ToastHost } from "../ToastHost";
import { hostErrorMessage, waitReceipt } from "../hostError";

const TIMEOUT_OPTIONS = [30, 60, 120, 180, 300];

interface Draft {
  enabled: boolean;
  order: string[];
  exclude: string[];
  timeoutSeconds: number;
  geminiModel: string;
  searxngEndpoint: string;
  searxngToken: string;
  searxngBasicUsername: string;
  searxngBasicPassword: string;
  searxngCategories: string;
  searxngEngines: string;
  searxngLanguage: string;
  /** null = instance default (the config key is deleted on save). */
  searxngSafesearch: number | null;
  exaEnabled: boolean;
  exaSearchDelayMs: number;
}

function draftFromReadModel(ws: WebSearchConfigReadModel): Draft {
  return {
    enabled: ws.enabled,
    order: [...ws.order],
    exclude: [...ws.exclude],
    timeoutSeconds: ws.timeoutSeconds,
    geminiModel: ws.geminiModel,
    searxngEndpoint: ws.advanced.searxng?.endpoint ?? "",
    searxngToken: "",
    searxngBasicUsername: ws.advanced.searxng?.basicUsername ?? "",
    searxngBasicPassword: "",
    searxngCategories: ws.advanced.searxng?.categories ?? "",
    searxngEngines: ws.advanced.searxng?.engines ?? "",
    searxngLanguage: ws.advanced.searxng?.language ?? "",
    searxngSafesearch: ws.advanced.searxng?.safesearch ?? null,
    exaEnabled: ws.advanced.exa?.enabled ?? true,
    exaSearchDelayMs: ws.advanced.exa?.searchDelayMs ?? 1000,
  };
}

function sameList(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

interface WebSearchPanelProps {
  readonly client: StudioClient;
  readonly preview: boolean;
  readonly webSearch: WebSearchConfigReadModel;
  /** Real mode: re-query the read model after a successful write. */
  readonly onSaved: () => void;
  /** Preview mode: update the demo read model in place. */
  readonly onPreviewSave: (next: WebSearchConfigReadModel) => void;
  /** Open the shared provider editor so search credentials use the same config surface. */
  readonly onEditProvider: (providerId: string) => void;
}

type CredState = "ready" | "missing" | "free";
type PoolFilter = "all" | "ready" | "missing" | "free" | "excluded";

function credStateOf(provider: WebSearchProviderRecord | undefined): CredState {
  if (!provider) return "missing";
  if (provider.credentialFree) return "free";
  return provider.hasCredential ? "ready" : "missing";
}

export function WebSearchPanel({ client, preview, webSearch, onSaved, onPreviewSave, onEditProvider }: WebSearchPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => draftFromReadModel(webSearch));
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [poolQuery, setPoolQuery] = useState("");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Re-sync the draft when the read model changes (real save refresh).
  useEffect(() => {
    setDraft(draftFromReadModel(webSearch));
  }, [webSearch]);

  const byId = useMemo(() => new Map(webSearch.providers.map((provider) => [provider.id, provider])), [webSearch.providers]);

  const dirty = useMemo(() => {
    const base = draftFromReadModel(webSearch);
    return (
      base.enabled !== draft.enabled
      || !sameList(base.order, draft.order)
      || !sameList(base.exclude, draft.exclude)
      || base.timeoutSeconds !== draft.timeoutSeconds
      || base.geminiModel !== draft.geminiModel
      || base.searxngEndpoint !== draft.searxngEndpoint
      || draft.searxngToken.length > 0
      || base.searxngBasicUsername !== draft.searxngBasicUsername
      || draft.searxngBasicPassword.length > 0
      || base.searxngCategories !== draft.searxngCategories
      || base.searxngEngines !== draft.searxngEngines
      || base.searxngLanguage !== draft.searxngLanguage
      || base.searxngSafesearch !== draft.searxngSafesearch
      || base.exaEnabled !== draft.exaEnabled
      || base.exaSearchDelayMs !== draft.exaSearchDelayMs
    );
  }, [draft, webSearch]);

  const inOrder = new Set(draft.order);
  const inExclude = new Set(draft.exclude);

  // Effective chain = explicit order, then credential-ready engines in
  // built-in catalog order (the runtime's auto chain for unlisted ids).
  const priorityChain = draft.order
    .map((id) => byId.get(id))
    .filter((provider): provider is WebSearchProviderRecord => Boolean(provider));
  const autoChain = webSearch.providers.filter(
    (provider) => !inOrder.has(provider.id) && !inExclude.has(provider.id) && (provider.credentialFree || provider.hasCredential),
  );

  // Library rows keep the catalog order; excluded rows sink below the rest.
  const credCounts = useMemo(() => {
    let ready = 0;
    let missing = 0;
    let free = 0;
    for (const provider of webSearch.providers) {
      const cred = credStateOf(provider);
      if (cred === "ready") ready += 1;
      else if (cred === "free") free += 1;
      else missing += 1;
    }
    return { ready, missing, free, excluded: draft.exclude.length };
  }, [webSearch.providers, draft.exclude]);

  const libraryRows = useMemo(() => {
    const orderSet = new Set(draft.order);
    const excludeSet = new Set(draft.exclude);
    const query = poolQuery.trim().toLowerCase();
    return webSearch.providers
      .filter((provider) => !orderSet.has(provider.id))
      .filter((provider) => {
        if (poolFilter === "excluded") return excludeSet.has(provider.id);
        // "all" keeps excluded rows visible (dimmed, sunk to the bottom).
        if (poolFilter === "all") return true;
        if (excludeSet.has(provider.id)) return false;
        const cred = credStateOf(provider);
        if (poolFilter === "ready") return cred === "ready";
        if (poolFilter === "missing") return cred === "missing";
        if (poolFilter === "free") return cred === "free";
        return true;
      })
      .filter((provider) => {
        if (!query) return true;
        return provider.name.toLowerCase().includes(query)
          || provider.id.includes(query)
          || provider.description.toLowerCase().includes(query);
      })
      .sort((left, right) => Number(excludeSet.has(left.id)) - Number(excludeSet.has(right.id)));
  }, [webSearch.providers, poolQuery, poolFilter, draft.order, draft.exclude]);

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= draft.order.length) return;
    const next = [...draft.order];
    [next[index], next[target]] = [next[target] ?? "", next[index] ?? ""];
    setDraft((d) => ({ ...d, order: next }));
  };
  const removeOrder = (id: string) => setDraft((d) => ({ ...d, order: d.order.filter((item) => item !== id) }));
  const promote = (id: string) => {
    setDraft((d) => ({ ...d, order: [...d.order, id], exclude: d.exclude.filter((item) => item !== id) }));
  };
  const addExclude = (id: string) => {
    if (inOrder.has(id) || inExclude.has(id)) return;
    setDraft((d) => ({ ...d, exclude: [...d.exclude, id] }));
  };
  const restore = (id: string) => setDraft((d) => ({ ...d, exclude: d.exclude.filter((item) => item !== id) }));
  const reorder = (sourceId: string, targetId: string) => {
    const source = draft.order.indexOf(sourceId);
    const target = draft.order.indexOf(targetId);
    if (source < 0 || target < 0 || source === target) return;
    const next = [...draft.order];
    const [moved] = next.splice(source, 1);
    if (moved) next.splice(target, 0, moved);
    setDraft((d) => ({ ...d, order: next }));
  };
  const dropProvider = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    const sourceIndex = draft.order.indexOf(sourceId);
    const targetIndex = draft.order.indexOf(targetId);
    if (sourceIndex >= 0 && targetIndex >= 0) {
      reorder(sourceId, targetId);
      return;
    }
    if (sourceIndex >= 0) {
      setDraft((d) => ({ ...d, order: [...d.order.filter((item) => item !== sourceId), sourceId] }));
      return;
    }
    const insertAt = targetIndex >= 0 ? targetIndex : draft.order.length;
    setDraft((d) => ({
      ...d,
      order: [...d.order.slice(0, insertAt), sourceId, ...d.order.slice(insertAt)],
      exclude: d.exclude.filter((item) => item !== sourceId),
    }));
  };

  const save = async () => {
    if (preview) {
      onPreviewSave({
        ...webSearch,
        enabled: draft.enabled,
        order: [...draft.order],
        exclude: [...draft.exclude],
        timeoutSeconds: draft.timeoutSeconds,
        geminiModel: draft.geminiModel.trim(),
        advanced: {
          searxng: {
            endpoint: draft.searxngEndpoint.trim(),
            tokenSet: (webSearch.advanced.searxng?.tokenSet ?? false) || draft.searxngToken.length > 0,
            basicUsername: draft.searxngBasicUsername.trim(),
            passwordSet: (webSearch.advanced.searxng?.passwordSet ?? false) || draft.searxngBasicPassword.length > 0,
            categories: draft.searxngCategories.trim(),
            engines: draft.searxngEngines.trim(),
            language: draft.searxngLanguage.trim(),
            ...(draft.searxngSafesearch !== null ? { safesearch: draft.searxngSafesearch } : {}),
          },
          exa: { enabled: draft.exaEnabled, searchDelayMs: draft.exaSearchDelayMs },
        },
      });
      setFlash(t("modelConfig.demoYamlUpdated"));
      return;
    }
    setBusy(true);
    try {
      const input: ModelWebSearchSetInput = {
        enabled: draft.enabled,
        order: draft.order,
        exclude: draft.exclude,
        timeoutSeconds: draft.timeoutSeconds,
        geminiModel: draft.geminiModel.trim(),
        searxng: {
          endpoint: draft.searxngEndpoint.trim(),
          token: draft.searxngToken,
          basicUsername: draft.searxngBasicUsername.trim(),
          basicPassword: draft.searxngBasicPassword,
          categories: draft.searxngCategories.trim(),
          engines: draft.searxngEngines.trim(),
          language: draft.searxngLanguage.trim(),
          safesearch: draft.searxngSafesearch,
        },
        exa: { enabled: draft.exaEnabled, searchDelayMs: draft.exaSearchDelayMs },
      };
      const handle = await client.command("models.webSearch.set", input as never);
      await waitReceipt(client, handle.requestId);
      setFlash(t("modelConfig.webSearchSaved"));
      onSaved();
    } catch (error) {
      setFlash(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => setDraft(draftFromReadModel(webSearch));

  const chainChips = (
    <div className={`wsx-chain-items${draft.enabled ? "" : " is-off"}`}>
      {priorityChain.map((provider, index) => (
        <span key={provider.id}>
          {index > 0 ? <span className="wsx-arrow">→</span> : null}
          <span className="wsx-chip is-priority" data-tip={provider.description}><b>{index + 1}</b>{provider.name}</span>
        </span>
      ))}
      {autoChain.length > 0 ? (
        <span className="wsx-chain-auto-group">
          {priorityChain.length > 0 ? <span className="wsx-arrow">→</span> : null}
          <span className="wsx-chain-auto-label">{t("modelConfig.webSearchChainAuto")}</span>
          {autoChain.map((provider) => (
            <span key={provider.id} className="wsx-chip is-auto" data-tip={provider.description}>{provider.name}</span>
          ))}
        </span>
      ) : null}
      {draft.enabled && priorityChain.length === 0 && autoChain.length === 0 ? (
        <span className="wsx-chain-warning"><Icon name="alert" extra="sm" />{t("modelConfig.webSearchChainEmpty")}</span>
      ) : null}
      {!draft.enabled ? <span className="wsx-chain-warning"><Icon name="alert" extra="sm" />{t("modelConfig.webSearchChainDisabled")}</span> : null}
    </div>
  );

  return (
    <div className="wsx-panel">
      <section className={`wsx-hero${draft.enabled ? "" : " is-off"}`}>
        <div className="wsx-hero-head">
          <div className="wsx-hero-title">
            <Icon name="globe" extra="sm" />
            <div>
              <b>{t("modelConfig.webSearchHeroTitle")}</b>
              <span>{t("modelConfig.webSearchHeroSubtitle")}</span>
            </div>
          </div>
          <label className="wsx-enabled-control">
            <span>{draft.enabled ? "ON" : "OFF"}</span>
            <button type="button" className={`switch${draft.enabled ? " on" : ""}`} role="switch" aria-checked={draft.enabled} aria-label={t("modelConfig.webSearchEnabledLabel")} onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))} />
          </label>
        </div>
        <div className="wsx-chain">
          <span className="wsx-chain-label">{t("modelConfig.webSearchChainTitle")}</span>
          {chainChips}
        </div>
      </section>

      <section className="wsx-section">
        <div className="wsx-section-head">
          <div>
            <b>{t("modelConfig.webSearchPriorityTitle")}</b>
            <span className="wsx-sub">{t("modelConfig.webSearchPrioritySubtitle")}</span>
          </div>
        </div>
        <div className="wsx-chain-list">
          {priorityChain.map((provider, index) => (
            <div
              className={`wsx-chain-row${draggingId === provider.id ? " is-dragging" : ""}${dragOverId === provider.id ? " is-drag-over" : ""}`}
              key={provider.id}
              draggable
              onDragStart={(event) => {
                if (!(event.target as HTMLElement).closest(".wsx-drag-handle")) { event.preventDefault(); return; }
                setDraggingId(provider.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", provider.id);
              }}
              onDragOver={(event) => { if (draggingId && draggingId !== provider.id) { event.preventDefault(); setDragOverId(provider.id); } }}
              onDrop={(event) => { event.preventDefault(); const source = draggingId ?? event.dataTransfer.getData("text/plain"); if (source) dropProvider(source, provider.id); setDraggingId(null); setDragOverId(null); }}
              onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
            >
              <button type="button" className="wsx-drag-handle" aria-label={t("modelConfig.dragAdjustOrder", { name: provider.name })} data-tip={t("modelConfig.drag")}><Icon name="grip" extra="sm" /></button>
              <span className="wsx-rank">{index + 1}</span>
              <span className="wsx-provider-main">
                <span className="wsx-provider-name">{provider.name}</span>
                <span className="wsx-provider-id">{provider.id}</span>
              </span>
              <span className={`wsx-cred-chip is-${credStateOf(provider)}`}>
                {credStateOf(provider) === "ready" ? t("modelConfig.webSearchCredReady") : credStateOf(provider) === "free" ? t("modelConfig.webSearchCredFree") : t("modelConfig.webSearchCredMissing")}
              </span>
              <span className="wsx-row-actions">
                <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="chevron-u" extra="sm" /></button>
                <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveDown")} disabled={index === draft.order.length - 1} onClick={() => move(index, 1)}><Icon name="chevron-d" extra="sm" /></button>
                <button type="button" className="icon-btn small" aria-label={t("modelConfig.webSearchRemoveFromChain", { name: provider.name })} onClick={() => removeOrder(provider.id)}><Icon name="x" extra="sm" /></button>
              </span>
            </div>
          ))}
        </div>
        {draft.order.length === 0 ? <div className="wsx-empty">{t("modelConfig.webSearchPriorityEmpty")}</div> : null}
      </section>

      <section className="wsx-section">
        <div className="wsx-section-head">
          <div>
            <b>{t("modelConfig.webSearchLibraryTitle")}</b>
            <span className="wsx-sub">{t("modelConfig.webSearchLibrarySubtitle")}</span>
          </div>
        </div>
        <div className="wsx-pool-toolbar">
          <label className="wsx-pool-search">
            <Icon name="search" extra="sm" />
            <input value={poolQuery} placeholder={t("modelConfig.webSearchSearchPlaceholder")} onChange={(event) => setPoolQuery(event.target.value)} />
          </label>
          <div className="wsx-pool-filters" role="group" aria-label={t("modelConfig.webSearchLibraryTitle")}>
            {([
              ["all", t("modelConfig.webSearchFilterAll"), webSearch.providers.length],
              ["ready", t("modelConfig.webSearchFilterReady"), credCounts.ready],
              ["missing", t("modelConfig.webSearchFilterMissing"), credCounts.missing],
              ["free", t("modelConfig.webSearchFilterFree"), credCounts.free],
              ["excluded", t("modelConfig.webSearchFilterExcluded"), credCounts.excluded],
            ] as ReadonlyArray<[PoolFilter, string, number]>).map(([key, label, count]) => (
              <button key={key} type="button" className={`chip-btn${poolFilter === key ? " active" : ""}`} aria-pressed={poolFilter === key} onClick={() => setPoolFilter(key)}>
                {label}<span className="chip gray xs">{count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="wsx-pool-list">
          {libraryRows.map((provider) => {
            const cred = credStateOf(provider);
            const excluded = inExclude.has(provider.id);
            return (
              <div className={`wsx-pool-row${excluded ? " is-excluded" : ""}`} key={provider.id}
                onDragOver={(event) => { if (draggingId && draggingId !== provider.id) { event.preventDefault(); setDragOverId(provider.id); } }}
                onDrop={(event) => { event.preventDefault(); const source = draggingId ?? event.dataTransfer.getData("text/plain"); if (source) dropProvider(source, provider.id); setDraggingId(null); setDragOverId(null); }}
              >
                <span className="wsx-pool-main">
                  <span className="wsx-provider-name">{provider.name} <span className="wsx-provider-id">{provider.id}</span></span>
                  <span className="wsx-provider-desc" title={provider.description}>{provider.description}</span>
                </span>
                <span className={`wsx-cred-chip is-${cred}`}>
                  {cred === "ready" ? t("modelConfig.webSearchCredReady") : cred === "free" ? t("modelConfig.webSearchCredFree") : t("modelConfig.webSearchCredMissing")}
                </span>
                <span className="wsx-row-actions">
                  {excluded ? (
                    <>
                      <span className="wsx-excluded-label">{t("modelConfig.webSearchExcludedLabel")}</span>
                      <button type="button" className="btn small outline" onClick={() => restore(provider.id)}><Icon name="refresh" extra="sm" />{t("modelConfig.webSearchRestore")}</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn small outline" onClick={() => promote(provider.id)}><Icon name="plus" extra="sm" />{t("modelConfig.webSearchPromote")}</button>
                      <button type="button" className="icon-btn small" aria-label={t("modelConfig.webSearchExclude", { name: provider.name })} data-tip={t("modelConfig.webSearchExclude", { name: provider.name })} onClick={() => addExclude(provider.id)}><Icon name="x" extra="sm" /></button>
                    </>
                  )}
                  <button type="button" className="btn small outline" data-tip={t("modelConfig.editProvider")} aria-label={t("modelConfig.editProvider")} onClick={() => onEditProvider(provider.id)}><Icon name="pencil" extra="sm" />{t("modelConfig.webSearchConfigure")}</button>
                </span>
              </div>
            );
          })}
          {libraryRows.length === 0 ? <div className="wsx-empty">{t("modelConfig.webSearchLibraryEmpty")}</div> : null}
        </div>
      </section>

      <section className="wsx-section wsx-params">
        <div className="wsx-section-head"><b>{t("modelConfig.webSearchParamsTitle")}</b></div>
        <div className="wsx-params-grid">
          <div className="wsx-field">
            <span>{t("modelConfig.webSearchTimeoutLabel")}</span>
            <select value={draft.timeoutSeconds} onChange={(event) => setDraft((d) => ({ ...d, timeoutSeconds: Number(event.target.value) }))}>
              {TIMEOUT_OPTIONS.map((value) => (
                <option key={value} value={value}>{value}s</option>
              ))}
            </select>
            <em>{t("modelConfig.webSearchTimeoutDesc")}</em>
          </div>
          <div className="wsx-field">
            <span>{t("modelConfig.webSearchGeminiLabel")}</span>
            <input
              value={draft.geminiModel}
              placeholder={t("modelConfig.webSearchGeminiPlaceholder")}
              onChange={(event) => setDraft((d) => ({ ...d, geminiModel: event.target.value }))}
            />
            <em>{t("modelConfig.webSearchGeminiDesc")}</em>
          </div>
        </div>
      </section>

      <section className="wsx-section wsx-advanced">
        <button type="button" className="wsx-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>
          <span className="tw"><Icon name="chevron-r" /></span>
          <b>{t("modelConfig.advancedSettingsSummary")}</b>
          <span className="wsx-sub">{t("modelConfig.webSearchAdvancedHint")}</span>
        </button>
        {advancedOpen ? (
          <div className="wsx-advanced-grid">
            <div className="wsx-adv-group">
              <b>{t("modelConfig.webSearchSearxngTitle")}</b>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngEndpoint")}</span>
                <input
                  value={draft.searxngEndpoint}
                  placeholder="https://search.example.com"
                  onChange={(event) => setDraft((d) => ({ ...d, searxngEndpoint: event.target.value }))}
                />
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngToken")}</span>
                <input
                  type="password"
                  value={draft.searxngToken}
                  placeholder={webSearch.advanced.searxng?.tokenSet ? t("modelConfig.webSearchSecretConfigured") : ""}
                  autoComplete="off"
                  onChange={(event) => setDraft((d) => ({ ...d, searxngToken: event.target.value }))}
                />
                {webSearch.advanced.searxng?.tokenSet ? <em>{t("modelConfig.webSearchSecretKeepHint")}</em> : null}
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngBasicUser")}</span>
                <input
                  value={draft.searxngBasicUsername}
                  autoComplete="off"
                  onChange={(event) => setDraft((d) => ({ ...d, searxngBasicUsername: event.target.value }))}
                />
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngBasicPass")}</span>
                <input
                  type="password"
                  value={draft.searxngBasicPassword}
                  placeholder={webSearch.advanced.searxng?.passwordSet ? t("modelConfig.webSearchSecretConfigured") : ""}
                  autoComplete="off"
                  onChange={(event) => setDraft((d) => ({ ...d, searxngBasicPassword: event.target.value }))}
                />
                {webSearch.advanced.searxng?.passwordSet ? <em>{t("modelConfig.webSearchSecretKeepHint")}</em> : null}
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngCategories")}</span>
                <input
                  value={draft.searxngCategories}
                  placeholder="general,it"
                  onChange={(event) => setDraft((d) => ({ ...d, searxngCategories: event.target.value }))}
                />
                <em>{t("modelConfig.webSearchSearxngCategoriesDesc")}</em>
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngEngines")}</span>
                <input
                  value={draft.searxngEngines}
                  placeholder="bing,duckduckgo"
                  onChange={(event) => setDraft((d) => ({ ...d, searxngEngines: event.target.value }))}
                />
                <em>{t("modelConfig.webSearchSearxngEnginesDesc")}</em>
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngLanguage")}</span>
                <input
                  value={draft.searxngLanguage}
                  placeholder="zh-CN"
                  onChange={(event) => setDraft((d) => ({ ...d, searxngLanguage: event.target.value }))}
                />
                <em>{t("modelConfig.webSearchSearxngLanguageDesc")}</em>
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchSearxngSafesearch")}</span>
                <select
                  value={draft.searxngSafesearch === null ? "" : String(draft.searxngSafesearch)}
                  onChange={(event) => setDraft((d) => ({ ...d, searxngSafesearch: event.target.value === "" ? null : Number(event.target.value) }))}
                >
                  <option value="">{t("modelConfig.webSearchSafesearchDefault")}</option>
                  <option value="0">{t("modelConfig.webSearchSafesearch0")}</option>
                  <option value="1">{t("modelConfig.webSearchSafesearch1")}</option>
                  <option value="2">{t("modelConfig.webSearchSafesearch2")}</option>
                </select>
              </label>
            </div>
            <div className="wsx-adv-group wsx-exa-group">
              <b>{t("modelConfig.webSearchExaTitle")}</b>
              <label className="wsx-toggle-row">
                <span className="wsx-toggle-text">
                  <b>{t("modelConfig.webSearchExaEnabled")}</b>
                </span>
                <button
                  type="button"
                  className={`switch${draft.exaEnabled ? " on" : ""}`}
                  role="switch"
                  aria-checked={draft.exaEnabled}
                  onClick={() => setDraft((d) => ({ ...d, exaEnabled: !d.exaEnabled }))}
                />
              </label>
              <label className="wsx-field">
                <span>{t("modelConfig.webSearchExaDelay")}</span>
                <input
                  type="number"
                  min={0}
                  value={draft.exaSearchDelayMs}
                  onChange={(event) => setDraft((d) => ({ ...d, exaSearchDelayMs: Number(event.target.value) }))}
                />
                <em>{t("modelConfig.webSearchExaDelayDesc")}</em>
              </label>
            </div>
          </div>
        ) : null}
      </section>

      <div className="wsx-foot">
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
        <button type="button" className="btn outline" disabled={!dirty || busy} onClick={reset}>
          {t("modelConfig.discard")}
        </button>
      </div>

      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
    </div>
  );
}
