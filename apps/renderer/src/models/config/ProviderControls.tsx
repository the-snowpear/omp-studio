import type { ModelExecutionMetadata } from "@omp-studio/client-contract";
import { AppSelect } from "../../AppSelect";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelAuthType, ModelCatalogEntry, ModelDiscoveryResult } from "@omp-studio/client-contract";
import { resolveModelPrice } from "@omp-studio/client-contract";
import { Brand, hasBrand } from "../../brands";
import { Icon } from "../../icons";
import { useI18n } from "../../i18n";
import { MODEL_AUTH_TYPES } from "../../preview/modelConfigFixtures";
import { fmtK } from "../modelPresentation";
import { type I18nT, type TestResultView } from "./types";
import { thinkingMenuAnchor } from "./RoleControls";

/**
 * Inline connection-test result inside a provider card. Mounts collapsed
 * (grid row 0fr) and expands one frame later, so the card stretches down
 * while the notice slides in from above.
 */
export function ProviderTestRow({ result }: { result: TestResultView }) {
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

export function confirmDiscardDirty(t: I18nT): boolean {
  return window.confirm(t("modelConfig.discardDirtyConfirm"));
}

export function DiscoveryResultBlock({ result }: { result: ModelDiscoveryResult }) {
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

export function BrandMark({ id, local, status }: { id: string; local?: boolean; status?: string }) {
  if (hasBrand(id)) {
    return <span className="pv-brand"><Brand id={id} extra="lg" /></span>;
  }
  const tone = status === "available" ? "green" : status === "disabled" ? "purple" : "amber";
  return <span className={`pv-fallback a-ic ${tone}`} aria-hidden="true"><Icon name={local ? "monitor" : "server"} extra="lg" /></span>;
}

export function AuthTypeSelect({
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

export function ModelCompatControl({ label, value, onChange }: { label: string; value: "" | "true" | "false"; onChange(value: "" | "true" | "false"): void }) {
  const { t } = useI18n();
  return <div className="field span2"><label>{label}</label><AppSelect className="select" aria-label={label} value={value} onChange={event => onChange(event.target.value as "" | "true" | "false")}><option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option></AppSelect></div>;
}

export function BedrockMessagesControl({value,onChange}:{value:""|"true"|"false";onChange:(value:""|"true"|"false")=>void}) {
  const {t}=useI18n();
  return <div className="field span2"><label>Bedrock Messages API</label><AppSelect className="select" aria-label="Bedrock Messages API" value={value} onChange={event=>onChange(event.target.value as ""|"true"|"false")}><option value="">{t("common.inherit")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option></AppSelect><span className="desc">{t("modelConfig.bedrockMessagesDesc")}</span></div>;
}

export function ModelCaps({ model }: { model: ModelCatalogEntry }) {
  const { t } = useI18n();
  const current = resolveModelPrice(model.cost, model.pricing);
  const rate = (value: number | undefined) => value === undefined ? "—" : Number(value.toFixed(6));
  return (
    <span className="pm-meta">
      <span className="chip gray xs">{fmtK(model.contextWindow)} ctx</span>
      {model.maxTokens ? <span className="chip gray xs">{fmtK(model.maxTokens)} out</span> : null}
      {model.maxContextWindow ? <span className="chip gray xs" data-tip={t("modelConfig.extendedWindow")}>{fmtK(model.maxContextWindow)} ext</span> : null}
      {model.image ? <span className="chip blue xs chip-icon" data-tip={t("modelConfig.tipImage")}><Icon name="image" extra="sm" /></span> : null}
      {model.reasoning ? <span className="chip purple xs chip-icon" data-tip={t("modelConfig.tipThinking")}><Icon name="brain" extra="sm" /></span> : null}
      {model.tools ? <span className="chip gray xs chip-icon" data-tip={t("modelConfig.tipTools")}><Icon name="wrench" extra="sm" /></span> : null}
      {current.cost?.input !== undefined || current.cost?.output !== undefined
        ? <span className="chip gray xs">${rate(current.cost?.input)}/${rate(current.cost?.output)}</span>
        : null}
      {current.period ? <span className="chip gray xs" data-tip={t("modelConfig.scheduledPrice")}>{current.period === "peak" ? "↑ " + t("modelConfig.peakPrice") : "↓ " + t("modelConfig.offPeakPrice")}</span> : null}
      {model.pricing?.longContext ? <span className="chip gray xs" data-tip={t("modelConfig.longContextPrice")}>{model.pricing.longContext.inputThresholdInclusive ? "≥" : ">"}{fmtK(model.pricing.longContext.inputThreshold)}</span> : null}
    </span>
  );
}

export function NativeTransportFacts({ facts }: { facts: ModelExecutionMetadata["compatibility"] }) {
  if (facts?.supportsMessageThreads === undefined && facts?.toolNamePrefix === undefined) return null;
  return <div className="small muted" role="note">{facts.supportsMessageThreads !== undefined ? <p>Message threads · {facts.supportsMessageThreads ? "原生模型声明支持 / Supported by native policy" : "未声明支持 / Not advertised"}</p> : null}{facts.toolNamePrefix !== undefined ? <p>原生工具名前缀 / Native tool prefix · <code>{facts.toolNamePrefix}</code></p> : null}</div>;
}
