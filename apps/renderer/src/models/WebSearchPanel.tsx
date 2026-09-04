/**
 * Web Search configuration panel (4th tab of the model-config page).
 *
 * Dual-zone layout mirroring the runtime's chain semantics: a hero card that
 * previews the *effective* chain (explicit `providers.webSearchOrder` first,
 * then the auto chain of credential-ready engines in built-in order), a
 * priority-chain list re-ordered with the same pointer-drag mechanics as the
 * provider cards, and a searchable provider library with credential filters
 * and real brand marks. Credentials are edited in an in-place modal (OAuth
 * login/logout via `models.login.*` plus env-var hints) instead of jumping
 * to the providers tab. All writes go through the single
 * `models.webSearch.set` command; preview mode only mutates the demo read
 * model.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ModelWebSearchSetInput, StudioClient, WebSearchConfigReadModel, WebSearchProviderRecord } from "@omp-studio/client-contract";
import { Brand, hasBrand } from "../brands";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { ToastHost } from "../ToastHost";
import { hostErrorMessage, waitReceipt } from "../hostError";

const TIMEOUT_OPTIONS = [30, 60, 120, 180, 300];

/* ── Pointer-drag re-ordering (same mechanics as the provider cards). ── */

const CHAIN_ROW_GAP = 2;
const CHAIN_DRAG_SETTLE_MS = 250;

type DragRow = {
  id: string;
  el: HTMLElement;
  relTop: number;
  height: number;
};

function siblingShift(index: number, origin: number, over: number, slot: number): number {
  if (origin < over && index > origin && index <= over) return -slot;
  if (origin > over && index >= over && index < origin) return slot;
  return 0;
}

function insertionIndex(items: ReadonlyArray<DragRow>, visualCenterRel: number): number {
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

function destinationTranslateY(items: ReadonlyArray<DragRow>, originIndex: number, overIndex: number): number {
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
    top += (heightById.get(id) ?? 0) + CHAIN_ROW_GAP;
  }
  return top - dragged.relTop;
}

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
  readonly preview: boolean;
  readonly webSearch: WebSearchConfigReadModel;
  /** Real mode: whether in-app OAuth login is available on this Host. */
  readonly loginAvailable: boolean;
  /** Real mode: re-query the read model after a successful write. */
  readonly onSaved: () => void;
  /** Preview mode: update the demo read model in place. */
  readonly onPreviewSave: (next: WebSearchConfigReadModel) => void;
}

type CredState = "ready" | "missing" | "free";
type PoolFilter = "all" | "ready" | "missing" | "free" | "excluded";

function credStateOf(provider: WebSearchProviderRecord | undefined): CredState {
  if (!provider) return "missing";
  if (provider.credentialFree) return "free";
  return provider.hasCredential ? "ready" : "missing";
}

