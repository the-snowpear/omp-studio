import type { Dispatch, SetStateAction } from "react";
import type { TranslationParams } from "../../i18n";
import { ModelParameterEditor } from "../ModelParameterEditor";
import { modelParameterDraftError } from "../modelParameterDraft";
import { AppSelect } from "../../AppSelect";
import type { AvailableModelRecord, ModelConfigReadModel, StudioClient } from "@omp-studio/client-contract";
import type { ModelServiceContext } from "../useModelAuth";
import { ModelSystemTemplateInspector } from "../ModelSystemTemplates";
import { useI18n } from "../../i18n";
import { Icon } from "../../icons";
import { MODEL_API_TYPES } from "../../preview/modelConfigFixtures";
import { type Draft, type DraftOverrideForm, type ModelEditState, type ModelsTab } from "./types";
import { applyOverrideToDraft, entryFromCustomForm, updateModelParameterDraft } from "./drafts";
import { BedrockMessagesControl, ModelCompatControl, NativeTransportFacts } from "./ProviderControls";

interface ModelParametersDialogProps {
  context: ModelServiceContext;
  availableModels: readonly AvailableModelRecord[];
  modelEditLeaving: boolean;
  setModelEdit: Dispatch<SetStateAction<ModelEditState | null>>;
  modelEditView: ModelEditState;
  t: (key: string, params?: TranslationParams) => string;
  client: StudioClient;
  preview: boolean;
  modelEditHost: Draft;
  data: ModelConfigReadModel | null;
  editor: Draft | null;
  persistProviderDraft: (draft: Draft, okMessage: string) => Promise<void>;
  setEditor: Dispatch<SetStateAction<Draft | null>>;
  toast: (text: string) => void;
  setModelsTab: Dispatch<SetStateAction<ModelsTab>>;
}

