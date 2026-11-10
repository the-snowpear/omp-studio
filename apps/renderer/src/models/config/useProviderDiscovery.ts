import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { useI18n } from "../../i18n";
import { usePreviewMode } from "../../preview/PreviewContext";
import { hostErrorMessage } from "../../hostError";
import { previewModelAdaptation } from "../../preview/modelAdaptationPreview";
import { createPreviewFetchedModels } from "../../preview/modelConfigFixtures";
import { candidatesToEntries, mergeImportedModels, toCandidates, type FetchedModelCandidate } from "../fetchedModels";
import { editorTestSecret, parseHeaders } from "./drafts";
import { runProbe } from "./commands";
import type { Draft, ModelsTab } from "./types";
export function useProviderDiscovery({ client, editorState, catalogVersion, setEditor, setModelsTab, toast }: {
  client: StudioClient; editorState: Draft | null; catalogVersion: string | undefined;
  setEditor: Dispatch<SetStateAction<Draft | null>>; setModelsTab: Dispatch<SetStateAction<ModelsTab>>; toast(text: string): void;
}) {
  const { t, resolvedLanguage } = useI18n();
  const { preview, marks } = usePreviewMode();
  const [fetching, setFetching] = useState(false);
  const fetchGeneration = useRef(0);
  const fetchIdentity = useRef("");
  const [fetchDetail, setFetchDetail] = useState<{ ok: boolean; text: string } | null>(null);
  const [candidates, setCandidates] = useState<FetchedModelCandidate[] | null>(null);
  const currentFetchIdentity = JSON.stringify([editorState?.id, editorState?.api, editorState?.endpointUrl]);
  fetchIdentity.current = currentFetchIdentity;
  useEffect(() => { fetchGeneration.current += 1; setCandidates(null); setFetching(false); }, [currentFetchIdentity]);
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
    const requestGeneration = ++fetchGeneration.current;
    const requestIdentity = fetchIdentity.current;
    const stillCurrent = () => requestGeneration === fetchGeneration.current && requestIdentity === fetchIdentity.current;
    const adaptFetched = async (models: readonly import("@omp-studio/client-contract").ModelDiscoveryModel[]) => {
      const matches = await Promise.all(models.map(async model => {
        const endpoint = { ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }), ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }), ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }) };
        const input = { providerId, api: draft.api, modelId: model.id, name: model.name, endpoint, ...(catalogVersion ? { catalogVersion } : {}) };
        const result = preview ? previewModelAdaptation(input) : await client.query("models.adaptation.resolve", input).catch(() => undefined);
        return [model.id, result] as const;
      }));
      return new Map(matches.filter((pair): pair is readonly [string, import("@omp-studio/client-contract").ModelAdaptationResult] => pair[1] !== undefined));
    };
    if (preview) {
      const demo = createPreviewFetchedModels();
      const matches = await adaptFetched(demo);
      if (!stillCurrent()) return;
      setCandidates(toCandidates(demo, draft.models, [], matches));
      setFetchDetail({ ok: true, text: marks ? t("modelConfig.detailDemoFetchNoHost", { count: demo.length }) : resolvedLanguage === "zh" ? `获取到 ${demo.length} 个模型` : `Fetched ${demo.length} models` });
      setModelsTab("custom");
      if (marks) toast(t("modelConfig.toastDemoAutoFetchNoHost"));
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
        advertisedReasoning: draft.advertisedReasoning !== false,
        ...(secret ? { apiKey: secret } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(draft.discoveryTimeoutMs === undefined ? {} : { timeoutMs: draft.discoveryTimeoutMs }),
      });
      if (!stillCurrent()) return;
      if (!result.ok) {
        setFetchDetail({ ok: false, text: `${result.detail} · ${result.latencyMs}ms` });
        return;
      }
      const matches = await adaptFetched(result.models);
      if (!stillCurrent()) return;
      const next = toCandidates(result.models, draft.models, [], matches);
      setCandidates(next);
      setModelsTab("custom");
      setFetchDetail({
        ok: true,
        text: next.length === 0
          ? t("modelConfig.detailEndpointEmptyList", { detail: result.detail, latencyMs: result.latencyMs })
          : t("modelConfig.detailFetchSuccessStats", { total: next.length, added: next.filter((item) => !item.existing).length, latencyMs: result.latencyMs }),
      });
    } catch (error) {
      if (stillCurrent()) setFetchDetail({ ok: false, text: hostErrorMessage(error, t("modelConfig.textFetchModelsFailed")) });
    } finally {
      if (stillCurrent()) setFetching(false);
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


  return { fetching, fetchDetail, setFetchDetail, candidates, setCandidates, onFetchModels, importCandidates };
}
