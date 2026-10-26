import { useEffect, useRef, useState } from "react";
import { MODEL_CONFIG_THINKING_EFFORTS, MODEL_THINKING_MODES, MODEL_PARAMETER_FIELDS, mergeModelParameters, type StudioClient, type ModelAdaptationInput, type ModelThinkingConfig, type ModelParameterField } from "@omp-studio/client-contract";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { previewModelAdaptation } from "../preview/modelAdaptationPreview";
import { effectiveModelParameters, effectiveParameterSources, modelParameterDraftError, retainManualModelParameters, setManualModelParameter, type ModelParameterDraft } from "./modelParameterDraft";

export function ModelParameterEditor({ client, preview, input, value, onChange }: {
  client: StudioClient;
  preview: boolean;
  input: ModelAdaptationInput;
  value: ModelParameterDraft;
  onChange: (update: (draft: ModelParameterDraft) => ModelParameterDraft) => void;
}) {
  const { t } = useI18n();
  const change = useRef(onChange); change.current = onChange;
  const snapshot = useRef(value); snapshot.current = value;
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState("");
  const identity = JSON.stringify([input.providerId, input.api, input.modelId]);
  const lookup = JSON.stringify([identity, input.name]);
  useEffect(() => {
    let active = true;
    change.current(current => {
      const retained = current.identity && current.identity !== identity ? retainManualModelParameters(current) : current;
      const { recommendation: _old, ...rest } = retained;
      return { ...rest, identity, pending: Boolean(input.modelId.trim()) };
    });
    setError("");
    if (!input.modelId.trim()) return;
    const timer = setTimeout(() => {
      const catalogVersion = snapshot.current.catalogVersion;
      const request = { ...input, ...(catalogVersion ? { catalogVersion } : {}) };
      void (preview ? Promise.resolve(previewModelAdaptation(request)) : client.query("models.adaptation.resolve", request))
        .then(recommendation => {
          if (active) change.current(current => ({ ...current, pending: false, recommendation, catalogVersion: recommendation.catalogVersion }));
        }).catch(reason => {
          if (!active) return;
          setError(reason instanceof Error ? reason.message : String(reason));
          change.current(current => ({ ...current, pending: false }));
        });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [client, preview, lookup, generation]);

  const values = effectiveModelParameters(value);
  const sources = effectiveParameterSources(value);
  const recommendation = value.recommendation;
  const set = (field: ModelParameterField, next: unknown) => onChange(current => setManualModelParameter(current, field, next));
  const origin = (field: ModelParameterField) => sources[field] ? t(`modelAdaptation.source.${sources[field]!.source}`) : t("modelAdaptation.unknown");
  const badge = (field: ModelParameterField) => <small className="mc-parameter-origin" data-source={sources[field]?.source} data-tip={sources[field]?.catalogModel}>{origin(field)}</small>;
  const updateThinking = (patch: Partial<ModelThinkingConfig>) => {
    const base = values.thinkingConfig ?? { mode: "effort" as const, efforts: MODEL_CONFIG_THINKING_EFFORTS };
    onChange(current => {
      const next = setManualModelParameter(current, "thinkingConfig", { ...base, ...patch });
      return values.reasoning === undefined ? setManualModelParameter(next, "reasoning", true) : next;
    });
  };
  const thinking = values.thinkingConfig;
  const validation = modelParameterDraftError(value);

  return <div className="mc-parameters span2">
    <div className="mc-parameters-header">
      <strong>{t("modelAdaptation.title")}{preview ? ` · ${t("modelAdaptation.demo")}` : ""}</strong>
      <button type="button" className="btn small outline" onClick={() => {
        onChange(current => {
          const { catalogVersion: _pin, recommendation: _old, ...rest } = retainManualModelParameters(current);
          return rest;
        });
        setGeneration(n => n + 1);
      }}>{t("modelAdaptation.reapply")}</button>
    </div>
    <p className="small muted" aria-live="polite">{value.pending ? t("modelAdaptation.matching") : recommendation?.status === "matched" ? `${t("modelAdaptation.matched")} ${recommendation.candidates[0]?.provider} / ${recommendation.candidates[0]?.name} · ${recommendation.catalogVersion}` : recommendation?.status === "ambiguous" ? t("modelAdaptation.ambiguous") : t("modelAdaptation.noMatch")}</p>
    {recommendation?.status === "ambiguous" ? <AppSelect className="select" aria-label={t("modelAdaptation.chooseModel")} value="" onChange={event => {
      const selected = recommendation.candidates.find(row => row.key === event.target.value);
      if (!selected) return;
      const nextValues = mergeModelParameters(selected.values, input.endpoint ?? {});
      const nextSources = Object.fromEntries(MODEL_PARAMETER_FIELDS.filter(field => nextValues[field] !== undefined).map(field => [field, input.endpoint?.[field] !== undefined ? { source: "endpoint" as const } : { source: "catalog" as const, catalogVersion: recommendation.catalogVersion, catalogModel: selected.key }]));
      onChange(current => ({ ...current, recommendation: { ...recommendation, status: "matched", candidates: [selected], values: nextValues, sources: nextSources } }));
    }}><option value="">{t("modelAdaptation.chooseModel")}</option>{recommendation.candidates.map(row => <option key={row.key} value={row.key}>{row.provider} / {row.id}</option>)}</AppSelect> : null}
    {recommendation?.status === "matched" && recommendation.candidates[0]?.limitation?.includes("native-thinking") ? <p className="small muted">{t("modelAdaptation.nativeThinking")}</p> : null}
    {recommendation?.status === "matched" && recommendation.candidates[0]?.limitation?.includes("native-context") ? <p className="small muted">{t("modelAdaptation.nativeContext")}</p> : null}
    {error ? <p className="small" role="status">{t("modelAdaptation.unavailable")} · {error}</p> : null}
    <div className="f-grid">
      {(["contextWindow", "maxContextWindow", "maxTokens"] as const).map(field => <div className="field" key={field}>
        <label>{t(`modelAdaptation.${field}`)} {badge(field)}</label>
        <input aria-label={t(`modelAdaptation.${field}`)} type="number" className={`input mono${sources[field]?.source && sources[field]?.source !== "manual" ? " is-recommended" : ""}`} value={value.values[field] ?? ""} placeholder={values[field] === undefined ? t("modelAdaptation.unknown") : String(values[field])} onChange={event => set(field, event.target.value === "" ? undefined : Number(event.target.value))} />
        {value.values[field] !== undefined ? <button className="mc-parameter-reset" type="button" onClick={() => set(field, undefined)}>{t("modelAdaptation.restore")}</button> : null}
      </div>)}
      <div className="field"><label>{t("modelAdaptation.reasoning")} {badge("reasoning")}</label>
        <AppSelect aria-label={t("modelAdaptation.reasoning")} className={`select${sources.reasoning?.source !== "manual" ? " is-recommended" : ""}`} value={value.values.reasoning === undefined ? "" : String(value.values.reasoning)} onChange={event => set("reasoning", event.target.value === "" ? undefined : event.target.value === "true")}>
          <option value="">{values.reasoning === undefined ? t("modelAdaptation.unknown") : `${t("modelAdaptation.recommended")} · ${t(values.reasoning ? "common.on" : "common.off")}`}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option>
        </AppSelect>
      </div>
    </div>
    {values.reasoning !== false ? <details className="mc-thinking-config" open={Boolean(thinking)}>
      <summary>{t("modelAdaptation.thinking")} {badge("thinkingConfig")}</summary>
      <div className="f-grid">
        <div className="field"><label>thinking.mode</label><AppSelect aria-label="thinking.mode" className={`select${sources.thinkingConfig?.source !== "manual" ? " is-recommended" : ""}`} value={thinking?.mode ?? ""} onChange={event => event.target.value ? updateThinking({ mode: event.target.value as ModelThinkingConfig["mode"] }) : set("thinkingConfig", null)}><option value="">{t("modelAdaptation.notConfigured")}</option>{MODEL_THINKING_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}</AppSelect></div>
        {thinking ? <>
          <div className="field"><label>thinking.defaultLevel</label><AppSelect aria-label="thinking.defaultLevel" className="select" value={thinking.defaultLevel ?? ""} onChange={event => {
            const { defaultLevel: _old, ...rest } = thinking;
            set("thinkingConfig", event.target.value ? { ...rest, defaultLevel: event.target.value } : rest);
          }}><option value="">{t("modelAdaptation.runtimeDefault")}</option>{thinking.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</AppSelect></div>
          <div className="field span2"><label>thinking.efforts</label><div className="mc-thinking-efforts">{MODEL_CONFIG_THINKING_EFFORTS.map(effort => <label key={effort}><input type="checkbox" checked={thinking.efforts.includes(effort)} onChange={event => updateThinking({ efforts: MODEL_CONFIG_THINKING_EFFORTS.filter(item => item === effort ? event.target.checked : thinking.efforts.includes(item)) })} />{effort}</label>)}</div></div>
          {thinking.efforts.map(effort => <div className="field" key={effort}><label>effortMap · {effort}</label><input aria-label={`effortMap.${effort}`} className="input mono" placeholder={effort} value={thinking.effortMap?.[effort] ?? ""} onChange={event => {
            const effortMap = { ...thinking.effortMap };
            if (event.target.value) effortMap[effort] = event.target.value; else delete effortMap[effort];
            const { effortMap: _old, ...rest } = thinking;
            set("thinkingConfig", Object.keys(effortMap).length ? { ...rest, effortMap } : rest);
          }} /></div>)}
          {(["supportsDisplay", "requiresEffort"] as const).map(field => <div className="field" key={field}><label>thinking.{field}</label><AppSelect aria-label={`thinking.${field}`} className="select" value={thinking[field] === undefined ? "" : String(thinking[field])} onChange={event => {
            const next = { ...thinking }; if (event.target.value === "") delete next[field]; else next[field] = event.target.value === "true";
            set("thinkingConfig", next);
          }}><option value="">{t("modelAdaptation.runtimeDefault")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option></AppSelect></div>)}
        </> : null}
      </div>
      <button type="button" className="mc-parameter-reset" onClick={() => set("thinkingConfig", undefined)}>{t("modelAdaptation.restore")}</button>
    </details> : null}
    {validation ? <p role="alert" className="small">{t(`modelAdaptation.${validation}`)}</p> : null}
  </div>;
}
