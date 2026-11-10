import { AppSelect } from "../AppSelect";
import { WebRoleChain } from "./WebRoleChain";
import { explicitSearchChain, searchChain } from "./webSearchChain";
/**
 * Search-chain drafts and provider credential management.
 * Search settings use models.webSearch.set; API keys and selected credential
 * removal use the connected Runtime's native auth store. Preview stays local.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useListReorder } from "./useListReorder";
import { createPortal } from "react-dom";
import { modelAcceptsRole } from "@omp-studio/client-contract";
import type { ModelWebSearchSetInput, StudioClient, WebSearchConfigReadModel, WebSearchProviderRecord } from "@omp-studio/client-contract";
import { Brand, hasBrand } from "../brands";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { ToastHost } from "../ToastHost";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { credentialProviders, useSearchCredentials } from "./useSearchCredentials";

const TIMEOUT_OPTIONS = [30, 60, 120, 180, 300];

/* ── Provider brand mark: real logo, globe for the aggregate, letter fallback. ── */

function letterHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return hash;
}

function ProviderMark({ id }: { id: string }) {
  if (id === "public") {
    return <span className="wsx-pmark is-globe"><Icon name="globe" extra="sm" /></span>;
  }
  if (hasBrand(id)) {
    return <span className="wsx-pmark"><Brand id={id} /></span>;
  }
  return (
    <span className="wsx-pmark is-letter" style={{ background: `hsl(${letterHue(id)} 42% 38%)` }}>
      {id.charAt(0).toUpperCase()}
    </span>
  );
}

/* ── Draft ── */

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
  readonly sessionId?: string | undefined;
  readonly visible?: boolean;
  readonly onReadyCount?: (count: number) => void;
  readonly preview: boolean;
  readonly webSearch: WebSearchConfigReadModel;
  readonly models?: readonly import("@omp-studio/client-contract").AvailableModelRecord[];
  /** Real mode: whether in-app OAuth login is available on this Host. */
  readonly loginAvailable: boolean;
  /** Real mode: re-query the read model after a successful write. */
  readonly onSaved: () => void;
  /** Preview mode: update the demo read model in place. */
  readonly onPreviewSave: (next: WebSearchConfigReadModel) => void;
}

type CredState = "ready" | "missing" | "free" | "unknown";
type SearchProvider = WebSearchProviderRecord & { credentialUnknown?: boolean };
type PoolFilter = "all" | "ready" | "missing" | "free" | "excluded";

function credStateOf(provider: SearchProvider | undefined): CredState {
  if (!provider) return "missing";
  if (provider.hasCredential) return "ready";
  if (provider.credentialFree) return "free";
  return provider.credentialUnknown ? "unknown" : "missing";
}

