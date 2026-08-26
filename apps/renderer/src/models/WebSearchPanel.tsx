/**
 * Web Search configuration panel (4th tab of the model-config page).
 *
 * Edits the OMP-native web search settings: `web_search.enabled`,
 * `providers.webSearchOrder` / `webSearchExclude` / `webSearchTimeoutSeconds` /
 * `webSearchGeminiModel`, plus the advanced per-provider keys (`searxng.*`,
 * `exa.*`). All writes go through the single `models.webSearch.set` command;
 * in preview mode the panel only mutates the demo read model.
 */

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
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
}

type CredState = "ready" | "missing" | "free";

function credStateOf(provider: WebSearchProviderRecord | undefined): CredState {
  if (!provider) return "missing";
  if (provider.credentialFree) return "free";
  return provider.hasCredential ? "ready" : "missing";
}

export function WebSearchPanel({ client, preview, webSearch, onSaved, onPreviewSave }: WebSearchPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => draftFromReadModel(webSearch));
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Re-sync the draft when the read model changes (real save refresh).
  useEffect(() => {
    setDraft(draftFromReadModel(webSearch));
  }, [webSearch]);

  const known = useMemo(() => new Map(webSearch.providers.map((provider) => [provider.id, provider])), [webSearch]);

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
      || base.exaEnabled !== draft.exaEnabled
      || base.exaSearchDelayMs !== draft.exaSearchDelayMs
    );
  }, [draft, webSearch]);

  const inOrder = new Set(draft.order);
  const inExclude = new Set(draft.exclude);
  const orderCandidates = webSearch.providers.filter((provider) => !inOrder.has(provider.id) && !inExclude.has(provider.id));
  const excludeCandidates = webSearch.providers.filter((provider) => !inOrder.has(provider.id) && !inExclude.has(provider.id));

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= draft.order.length) return;
    const next = [...draft.order];
    [next[index], next[target]] = [next[target] ?? "", next[index] ?? ""];
    setDraft((d) => ({ ...d, order: next }));
  };
  const addOrder = (id: string) => {
    if (!id || inOrder.has(id) || inExclude.has(id)) return;
    setDraft((d) => ({ ...d, order: [...d.order, id] }));
  };
  const removeOrder = (id: string) => setDraft((d) => ({ ...d, order: d.order.filter((item) => item !== id) }));
  const addExclude = (id: string) => {
    if (!id || inOrder.has(id) || inExclude.has(id)) return;
    setDraft((d) => ({ ...d, exclude: [...d.exclude, id] }));
  };
  const removeExclude = (id: string) => setDraft((d) => ({ ...d, exclude: d.exclude.filter((item) => item !== id) }));

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
  const onPickOrder = (event: FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    if (value) addOrder(value);
    event.currentTarget.value = "";
  };
  const onPickExclude = (event: FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    if (value) addExclude(value);
    event.currentTarget.value = "";
  };

  return (
    <div className="ws-panel">
      <div className="ws-toggle-card">
        <label className="ws-toggle-row">
          <span className="ws-toggle-text">
            <b>{t("modelConfig.webSearchEnabled")}</b>
            <span>{t("modelConfig.webSearchEnabledDesc")}</span>
          </span>
          <button
            type="button"
            className={`switch${draft.enabled ? " on" : ""}`}
            role="switch"
            aria-checked={draft.enabled}
            onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
          />
        </label>
      </div>

      <div className="ws-section">
        <div className="ws-section-head">
          <b>{t("modelConfig.webSearchOrderTitle")}</b>
          <span className="ws-sub">{t("modelConfig.webSearchOrderSubtitle")}</span>
        </div>
        {draft.order.length === 0 ? (
          <div className="ws-empty">{t("modelConfig.webSearchOrderEmpty")}</div>
        ) : (
          <div className="ws-order-list">
            {draft.order.map((id, index) => {
              const provider = known.get(id);
              const cred = credStateOf(provider);
              return (
                <div className="ws-order-row" key={id}>
                  <span className="ws-rank">{index + 1}</span>
                  <span className="ws-name">{provider?.name ?? id}</span>
                  <span
                    className={`ws-cred ${cred === "ready" || cred === "free" ? "on" : ""}`}
                    data-tip={
                      cred === "free"
                        ? t("modelConfig.webSearchCredFree", { name: provider?.name ?? id })
                        : cred === "ready"
                          ? t("modelConfig.webSearchCredReady", { name: provider?.name ?? id })
                          : t("modelConfig.webSearchCredMissing", { name: provider?.name ?? id })
                    }
                  />
                  <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
                    <Icon name="chevron-u" extra="sm" />
                  </button>
                  <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveDown")} disabled={index === draft.order.length - 1} onClick={() => move(index, 1)}>
                    <Icon name="chevron-d" extra="sm" />
                  </button>
                  <button type="button" className="icon-btn small" aria-label={t("modelConfig.webSearchRemoveProvider", { name: provider?.name ?? id })} onClick={() => removeOrder(id)}>
                    <Icon name="x" extra="sm" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {orderCandidates.length > 0 && (
          <div className="ws-add-row">
            <select aria-label={t("modelConfig.webSearchAddProvider")} value="" onChange={onPickOrder}>
              <option value="">{t("modelConfig.webSearchAddProvider")}</option>
              {orderCandidates.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="ws-section">
        <div className="ws-section-head">
          <b>{t("modelConfig.webSearchExcludeTitle")}</b>
          <span className="ws-sub">{t("modelConfig.webSearchExcludeSubtitle")}</span>
        </div>
        <div className="ws-chips">
          {draft.exclude.length === 0 ? <span className="ws-empty-inline">{t("modelConfig.webSearchExcludeEmpty")}</span> : null}
          {draft.exclude.map((id) => (
            <span className="chip" key={id}>
              {known.get(id)?.name ?? id}
              <span className="chip-remove" role="button" tabIndex={0} aria-label={t("modelConfig.webSearchUnExclude", { name: known.get(id)?.name ?? id })} onClick={() => removeExclude(id)}>
                <Icon name="x" extra="sm" />
              </span>
            </span>
          ))}
          {excludeCandidates.length > 0 && (
            <select className="ws-chips-add" aria-label={t("modelConfig.webSearchAddExclude")} value="" onChange={onPickExclude}>
              <option value="">+ {t("modelConfig.webSearchAddExclude")}</option>
              {excludeCandidates.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="ws-section ws-grid">
        <label className="ws-field">
          <span>{t("modelConfig.webSearchTimeoutLabel")}</span>
          <select value={draft.timeoutSeconds} onChange={(event) => setDraft((d) => ({ ...d, timeoutSeconds: Number(event.target.value) }))}>
            {TIMEOUT_OPTIONS.map((value) => (
              <option key={value} value={value}>{value}s</option>
            ))}
          </select>
          <em>{t("modelConfig.webSearchTimeoutDesc")}</em>
        </label>
        <label className="ws-field">
          <span>{t("modelConfig.webSearchGeminiLabel")}</span>
          <input
            value={draft.geminiModel}
            placeholder={t("modelConfig.webSearchGeminiPlaceholder")}
            onChange={(event) => setDraft((d) => ({ ...d, geminiModel: event.target.value }))}
          />
          <em>{t("modelConfig.webSearchGeminiDesc")}</em>
        </label>
      </div>

      <details className="ws-adv">
        <summary>{t("modelConfig.advancedSettingsSummary")}</summary>
        <div className="ws-adv-body">
          <div className="ws-adv-group">
            <b>{t("modelConfig.webSearchSearxngTitle")}</b>
            <label className="ws-field">
              <span>{t("modelConfig.webSearchSearxngEndpoint")}</span>
              <input
                value={draft.searxngEndpoint}
                placeholder="https://search.example.com"
                onChange={(event) => setDraft((d) => ({ ...d, searxngEndpoint: event.target.value }))}
              />
            </label>
            <label className="ws-field">
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
            <label className="ws-field">
              <span>{t("modelConfig.webSearchSearxngBasicUser")}</span>
              <input
                value={draft.searxngBasicUsername}
                autoComplete="off"
                onChange={(event) => setDraft((d) => ({ ...d, searxngBasicUsername: event.target.value }))}
              />
            </label>
            <label className="ws-field">
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
          </div>
          <div className="ws-adv-group">
            <b>{t("modelConfig.webSearchExaTitle")}</b>
            <label className="ws-toggle-row">
              <span className="ws-toggle-text">
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
            <label className="ws-field">
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
      </details>

      <div className="ws-foot">
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
