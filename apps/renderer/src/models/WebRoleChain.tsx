import { useState } from "react";
import type { AvailableModelRecord, StudioClient, WebSearchRouting } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { useListReorder } from "./useListReorder";
import { explicitSearchChain, searchChain } from "./webSearchChain";

export function WebRoleChain({ client, preview, routing, models, onSaved, onPreviewSave, onChange }: {
  client: StudioClient; preview: boolean; routing: WebSearchRouting; models: readonly AvailableModelRecord[];
  onChange(next: WebSearchRouting): void;
  onSaved(): void; onPreviewSave(next: WebSearchRouting): void;
}) {
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chain = searchChain(routing, models);
  const changeOrder = (next: string[]) => onChange(explicitSearchChain(routing, next));
  const reorder = (from: number, to: number) => {
    const next = [...chain];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    changeOrder(next);
  };
  const { listRef, draggingId, dragPhase, onPointerDown } = useListReorder({
    order: chain, selector: ".wsx-chain-row", gap: 2, sortingClass: "is-wsx-sorting", onReorder: reorder,
  });
  const save = async () => {
    if (preview) { onPreviewSave({ ...routing, migratedLegacy: false }); return; }
    setBusy(true); setError("");
    try {
      const handle = await client.command("models.webSearch.set", { routing: { primary: routing.primary, fallbacks: routing.fallbacks } });
      await waitReceipt(client, handle.requestId); onSaved();
    } catch (cause) { setError(hostErrorMessage(cause, t("modelConfig.saveFailed"))); }
    finally { setBusy(false); }
  };
  return <section className="wsx-section">
    <div className="wsx-chain-heading">
      <div className="wsx-section-head">
        <b>{t("modelConfig.webSearchChainTitle")}</b>
        <span className="wsx-sub">{t("modelConfig.webSearchOrderedChainHint")}</span>
      </div>
      {preview && marks ? <span className="chip gray">{t("common.demo")}</span> : null}
      <button type="button" className="btn small" disabled={busy || !routing.primary && routing.fallbacks === null}
        onClick={() => onChange({ ...routing, primary: "", fallbacks: null })}>{t("modelConfig.webSearchResetChain")}</button>
    </div>
    <div ref={listRef} className={`wsx-chain-list${draggingId && dragPhase === "dragging" ? " is-sorting" : ""}`}>
      {chain.map((selector, index) => {
        const model = models.find(row => row.selector === selector);
        const dragging = draggingId === selector;
        return <div className={`wsx-chain-row${dragging ? dragPhase === "settling" ? " is-settling" : " is-dragging" : ""}`} data-id={selector} key={selector}>
          <button type="button" className="wsx-drag-handle" disabled={busy}
            aria-label={t("modelConfig.dragAdjustOrder", { name: model?.name ?? selector })}
            onPointerDown={event => onPointerDown(event, selector)}><Icon name="grip" extra="sm" /></button>
          <span className="wsx-rank">{index + 1}</span>
          <span className="wsx-provider-main"><span className="wsx-provider-name">{model?.name ?? selector}</span><span className="wsx-provider-id">{selector}</span></span>
          <span className="wsx-row-actions">
            <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveUp")} disabled={busy || index === 0} onClick={() => reorder(index, index - 1)}><Icon name="chevron-u" extra="sm" /></button>
            <button type="button" className="icon-btn small" aria-label={t("modelConfig.moveDown")} disabled={busy || index === chain.length - 1} onClick={() => reorder(index, index + 1)}><Icon name="chevron-d" extra="sm" /></button>
            <button type="button" className="icon-btn small" disabled={busy || chain.length === 1}
              aria-label={t("modelConfig.webSearchRemoveFromChain", { name: model?.name ?? selector })}
              onClick={() => changeOrder(chain.filter(item => item !== selector))}><Icon name="x" extra="sm" /></button>
          </span>
        </div>;
      })}
    </div>
    {chain.length === 0 ? <p className="wsx-sub">{t("modelConfig.webSearchChainEmptyHint")}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div><button type="button" className="btn small primary" disabled={busy} onClick={() => void save()}>{t("modelConfig.webSearchSaveChain")}</button></div>
  </section>;
}