export function WebSearchPanel({ client, preview, webSearch, loginAvailable, onSaved, onPreviewSave }: WebSearchPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => draftFromReadModel(webSearch));
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [poolQuery, setPoolQuery] = useState("");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [credModalId, setCredModalId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  // Re-sync the draft when the read model changes (real save refresh).
  useEffect(() => {
    setDraft(draftFromReadModel(webSearch));
  }, [webSearch]);

  /* ── Priority-chain pointer drag state. ── */
  const chainListRef = useRef<HTMLDivElement | null>(null);
  const dragLockRef = useRef(false);
  const settleGenRef = useRef(0);
  const clearDragStylesRef = useRef(false);
  const orderRef = useRef(draft.order);
  orderRef.current = draft.order;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragPhase, setDragPhase] = useState<"dragging" | "settling">("dragging");

  useLayoutEffect(() => {
    if (!clearDragStylesRef.current) return;
    clearDragStylesRef.current = false;
    const root = chainListRef.current;
    if (!root) return;
    const rows = root.querySelectorAll<HTMLElement>(".wsx-chain-row");
    for (const el of rows) {
      el.style.transition = "transform 0s";
      el.style.transform = "";
    }
    void root.offsetHeight;
    for (const el of rows) {
      el.style.removeProperty("transition");
      el.style.removeProperty("transform");
    }
  }, [draggingId, draft.order]);

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

  /** Pointer-drag a chain row to a new position (mirrors the provider cards). */
  const onChainDragPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    if (dragLockRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const root = chainListRef.current;
    if (!root) return;
    const listRect = root.getBoundingClientRect();
    const items: DragRow[] = [...root.querySelectorAll<HTMLElement>(".wsx-chain-row")].flatMap((el) => {
      const rowId = el.dataset.id;
      if (!rowId) return [];
      const rect = el.getBoundingClientRect();
      return [{ id: rowId, el, relTop: rect.top - listRect.top, height: rect.height }];
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
    document.body.classList.add("is-wsx-sorting");
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    const startY = event.clientY;
    const slot = dragged.height + CHAIN_ROW_GAP;
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
      document.body.classList.remove("is-wsx-sorting");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    };

    const movePointer = (next: PointerEvent) => {
      next.preventDefault();
      const dy = next.clientY - startY;
      dragged.el.style.transform = `translate3d(0, ${dy}px, 0)`;
      const nextOver = insertionIndex(items, dragged.relTop + dragged.height / 2 + dy);
      if (nextOver === overIndex) return;
      overIndex = nextOver;
      applyShifts(overIndex);
    };

    const up = () => {
      handle.removeEventListener("pointermove", movePointer);
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
        const next = orderRef.current.slice();
        const [moved] = next.splice(originIndex, 1);
        if (!moved) return;
        next.splice(overIndex, 0, moved);
        setDraft((d) => ({ ...d, order: next }));
      };

      window.setTimeout(finish, CHAIN_DRAG_SETTLE_MS);
    };

    handle.addEventListener("pointermove", movePointer);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  /* ── Credential modal actions. ── */

  const credModalProvider = credModalId !== null ? byId.get(credModalId) : undefined;

  const openCredModal = (id: string) => {
    setApiKeyDraft("");
    setCredModalId(id);
  };

  const setProviderCredential = (id: string, hasCredential: boolean, kind?: "api-key" | "oauth") => {
    onPreviewSave({
      ...webSearch,
      providers: webSearch.providers.map((provider) => {
        if (provider.id !== id) return provider;
        const { credentialKind: _previous, ...rest } = provider;
        return { ...rest, hasCredential, ...(kind !== undefined ? { credentialKind: kind } : {}) };
      }),
    });
  };

  const runApiKeySave = async (providerId: string) => {
    const apiKey = apiKeyDraft.trim();
    if (apiKey.length === 0) return;
    if (preview) {
      setProviderCredential(providerId, true, "api-key");
      setApiKeyDraft("");
      setFlash(t("modelConfig.webSearchApiKeySaved"));
      return;
    }
    setLoginBusy(true);
    try {
      const handle = await client.command("models.webSearch.credential.set", { providerId, apiKey } as never);
      await waitReceipt(client, handle.requestId);
      setApiKeyDraft("");
      setFlash(t("modelConfig.webSearchApiKeySaved"));
      onSaved();
    } catch (error) {
      setFlash(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setLoginBusy(false);
    }
  };

  const runApiKeyRemove = async (providerId: string) => {
    if (preview) {
      setProviderCredential(providerId, false);
      setFlash(t("modelConfig.webSearchApiKeyRemoved"));
      return;
    }
    setLoginBusy(true);
    try {
      const handle = await client.command("models.webSearch.credential.remove", { providerId } as never);
      await waitReceipt(client, handle.requestId);
      setFlash(t("modelConfig.webSearchApiKeyRemoved"));
      onSaved();
    } catch (error) {
      setFlash(hostErrorMessage(error, t("modelConfig.saveFailed")));
    } finally {
      setLoginBusy(false);
    }
  };

  const runLogin = async (loginId: string, id: string) => {
    if (preview) {
      setProviderCredential(id, true, "oauth");
      setFlash(t("modelConfig.toastDemoLogin"));
      return;
    }
    setLoginBusy(true);
    try {
      const handle = await client.command("models.login.start", { providerId: loginId } as never);
      await waitReceipt(client, handle.requestId);
      setFlash(t("modelConfig.webSearchLoginDone"));
      onSaved();
    } catch (error) {
      setFlash(hostErrorMessage(error, t("modelConfig.toastLoginFailed", { providerId: loginId })));
    } finally {
      setLoginBusy(false);
    }
  };

  const runLogout = async (loginId: string, id: string) => {
    if (preview) {
      setProviderCredential(id, false);
      setFlash(t("modelConfig.toastDemoLogout"));
      return;
    }
    setLoginBusy(true);
    try {
      const handle = await client.command("models.login.logout", { providerId: loginId } as never);
      await waitReceipt(client, handle.requestId);
      setFlash(t("modelConfig.webSearchLogoutDone"));
      onSaved();
    } catch (error) {
      setFlash(hostErrorMessage(error, t("modelConfig.toastLogoutFailed", { providerId: loginId })));
    } finally {
      setLoginBusy(false);
    }
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

  const credModal = credModalProvider ? (() => {
    const provider = credModalProvider;
    const cred = credStateOf(provider);
    const envKeys = provider.envKeys ?? [];
    const loginId = provider.loginId;
    const apiKeyId = provider.apiKeyId;
    const kindLabel = provider.credentialKind === "api-key"
      ? t("modelConfig.webSearchCredKindApiKey")
      : provider.credentialKind === "oauth"
        ? t("modelConfig.webSearchCredKindOauth")
        : provider.credentialKind === "env"
          ? t("modelConfig.webSearchCredKindEnv")
          : null;
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
                  {cred === "ready" ? t("modelConfig.webSearchCredReady") : cred === "free" ? t("modelConfig.webSearchCredFree") : t("modelConfig.webSearchCredMissing")}
                </span>
              </span>
            </div>
            {provider.credentialFree ? (
              <p className="wsx-modal-hint">{t("modelConfig.webSearchFreeNoCred")}</p>
            ) : (
              <>
                {apiKeyId !== undefined ? (
                  <div className="wsx-modal-keysec">
                    <span className="wsx-modal-keylabel">{t("modelConfig.webSearchApiKeyLabel")}</span>
                    <div className="wsx-modal-keyrow">
                      <input
                        type="password"
                        value={apiKeyDraft}
                        placeholder={t("modelConfig.webSearchApiKeyPlaceholder", { name: provider.name })}
                        autoComplete="off"
                        onChange={(event) => setApiKeyDraft(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={loginBusy || apiKeyDraft.trim().length === 0}
                        onClick={() => void runApiKeySave(provider.id)}
                      >
                        {t("modelConfig.webSearchApiKeySave")}
                      </button>
                      {provider.credentialKind === "api-key" ? (
                        <button type="button" className="btn small outline" disabled={loginBusy} onClick={() => void runApiKeyRemove(provider.id)}>
                          {t("modelConfig.webSearchApiKeyRemove")}
                        </button>
                      ) : null}
                    </div>
                    <p className="wsx-modal-hint">{t("modelConfig.webSearchApiKeyHint")}</p>
                  </div>
                ) : provider.id === "searxng" ? (
                  <p className="wsx-modal-hint">{t("modelConfig.webSearchSearxngHint")}</p>
                ) : null}
                {loginId !== undefined || envKeys.length > 0 ? (
                  <div className="wsx-modal-alt">
                    <span className="wsx-modal-alt-label">{t("modelConfig.webSearchOtherWays")}</span>
                    {loginId !== undefined ? (
                      <div className="wsx-modal-actions">
                        {cred === "ready" && provider.credentialKind !== "api-key" ? (
                          <button type="button" className="btn small outline" disabled={loginBusy} onClick={() => void runLogout(loginId, provider.id)}>
                            <Icon name="x" extra="sm" />{t("modelConfig.webSearchLogout")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn small outline"
                            disabled={loginBusy || (!preview && !loginAvailable)}
                            title={!preview && !loginAvailable ? t("modelConfig.webSearchLoginUnavailable", { id: loginId }) : undefined}
                            onClick={() => void runLogin(loginId, provider.id)}
                          >
                            {t("modelConfig.webSearchLogin")}
                          </button>
                        )}
                      </div>
                    ) : null}
                    {!preview && !loginAvailable && loginId !== undefined ? (
                      <p className="wsx-modal-hint">{t("modelConfig.webSearchLoginUnavailable", { id: loginId })}</p>
                    ) : null}
                    {envKeys.length > 0 ? (
                      <div className="wsx-modal-env">
                        <span>{t("modelConfig.webSearchEnvHint")}</span>
                        <code>{envKeys.join(" · ")}</code>
                        <button type="button" className="btn small outline" onClick={() => copyEnvKeys(envKeys)}>
                          <Icon name="copy" extra="sm" />{t("modelConfig.webSearchCopyEnv")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
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
                  {credStateOf(provider) === "ready" ? t("modelConfig.webSearchCredReady") : credStateOf(provider) === "free" ? t("modelConfig.webSearchCredFree") : t("modelConfig.webSearchCredMissing")}
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
              <div className={`wsx-pool-row${excluded ? " is-excluded" : ""}`} key={provider.id}>
                <ProviderMark id={provider.id} />
                <span className="wsx-pool-id">
                  <span className="wsx-provider-name">{provider.name}</span>
                  <span className="wsx-provider-id">{provider.id}</span>
                </span>
                <span className="wsx-provider-desc" title={provider.description}>{provider.description}</span>
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
                  <button type="button" className="btn small outline" onClick={() => openCredModal(provider.id)}><Icon name="pencil" extra="sm" />{t("modelConfig.webSearchConfigure")}</button>
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

      {/* Portaled to <body>: page-transition ancestors carry transforms that
          would otherwise turn `position: fixed` into scroll-area positioning. */}
      {credModal ? createPortal(credModal, document.body) : null}

      <ToastHost message={flash} onDismiss={() => setFlash(null)} />
    </div>
  );
}