export function WebSearchPanel({ client, preview, sessionId, visible = true, onReadyCount, webSearch, models = [], loginAvailable, onSaved, onPreviewSave }: WebSearchPanelProps) {
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const [draft, setDraft] = useState<Draft>(() => draftFromReadModel(webSearch));
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [routingDraft, setRoutingDraft] = useState(webSearch.routing);
  const [chainPickerId, setChainPickerId] = useState<string | null>(null);
  const [chainPickerSelector, setChainPickerSelector] = useState("");
  useEffect(() => { setRoutingDraft(webSearch.routing); }, [webSearch.routing]);
  const searchModels = useMemo(() => models.filter(model => modelAcceptsRole("web", model)), [models]);
  const choicesFor = (id: string) => searchModels.filter(model => model.provider === "web" && model.id === id || model.webSearch === id);
  const currentChain = routingDraft ? searchChain(routingDraft, searchModels) : [];
  const addToChain = (selector: string) => {
    setRoutingDraft(current => current ? explicitSearchChain(current, [...new Set([...searchChain(current, searchModels), selector])]) : current);
    setChainPickerId(null);
    setFlash(t("modelConfig.webSearchChainDraftUpdated"));
  };
  const chainButton = (selector: string) => <button type="button" className="btn small outline"
    disabled={!selector || currentChain.includes(selector)} onClick={() => addToChain(selector)}>
    {currentChain.includes(selector) ? <Icon name="check" extra="sm" /> : <Icon name="plus" extra="sm" />}
    {t(currentChain.includes(selector) ? "modelConfig.webSearchInChain" : "modelConfig.webSearchAddToChain")}
  </button>;
  const [poolQuery, setPoolQuery] = useState("");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [credModalId, setCredModalId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const credentials = useSearchCredentials(client, preview, sessionId, visible, webSearch.providers);
  const providers = useMemo<SearchProvider[]>(() => webSearch.providers.map(provider => {
    const ids = credentialProviders(provider);
    const states = ids.flatMap(id => credentials.statuses.get(id) ?? []);
    return { ...provider, hasCredential: states.some(row => row.configured),
      credentialUnknown: ids.length > 0 && !credentials.loaded };
  }), [webSearch.providers, credentials.statuses, credentials.loaded]);
  useEffect(() => { onReadyCount?.(providers.filter(provider => provider.credentialFree || provider.hasCredential).length); }, [providers, onReadyCount]);
  const credLabel = (state: CredState) => t(state === "ready" ? "modelConfig.webSearchCredReady" : state === "free" ? "modelConfig.webSearchCredFree" : state === "unknown" ? "modelConfig.webSearchCredUnknown" : "modelConfig.webSearchCredMissing");


  // Re-sync the draft when the read model changes (real save refresh).
  useEffect(() => {
    setDraft(draftFromReadModel(webSearch));
  }, [webSearch]);

  const orderRef = useRef(draft.order);
  orderRef.current = draft.order;
  const { listRef: chainListRef, draggingId, dragPhase, onPointerDown: onChainDragPointerDown } = useListReorder({
    order: draft.order, selector: ".wsx-chain-row", gap: 2, sortingClass: "is-wsx-sorting",
    onReorder(from, to) {
      const next = orderRef.current.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      setDraft(draft => ({ ...draft, order: next }));
    },
  });

  const byId = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

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
  const autoChain = providers.filter(
    (provider) => !inOrder.has(provider.id) && !inExclude.has(provider.id) && (provider.credentialFree || provider.hasCredential),
  );

  const credCounts = useMemo(() => {
    let ready = 0;
    let missing = 0;
    let free = 0;
    for (const provider of providers) {
      const cred = credStateOf(provider);
      if (cred === "ready") ready += 1;
      else if (cred === "free") free += 1;
      else if (cred === "missing") missing += 1;
    }
    return { ready, missing, free, excluded: draft.exclude.length };
  }, [providers, draft.exclude]);

  const libraryRows = useMemo(() => {
    const orderSet = new Set(draft.order);
    const excludeSet = new Set(webSearch.routing ? [] : draft.exclude);
    const query = poolQuery.trim().toLowerCase();
    return providers
      .filter((provider) => Boolean(webSearch.routing) || !orderSet.has(provider.id))
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
  }, [providers, webSearch.routing, poolQuery, poolFilter, draft.order, draft.exclude]);

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

  /* ── Credential modal actions. ── */

  const credModalProvider = credModalId !== null ? byId.get(credModalId) : undefined;

  const openCredModal = (id: string) => {
    setApiKeyDraft("");
    setCredModalId(id);
    void credentials.reload();
  };

  const runApiKeySave = async (provider: string) => {
    const apiKey = apiKeyDraft.trim();
    setApiKeyDraft("");
    if (await credentials.save(provider, apiKey)) setFlash(t("modelConfig.webSearchApiKeySaved"));
  };
  const runCredentialRemove = async (provider: string, credentialId: number) => {
    if (await credentials.remove(provider, credentialId)) setFlash(t("modelConfig.webSearchApiKeyRemoved"));
  };
  const runLogin = async (loginId: string) => {
    if (preview) { if (marks) setFlash(t("modelConfig.toastDemoLogin")); return; }
    setLoginBusy(true);
    try {
      const handle = await client.command("models.login.start", { providerId: loginId });
      await waitReceipt(client, handle.requestId);
      await credentials.reload();
      setFlash(t("modelConfig.webSearchLoginDone"));
    } catch (error) {
      setFlash(hostErrorMessage(error, t("modelConfig.toastLoginFailed", { providerId: loginId })));
    } finally { setLoginBusy(false); }
  };

  const copyEnvKeys = (keys: ReadonlyArray<string>) => {
    void navigator.clipboard.writeText(keys.join(", "));
    setFlash(t("modelConfig.webSearchEnvCopied"));
  };

  /* ── Save ── */

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
      if (marks) setFlash(t("modelConfig.demoYamlUpdated"));
      return;
    }
    setBusy(true);
    try {
      const input: ModelWebSearchSetInput = {
        enabled: draft.enabled,
        ...(webSearch.routing ? {} : { order: draft.order, exclude: draft.exclude, geminiModel: draft.geminiModel.trim() }),
        timeoutSeconds: draft.timeoutSeconds,
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

  const credModal = credModalProvider ? (() => {
    const provider = credModalProvider;
    const cred = credStateOf(provider);
    const envKeys = provider.envKeys ?? [];
    const states = credentialProviders(provider).flatMap(id => credentials.statuses.get(id) ?? []);
    const apiKeyId = provider.apiKeyId;
    const keyState = apiKeyId ? credentials.statuses.get(apiKeyId) : undefined;
    const loginState = provider.loginId ? credentials.statuses.get(provider.loginId) : undefined;
    const loginId = loginState && !loginState.apiKeyLogin ? provider.loginId : undefined;
    const source = states.find(state => state.configured);
    const kindLabel = source?.source ? t("modelConfig.webSearchSource_" + source.source) : null;
    const canEdit = credentials.available && credentials.loaded && !credentials.busy && !loginBusy;
    return (
      <div className="wsx-modal-backdrop" onClick={() => setCredModalId(null)}>
        <div
          className="wsx-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("modelConfig.webSearchCredModalTitle", { name: provider.name })}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="wsx-modal-head">
            <ProviderMark id={provider.id} />
            <div className="wsx-modal-title">
              <b>{t("modelConfig.webSearchCredModalTitle", { name: provider.name })}</b>
              <span className="wsx-provider-id">{provider.id}</span>
            </div>
            <button type="button" className="icon-btn small" aria-label={t("common.close")} onClick={() => setCredModalId(null)}><Icon name="x" extra="sm" /></button>
          </div>
          <div className="wsx-modal-body">
            <p className="wsx-modal-desc">{provider.description}</p>
            <div className="wsx-modal-status">
              <span>{t("modelConfig.webSearchCredStatus")}</span>
              <span className="wsx-modal-status-right">
                {kindLabel ? <span className="wsx-modal-kind">{kindLabel}</span> : null}
                <span className={`wsx-cred-chip is-${cred}`}>
                  {credLabel(cred)}
                </span>
              </span>
            </div>
            {!credentials.available && credentialProviders(provider).length > 0 ? <p className="wsx-modal-hint">{t("modelConfig.webSearchRuntimeRequired")}</p> : null}
            {credentials.error ? <p className="wsx-modal-error" role="alert">{credentials.error}</p> : null}
            {provider.credentialFree ? <p className="wsx-modal-hint">{t(apiKeyId ? "modelConfig.webSearchOptionalKey" : "modelConfig.webSearchFreeNoCred")}</p> : null}
            {apiKeyId ? (
              <div className="wsx-modal-keysec">
                <div className="wsx-modal-keyheading">
                  <label className="wsx-modal-keylabel" htmlFor="search-api-key">{t("modelConfig.webSearchApiKeyLabel")}</label>
                  {keyState?.keyUrl ? <button type="button" className="btn small" onClick={() => { if (!preview) void window.ompStudioChrome?.openUrl({ url: keyState.keyUrl! }); }}>{t("runtimeUpgrade.authWebsite")}<Icon name="external" extra="sm" /></button> : null}
                </div>
                <div className="wsx-modal-keyrow">
                  <input id="search-api-key" type="password" value={apiKeyDraft} disabled={!canEdit}
                    placeholder={t("modelConfig.webSearchApiKeyPlaceholder", { name: provider.name })}
                    autoComplete="new-password" onChange={event => setApiKeyDraft(event.target.value)} />
                  <button type="button" className="btn small primary" disabled={!canEdit || !apiKeyDraft.trim()} onClick={() => void runApiKeySave(apiKeyId)}>
                    {credentials.busy ? t("common.saving") : t("modelConfig.webSearchApiKeySave")}
                  </button>
                </div>
                <p className="wsx-modal-hint">{t("modelConfig.webSearchApiKeyHint")}</p>
              </div>
            ) : provider.id === "searxng" ? <p className="wsx-modal-hint">{t("modelConfig.webSearchSearxngHint")}</p> : null}
            {states.some(state => state.credentials.length > 0) ? (
              <div className="wsx-modal-saved">
                <b className="wsx-modal-keylabel">{t("modelConfig.webSearchStoredCredentials")}</b>
                {states.flatMap(state => state.credentials.map(row => (
                  <div className="wsx-modal-credential" key={state.provider + ":" + row.id}>
                    <span><b>{row.label}</b><small>{state.provider} · {row.type === "api_key" ? "API Key" : "OAuth"}</small></span>
                    <button type="button" className="btn small outline" disabled={!canEdit}
                      aria-label={t("modelConfig.webSearchRemoveCredential", { name: row.label })}
                      onClick={() => void runCredentialRemove(state.provider, row.id)}>{t("common.delete")}</button>
                  </div>
                )))}
                <p className="wsx-modal-hint">{t("modelConfig.webSearchRemoveHint")}</p>
              </div>
            ) : null}
            {provider.id === "ollama" ? <p className="wsx-modal-hint">{t("modelConfig.webSearchOllamaShared")}</p> : null}
            {loginId || envKeys.length > 0 ? (
              <div className="wsx-modal-alt">
                <span className="wsx-modal-alt-label">{t("modelConfig.webSearchOtherWays")}</span>
                {loginId ? <div className="wsx-modal-actions">
                  <button type="button" className="btn small outline" disabled={!canEdit || (!preview && !loginAvailable)} onClick={() => void runLogin(loginId)}>
                    {t("modelConfig.webSearchLogin")}
                  </button>
                  {!preview && !loginAvailable ? <span className="wsx-modal-hint">{t("modelConfig.webSearchLoginUnavailable", { id: loginId })}</span> : null}
                </div> : null}
                {envKeys.length > 0 ? <div className="wsx-modal-env">
                  <span>{t("modelConfig.webSearchEnvHint")}</span><code>{envKeys.join(" · ")}</code>
                  <button type="button" className="btn small outline" onClick={() => copyEnvKeys(envKeys)}><Icon name="copy" extra="sm" />{t("modelConfig.webSearchCopyEnv")}</button>
                </div> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  })() : null;

  return (
    <div className="wsx-panel">
      <section className={`wsx-hero${draft.enabled ? "" : " is-off"}`}>
        <div className="wsx-hero-head">
          <div className="wsx-hero-title">
            <div>
              <b>{t("modelConfig.webSearchHeroTitle")}</b>
              <span>{t("modelConfig.webSearchHeroSubtitle")}</span>
            </div>
          </div>
          <button
            type="button"
            className={`switch${draft.enabled ? " on" : ""}`}
            role="switch"
            aria-checked={draft.enabled}
            aria-label={t("modelConfig.webSearchEnabledLabel")}
            onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
          />
        </div>
        {webSearch.routing ? null : <div className="wsx-chain">
          <span className="wsx-chain-label">{t("modelConfig.webSearchChainTitle")}</span>
          {chainChips}
        </div>}
      </section>

      {routingDraft ? <WebRoleChain client={client} preview={preview} routing={routingDraft} onChange={setRoutingDraft} models={models} onSaved={onSaved} onPreviewSave={routing => onPreviewSave({ ...webSearch, routing })} /> : (
<section className="wsx-section">
        <div className="wsx-section-head">
          <div>
            <b>{t("modelConfig.webSearchPriorityTitle")}</b>
            <span className="wsx-sub">{t("modelConfig.webSearchPrioritySubtitle")}</span>
          </div>
        </div>
        <div
          className={`wsx-chain-list${draggingId && dragPhase === "dragging" ? " is-sorting" : ""}`}
          ref={chainListRef}
        >
          {priorityChain.map((provider, index) => {
            const dragging = draggingId === provider.id;
            const dragClass = dragging ? (dragPhase === "settling" ? " is-settling" : " is-dragging") : "";
            return (
              <div className={`wsx-chain-row${dragClass}`} data-id={provider.id} key={provider.id}>
                <button
                  type="button"
                  className="wsx-drag-handle"
                  aria-label={t("modelConfig.dragAdjustOrder", { name: provider.name })}
                  data-tip={t("modelConfig.drag")}
                  onPointerDown={(event) => onChainDragPointerDown(event, provider.id)}
                ><Icon name="grip" extra="sm" /></button>
                <span className="wsx-rank">{index + 1}</span>
                <ProviderMark id={provider.id} />
                <span className="wsx-provider-main">
                  <span className="wsx-provider-name">{provider.name}</span>
                  <span className="wsx-provider-id">{provider.id}</span>
                </span>
                <span className={`wsx-cred-chip is-${credStateOf(provider)}`}>
                  {credLabel(credStateOf(provider))}
                </span>
                <span className="wsx-row-actions">
                  <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="chevron-u" extra="sm" /></button>
                  <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveDown")} disabled={index === draft.order.length - 1} onClick={() => move(index, 1)}><Icon name="chevron-d" extra="sm" /></button>
                  <button type="button" className="icon-btn small" aria-label={t("modelConfig.webSearchConfigure")} data-tip={t("modelConfig.webSearchConfigure")} onClick={() => openCredModal(provider.id)}><Icon name="pencil" extra="sm" /></button>
                  <button type="button" className="icon-btn small" aria-label={t("modelConfig.webSearchRemoveFromChain", { name: provider.name })} onClick={() => removeOrder(provider.id)}><Icon name="x" extra="sm" /></button>
                </span>
              </div>
            );
          })}
        </div>
        {draft.order.length === 0 ? <div className="wsx-empty">{t("modelConfig.webSearchPriorityEmpty")}</div> : null}
      </section>
      )}

      <section className="wsx-section">
        <div className="wsx-section-head">
          <div>
            <b>{t("modelConfig.webSearchLibraryTitle")}</b>
            <span className="wsx-sub">{t("modelConfig.webSearchLibrarySubtitle", { count: webSearch.providers.length })}</span>
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
            ] as ReadonlyArray<[PoolFilter, string, number]>).filter(([key]) => !webSearch.routing || key !== "excluded").map(([key, label, count]) => (
              <button key={key} type="button" className={`chip-btn${poolFilter === key ? " active" : ""}`} aria-pressed={poolFilter === key} onClick={() => setPoolFilter(key)}>
                {label}<span className="chip gray xs">{count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="wsx-pool-list">
          {libraryRows.map((provider) => {
            const cred = credStateOf(provider);
            const excluded = !webSearch.routing && inExclude.has(provider.id);
            const choices = choicesFor(provider.id);
            return (
              <div className={`wsx-pool-row${excluded ? " is-excluded" : ""}`} key={provider.id}>
                <ProviderMark id={provider.id} />
                <span className="wsx-pool-id">
                  <span className="wsx-provider-name">{provider.name}</span>
                  <span className="wsx-provider-id">{provider.id}</span>
                </span>
                <span className="wsx-provider-desc" title={provider.description}>{provider.description}</span>
                <span className={`wsx-cred-chip is-${cred}`}>
                  {credLabel(cred)}
                </span>
                <span className="wsx-row-actions">
                  {webSearch.routing ? choices.length === 1 ? chainButton(choices[0]!.selector) : (
                    <button type="button" className="btn small outline" disabled={choices.length === 0 || choices.every(model => currentChain.includes(model.selector))}
                      data-tip={choices.length ? undefined : t("modelConfig.webSearchNoModels")}
                      onClick={() => { setChainPickerId(chainPickerId === provider.id ? null : provider.id); setChainPickerSelector(choices.find(model => !currentChain.includes(model.selector))!.selector); }}>
                      {t(!choices.length ? "modelConfig.webSearchNoModels" : choices.every(model => currentChain.includes(model.selector)) ? "modelConfig.webSearchInChain" : "modelConfig.webSearchAddToChain")}
                    </button>
                  ) : excluded ? (
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
                  <button type="button" className="btn small outline" onClick={() => openCredModal(provider.id)}><Icon name="key" extra="sm" />{t("modelConfig.webSearchConfigure")}</button>
                </span>
                {chainPickerId === provider.id ? <div className="wsx-pool-choice">
                  <AppSelect aria-label={t("modelConfig.webSearchChooseProviderModel", { name: provider.name })} value={chainPickerSelector} onChange={event => setChainPickerSelector(event.target.value)}>
                    {choices.filter(model => !currentChain.includes(model.selector)).map(model => <option value={model.selector} key={model.selector}>{model.name} · {model.selector}</option>)}
                  </AppSelect>
                  {chainButton(chainPickerSelector)}
                </div> : null}
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
            <AppSelect value={draft.timeoutSeconds} onChange={(event) => setDraft((d) => ({ ...d, timeoutSeconds: Number(event.target.value) }))}>
              {TIMEOUT_OPTIONS.map((value) => (
                <option key={value} value={value}>{value}s</option>
              ))}
            </AppSelect>
            <em>{t("modelConfig.webSearchTimeoutDesc")}</em>
          </div>
          {webSearch.routing ? null : <div className="wsx-field">
            <span>{t("modelConfig.webSearchGeminiLabel")}</span>
            <input
              value={draft.geminiModel}
              placeholder={t("modelConfig.webSearchGeminiPlaceholder")}
              onChange={(event) => setDraft((d) => ({ ...d, geminiModel: event.target.value }))}
            />
            <em>{t("modelConfig.webSearchGeminiDesc")}</em>
          </div>}
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
                <AppSelect
                  value={draft.searxngSafesearch === null ? "" : String(draft.searxngSafesearch)}
                  onChange={(event) => setDraft((d) => ({ ...d, searxngSafesearch: event.target.value === "" ? null : Number(event.target.value) }))}
                >
                  <option value="">{t("modelConfig.webSearchSafesearchDefault")}</option>
                  <option value="0">{t("modelConfig.webSearchSafesearch0")}</option>
                  <option value="1">{t("modelConfig.webSearchSafesearch1")}</option>
                  <option value="2">{t("modelConfig.webSearchSafesearch2")}</option>
                </AppSelect>
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

      {/* Portaled to <body>: page-transition ancestors carry transforms that
          would otherwise turn `position: fixed` into scroll-area positioning. */}
      {credModal ? createPortal(credModal, document.body) : null}

      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
    </div>
  );
}
