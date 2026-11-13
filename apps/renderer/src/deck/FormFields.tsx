import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { FormChoiceField, FormSpan, FormTextField, InteractionForm, InteractionFormBlock, InteractionFormField } from "@omp-studio/studio-protocol";
import { spansText } from "@oh-my-pi/pi-tui/html-form/model";
import { OTHER_LABEL } from "@oh-my-pi/pi-tui/html-form/data";
import { AppSelect } from "../AppSelect";
import { SvgFigureImage } from "../graphics/SvgFigureImage";
import { FormSession } from "./FormSession";

/** Render native inline spans as text and fixed semantic tags, never Host HTML. */
export function FormSpans({ spans }: { spans: readonly FormSpan[] }) {
  return <>{spans.map((span, index) => span.style === "code" ? <code key={index}>{span.text}</code>
    : span.style === "strong" ? <strong key={index}>{span.text}</strong>
    : span.style === "em" ? <em key={index}>{span.text}</em> : <span key={index}>{span.text}</span>)}</>;
}

export function formSectionLabel(form: InteractionForm, index: number): string {
  const section = form.sections[index];
  const first = section?.blocks.find(block => block.kind === "field");
  return spansText(section?.title ?? []) || (first?.kind === "field" ? form.fields.find(field => field.id === first.fieldId)?.question : undefined) || `题组 ${index + 1}`;
}

export function FormFields({ form, session, section, grouped, disabled }: {
  form: InteractionForm; session: FormSession; section: number; grouped: boolean; disabled?: boolean | undefined;
}) {
  const fields = useMemo(() => new Map(form.fields.map(field => [field.id, field])), [form]);
  const locked = useSyncExternalStore(session.subscribeMeta, () => session.getMeta().phase !== "open", () => true);
  const groups = form.sections.flatMap((group, index) => group.blocks.some(block => block.kind === "field") ? [index] : []);
  const pos = groups.indexOf(section);
  const start = (groups[pos - 1] ?? -1) + 1;
  const end = pos === groups.length - 1 ? form.sections.length : section + 1;
  return <>{form.sections.map((group, index) => {
    const content = group.blocks.map((block, at) => block.kind === "field" ? (
      <FormFieldView key={at} field={fields.get(block.fieldId)!} session={session} disabled={disabled || locked} />
    ) : <FormContextBlock key={at} block={block} />);
    const hidden = grouped && (index < start || index >= end);
    // Native loose context rides with its next fieldset; trailing context stays with the last.
    if (group.fieldset) return <fieldset key={index} className="form-section" hidden={hidden} aria-label={formSectionLabel(form, index)}>
      {group.title.length ? <legend><FormSpans spans={group.title} /></legend> : null}{content}
    </fieldset>;
    return <section key={index} className="form-section form-loose" hidden={hidden}>
      {group.title.length ? <h3><FormSpans spans={group.title} /></h3> : null}{content}
    </section>;
  })}</>;
}

const FormContextBlock = memo(function FormContextBlock({ block }: { block: Exclude<InteractionFormBlock, { kind: "field" }> }) {
  switch (block.kind) {
    case "text": return <p className={block.heading ? "form-heading" : "form-context"}><FormSpans spans={block.spans} /></p>;
    case "pre": return <pre className="form-pre"><code>{block.text}</code></pre>;
    case "list": {
      const items = block.items.map((spans, index) => <li key={index}><FormSpans spans={spans} /></li>);
      return block.ordered ? <ol className="form-list">{items}</ol> : <ul className="form-list">{items}</ul>;
    }
    case "table": return <div className="form-table-scroll"><table className="form-table"><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, at) => index < block.headerRows ? <th key={at}><FormSpans spans={cell} /></th> : <td key={at}><FormSpans spans={cell} /></td>)}</tr>)}</tbody></table></div>;
    case "image": return <FormRasterImage src={block.src} alt={block.alt} />;
    case "graphic": return <figure className="form-figure"><SvgFigureImage source={block.source} alt={block.alt} />{block.alt ? <figcaption>{block.alt}</figcaption> : null}</figure>;
    case "media-unavailable": return <p className="form-media-error" role="status">{block.alt || "图示"}：{block.reason}</p>;
  }
});

function FormRasterImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <figure className="form-figure">{failed ? <p className="form-media-error" role="status">{alt || "图示"}：图片无法显示</p> : <img src={src} alt={alt} decoding="async" loading="lazy" onError={() => setFailed(true)} />}{alt ? <figcaption>{alt}</figcaption> : null}</figure>;
}

function useFieldDraft(session: FormSession, id: string) {
  const subscribe = useCallback((listener: () => void) => session.subscribeField(id, listener), [session, id]);
  const snapshot = useCallback(() => session.getDraft(id), [session, id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const FormFieldView = memo(function FormFieldView({ field, session, disabled }: {
  field: InteractionFormField; session: FormSession; disabled?: boolean | undefined;
}) {
  const draft = useFieldDraft(session, field.id);
  const id = useId();
  const errorId = `${id}-error`;
  return <div className="form-field" data-form-field-id={field.id} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) session.validateField(field.id);
  }}>
    {field.kind === "text" ? <TextFormField field={field} session={session} disabled={disabled} inputId={id} errorId={draft.error ? errorId : undefined} />
      : <ChoiceFormField field={field} session={session} disabled={disabled} inputId={id} errorId={draft.error ? errorId : undefined} />}
    {draft.error ? <p className="form-field-error" id={errorId} role="alert">{draft.error}</p> : null}
  </div>;
});

function TextFormField({ field, session, disabled, inputId, errorId }: {
  field: FormTextField; session: FormSession; disabled?: boolean | undefined; inputId: string; errorId?: string | undefined;
}) {
  const draft = useFieldDraft(session, field.id);
  const common = {
    id: inputId, "aria-label": field.question, "aria-describedby": errorId, "aria-invalid": Boolean(errorId), "aria-required": field.required,
    "data-form-control": true, disabled, value: draft.text, placeholder: field.placeholder,
    onChange: (event: { target: { value: string } }) => session.setText(field.id, event.target.value),
  };
  return <>
    <label className="form-field-label" htmlFor={inputId}><FormSpans spans={field.label.length ? field.label : [{ text: field.question }]} />{field.required ? <span className="form-required" aria-label="必填">*</span> : null}</label>
    {field.multiline ? <textarea {...common} className="input form-textarea" rows={Math.min(10, Math.max(2, field.rows, draft.text.split("\n").length))} />
      : <input {...common} className="input form-input" type={["password", "email", "url", "tel", "search"].includes(field.type) ? field.type : "text"} inputMode={field.type === "number" || field.type === "range" ? "decimal" : field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "tel" ? "tel" : "text"} />}
  </>;
}

