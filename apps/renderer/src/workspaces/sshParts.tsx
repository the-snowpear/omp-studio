import { useId, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";

/** Label row + control. The optional tag sits outside the <label>, so the accessible name stays the bare label. */
export function SshField({ label, optional, htmlFor, children }: { label: string; optional?: string | undefined; htmlFor: string; children: ReactNode }) {
  return <div className="ssh-field">
    <div className="ssh-field-label"><label htmlFor={htmlFor}>{label}</label>{optional ? <small>{optional}</small> : null}</div>
    {children}
  </div>;
}

export interface SegmentOption<T extends string> { value: T; label: string; icon?: IconName }

/** Two or three exclusive choices as a radio group with a sliding thumb. */
export function SshSegmented<T extends string>({ label, value, options, hint, disabled, onChange }: { label: string; value: T; options: readonly SegmentOption<T>[]; hint?: ReactNode; disabled?: boolean; onChange(value: T): void }) {
  const id = useId();
  const index = Math.max(0, options.findIndex(option => option.value === value));
  const move = (step: number) => {
    if (disabled) return;
    const next = options[(index + step + options.length) % options.length]!;
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`${id}-${next.value}`)?.focus());
  };
  return <div className="ssh-field">
    <div className="ssh-field-label"><span id={`${id}-label`}>{label}</span></div>
    <div className="ssh-segmented" role="radiogroup" aria-labelledby={`${id}-label`} style={{ "--count": options.length, "--index": index } as CSSProperties}
      onKeyDown={event => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(1); }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(-1); }
      }}>
      {options.map(option => <button key={option.value} id={`${id}-${option.value}`} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1} disabled={disabled} onClick={() => onChange(option.value)}>
        {option.icon ? <Icon name={option.icon} extra="sm" /> : null}<span>{option.label}</span>
      </button>)}
    </div>
    {hint ? <p className="ssh-hint" key={value}><Icon name="info" extra="sm" />{hint}</p> : null}
  </div>;
}

export function SshDialogHead({ icon, title, titleId, sub, badge, closeLabel, closeDisabled, onClose }: { icon: IconName; title: string; titleId: string; sub?: ReactNode; badge?: ReactNode; closeLabel: string; closeDisabled?: boolean; onClose(): void }) {
  return <header className="ssh-dialog-head">
    <span className="ssh-glyph" aria-hidden="true"><Icon name={icon} /></span>
    <div>
      <h2 id={titleId}>{title}{badge}</h2>
      {sub ? <div className="ssh-dialog-sub">{sub}</div> : null}
    </div>
    <button type="button" className="icon-btn" aria-label={closeLabel} disabled={closeDisabled} onClick={onClose}><Icon name="x" /></button>
  </header>;
}