export function ModelParametersDialog({ context, availableModels, modelEditLeaving, setModelEdit, modelEditView, t, client, preview, modelEditHost, data, editor, persistProviderDraft, setEditor, toast, setModelsTab }: ModelParametersDialogProps) {
  const { resolvedLanguage } = useI18n();
  const selector = `${modelEditHost.id}/${modelEditView.kind === "override" ? modelEditView.modelId : modelEditView.draft.id}`;
  const model = availableModels.find(row => row.selector === selector);
  if (model?.kind === "judge") return <div className="modal-backdrop mc-model-modal" role="presentation" onMouseDown={() => setModelEdit(null)}><div className="modal" role="dialog" aria-modal="true" aria-label={resolvedLanguage === "zh" ? "原生 Judge 模型详情" : "Native Judge model details"} onMouseDown={event => event.stopPropagation()}><div className="modal-head">{model.name} · Judge</div><div className="modal-body"><p className="small muted">{resolvedLanguage === "zh" ? "此模型只用于 Judge 角色与原生评测，不接入聊天参数表，也不使用聊天系统模板。请在 Judge 角色中管理模型与凭据。" : "This model serves the Judge role and native evaluations, not chat parameters or chat system templates. Manage its model and credentials in the Judge role."}</p><dl><dt>Selector</dt><dd><code>{model.selector}</code></dd><dt>Native API</dt><dd><code>{model.api ?? modelEditHost.api}</code></dd><dt>Context</dt><dd>{model.contextWindow?.toLocaleString() ?? "—"} tokens</dd></dl></div><div className="modal-foot"><button className="btn outline" onClick={() => setModelEdit(null)}>{t("common.close")}</button></div></div></div>;
  return (<div className={`modal-backdrop mc-model-modal${modelEditLeaving ? " is-leaving" : ""}`} role="presentation" onMouseDown={() => { if (!modelEditLeaving) setModelEdit(null); }}>
                <div className="modal" role="dialog" aria-modal="true" aria-label={modelEditView.kind === "override" ? "Model Override" : t("modelConfig.editModel")} style={{ width: 600 }} onMouseDown={(event) => event.stopPropagation()}>
                  {modelEditView.kind === "override" ? (
                    <>
                      <div className="modal-head">Model Override · <span className="mono">{modelEditView.modelId}</span></div>
                      <div className="modal-body">
                        <p className="small muted" style={{ marginBottom: 10 }}>{t("modelConfig.overrideInheritCatalogDesc")}</p>
                        <div className="f-grid">
                          <div className="field"><label>Name</label><input className="input" placeholder={t("common.inherit")} value={modelEditView.draft.name} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, name: e.target.value } })} /></div>
                          <ModelParameterEditor client={client} preview={preview}
                            input={{ providerId: modelEditHost.id, api: modelEditHost.models.find(model => model.id === modelEditView.modelId)?.api ?? modelEditHost.api, modelId: modelEditView.modelId, name: modelEditView.draft.name }}
                            value={modelEditView.draft.parameters}
                            onChange={update => setModelEdit(current => updateModelParameterDraft(current, update))} />
                          <div className="field"><label>Tools</label>
                            <AppSelect className="select" value={modelEditView.draft.tools} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, tools: e.target.value as DraftOverrideForm["tools"] } })}>
                              <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                            </AppSelect>
                          </div>
                          <div className="field"><label>Image Input</label>
                            <AppSelect className="select" value={modelEditView.draft.image} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, image: e.target.value as DraftOverrideForm["image"] } })}>
                              <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                            </AppSelect>
                          </div>
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
                                <AppSelect className="select" value={modelEditView.draft.omitMaxOutputTokens} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, omitMaxOutputTokens: e.target.value as DraftOverrideForm["omitMaxOutputTokens"] } })}>
                                  <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                                </AppSelect>
                              </div>
                              <ModelCompatControl label="Requires thinking presence" value={modelEditView.draft.requiresThinkingPresence} onChange={requiresThinkingPresence => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, requiresThinkingPresence } })} />
                              <ModelCompatControl label="Extended cache TTL beta" value={modelEditView.draft.extendedCacheTtlBeta} onChange={extendedCacheTtlBeta => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, extendedCacheTtlBeta } })} />
                              <NativeTransportFacts facts={data?.availableModels.find(model => model.provider === (modelEditView.providerId ?? editor?.id) && model.id === modelEditView.modelId)?.compatibility} />
                              <ModelCompatControl label="Stateful Responses (Responses API)" value={modelEditView.draft.statefulResponses} onChange={statefulResponses => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, statefulResponses } })} />
                              <ModelCompatControl label="Prefer WebSockets" value={modelEditView.draft.preferWebsockets} onChange={preferWebsockets => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, preferWebsockets } })} />
                              <BedrockMessagesControl value={modelEditView.draft.bedrockMessagesApi} onChange={bedrockMessagesApi => setModelEdit({...modelEditView,draft:{...modelEditView.draft,bedrockMessagesApi}})}/>
                              <div className="field"><label>Premium Multiplier</label>
                                <input className="input mono" placeholder={t("common.inherit")} value={modelEditView.draft.premiumMultiplier} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, premiumMultiplier: e.target.value } })} />
                              </div>
                              <div className="field"><label>Image Count Budget</label>
                                <input className="input mono" inputMode="numeric" placeholder={t("common.inherit")} value={modelEditView.draft.imageCountBudget} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, imageCountBudget: e.target.value } })} />
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
                                <AppSelect className="select" value={modelEditView.draft.rcEnabled} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, rcEnabled: e.target.value as DraftOverrideForm["rcEnabled"] } })}>
                                  <option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
                                </AppSelect>
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
                        <ModelSystemTemplateInspector context={context} selector={selector} visible={!modelEditLeaving && !!model} />
                      </div>
                      <div className="modal-foot">
                        <button type="button" className="btn outline" onClick={() => setModelEdit(null)}>{t("common.cancel")}</button>
                        <button type="button" className="btn primary" disabled={modelEditView.draft.parameters.pending || Boolean(modelParameterDraftError(modelEditView.draft.parameters))} onClick={() => {
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
                            <AppSelect className="select" value={modelEditView.draft.api} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, api: e.target.value } })}>
                              <option value="inherit">{t("modelConfig.inheritProvider")}</option>
                              {MODEL_API_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                            </AppSelect>
                          </div>
                          <ModelParameterEditor client={client} preview={preview}
                            input={{ providerId: modelEditHost.id, api: modelEditView.draft.api === "inherit" ? modelEditHost.api : modelEditView.draft.api, modelId: modelEditView.draft.id, name: modelEditView.draft.name }}
                            value={modelEditView.draft.parameters}
                            onChange={update => setModelEdit(current => updateModelParameterDraft(current, update))} />
                          <div className="field span2"><div className="mc-caps-row">
                            <label className="desc"><input type="checkbox" checked={modelEditView.draft.tools} onChange={event => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, tools: event.target.checked } })} /> Tools</label>
                            <label className="desc"><input type="checkbox" checked={modelEditView.draft.image} onChange={event => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, image: event.target.checked } })} /> Image Input</label>
                          </div></div>
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
                              <ModelCompatControl label="Requires thinking presence" value={modelEditView.draft.requiresThinkingPresence} onChange={requiresThinkingPresence => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, requiresThinkingPresence } })} />
                              <ModelCompatControl label="Extended cache TTL beta" value={modelEditView.draft.extendedCacheTtlBeta} onChange={extendedCacheTtlBeta => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, extendedCacheTtlBeta } })} />
                              <NativeTransportFacts facts={data?.availableModels.find(model => model.provider === (modelEditView.providerId ?? editor?.id) && model.id === modelEditView.draft.id)?.compatibility} />
                              <ModelCompatControl label="Stateful Responses (Responses API)" value={modelEditView.draft.statefulResponses} onChange={statefulResponses => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, statefulResponses } })} />
                              <ModelCompatControl label="Prefer WebSockets" value={modelEditView.draft.preferWebsockets} onChange={preferWebsockets => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, preferWebsockets } })} />
                              <BedrockMessagesControl value={modelEditView.draft.bedrockMessagesApi} onChange={bedrockMessagesApi => setModelEdit({...modelEditView,draft:{...modelEditView.draft,bedrockMessagesApi}})}/>
                              <div className="field"><label>Premium Multiplier</label>
                                <input className="input mono" placeholder={t("common.notSet")} value={modelEditView.draft.premiumMultiplier} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, premiumMultiplier: e.target.value } })} />
                              </div>
                              <div className="field"><label>Image Count Budget</label>
                                <input className="input mono" inputMode="numeric" placeholder={t("common.notSet")} value={modelEditView.draft.imageCountBudget} onChange={(e) => setModelEdit({ ...modelEditView, draft: { ...modelEditView.draft, imageCountBudget: e.target.value } })} />
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
                        <ModelSystemTemplateInspector context={context} selector={selector} visible={!modelEditLeaving && !!model} />
                      </div>
                      <div className="modal-foot">
                        <button type="button" className="btn outline" onClick={() => setModelEdit(null)}>{t("common.cancel")}</button>
                        <button type="button" className="btn primary" disabled={modelEditView.draft.parameters.pending || Boolean(modelParameterDraftError(modelEditView.draft.parameters))} onClick={() => {
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
              </div>);
}