function ChoiceFormField({ field, session, disabled, inputId, errorId }: {
  field: FormChoiceField; session: FormSession; disabled?: boolean | undefined; inputId: string; errorId?: string | undefined;
}) {
  const draft = useFieldDraft(session, field.id);
  const host = useRef<HTMLDivElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const chosen = session.otherChosen(field);
  const picked = draft.checked;
  const enabled = field.options.flatMap((option, index) => option.disabled ? [] : [index]);
  const first = picked.find(index => !field.options[index]?.disabled) ?? enabled[0];
  const openOther = () => { session.openOther(field.id); queueMicrotask(() => otherInput.current?.focus()); };
  const moveChoice = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    if (field.multi || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const stops = field.other ? [...enabled, -1] : enabled;
    const pos = stops.indexOf(at);
    const index = event.key === "Home" ? stops[0] : event.key === "End" ? stops.at(-1)
      : stops[(pos + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1) + stops.length) % stops.length];
    if (index === undefined) return;
    if (index === -1) { openOther(); return; }
    session.choose(field.id, index);
    host.current?.querySelector<HTMLButtonElement>(`[data-form-option="${index}"]`)?.focus();
  };
  const noteFor = (index: number): ReactNode => {
    if (!picked.includes(index) || field.options[index]?.disabled) return null;
    const option = field.options[index]!;
    const label = spansText(option.label) || option.value;
    return <div className="form-option-note">
      {draft.noteOpen[index] || draft.notes[index] ? <label>
        <span className="form-note-label">附注 · {label}<span>可选，不替代选项</span></span>
        <textarea className="input form-textarea form-note-input" rows={2} value={draft.notes[index] ?? ""} data-form-note={index} aria-label={`附注：${label}`} disabled={disabled} placeholder="补充这个选项的细节…" onChange={event => session.setNote(field.id, index, event.target.value)} />
      </label> : <button type="button" className="btn small ghost" aria-label={`添加附注：${label}`} disabled={disabled} onClick={() => {
        session.openNote(field.id, index);
        queueMicrotask(() => host.current?.querySelector<HTMLTextAreaElement>(`[data-form-note="${index}"]`)?.focus());
      }}>添加附注</button>}
    </div>;
  };
  return <>
    <label className="form-field-label" id={`${inputId}-label`} {...(field.select && !field.multi ? { htmlFor: inputId } : {})}><FormSpans spans={field.label.length ? field.label : [{ text: field.question }]} />{field.required ? <span className="form-required" aria-label="必选">*</span> : null}</label>
    {field.select && !field.multi ? <div ref={host} className="form-select-field">
      <AppSelect id={inputId} className="select form-input" aria-label={field.question} aria-describedby={errorId} aria-invalid={Boolean(errorId)} aria-required={field.required} data-form-control value={picked[0] === undefined ? "" : String(picked[0])} disabled={disabled || !enabled.length} onChange={event => session.choose(field.id, Number(event.target.value))}>
        {picked.length === 0 ? <option value="" disabled>选择一项…</option> : null}
        {field.options.map((option, index) => <option key={index} value={String(index)} disabled={option.disabled}>{spansText(option.label) || option.value}</option>)}
      </AppSelect>
      {picked[0] === undefined ? null : noteFor(picked[0])}
    </div> : <div ref={host} className="dk-opts form-choices" role={field.multi ? "group" : "radiogroup"} aria-label={field.question} aria-describedby={errorId} aria-invalid={Boolean(errorId)}>
      {field.options.map((option, index) => {
        const checked = picked.includes(index);
        return <div key={index} className="form-option">
          <button type="button" className={`dk-opt${checked ? " sel" : ""}`} role={field.multi ? "checkbox" : "radio"} aria-checked={checked} disabled={disabled || option.disabled} data-form-control data-form-option={index} tabIndex={field.multi || (!chosen && first === index) ? 0 : -1} onKeyDown={event => moveChoice(event, index)} onClick={() => session.choose(field.id, index)}>
            <span className="dk-opt-row"><span className={field.multi ? "o-check" : "o-radio"} aria-hidden /><span className="o-label"><FormSpans spans={option.label.length ? option.label : [{ text: option.value }]} /></span></span>
          </button>{noteFor(index)}
        </div>;
      })}
      {field.other ? <div className="form-other">
        <button type="button" className={`dk-opt${chosen ? " sel" : ""}`} role={field.multi ? "checkbox" : "radio"} aria-checked={chosen} aria-label={`${OTHER_LABEL}：${field.question}`} disabled={disabled} data-form-control data-form-option="other" tabIndex={field.multi || chosen || first === undefined ? 0 : -1} onKeyDown={event => moveChoice(event, -1)} onClick={openOther}>
          <span className="dk-opt-row"><span className={field.multi ? "o-check" : "o-radio"} aria-hidden /><span className="o-label">{OTHER_LABEL} <span className="muted">· 填写其他答案</span></span></span>
        </button>
        <div hidden={!draft.otherEditing && !draft.other} className="form-other-input">
          <input ref={otherInput} className="input form-input" data-form-control aria-label={`${OTHER_LABEL}：${field.question}`} type="text" value={draft.other} disabled={disabled} placeholder="填写其他答案…" onChange={event => session.setOther(field.id, event.target.value)} />
          {!field.multi && draft.other && !chosen ? <span className="muted small">当前使用已选项；编辑这里会改用 Other。</span> : null}
        </div>
      </div> : null}
    </div>}
  </>;
}
