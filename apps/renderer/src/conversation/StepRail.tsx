import type { OlHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "../icons";
import "./stepRail.css";

/**
 * One visual vocabulary for every ordered native sequence: Actions job steps,
 * task prompt groups and the Steps editor outline. The node carries the state;
 * rows stay text so screen readers and tests read the same labels.
 */
export type StepTone = "done" | "active" | "failed" | "warn" | "pending" | "muted";

const TONE_ICON: Partial<Record<StepTone, IconName>> = { done: "check", failed: "x", warn: "pause" };

export function StepNode({ tone, label, icon }: { tone: StepTone; label?: ReactNode; icon?: IconName | undefined }) {
  const glyph = icon ?? TONE_ICON[tone];
  return <span className={`step-node is-${tone}`} aria-hidden>
    {glyph ? <Icon name={glyph} extra="sm" /> : <span className="step-node-label">{label}</span>}
  </span>;
}

/** A vertical rail; each child is a `StepRailItem`. */
export function StepRail({ children, className, ref, ...rest }: { children: ReactNode; className?: string | undefined; ref?: Ref<HTMLOListElement> } & Omit<OlHTMLAttributes<HTMLOListElement>, "className">) {
  return <ol {...rest} ref={ref} className={`step-rail${className ? ` ${className}` : ""}`}>{children}</ol>;
}

export function StepRailItem({ tone, node, children, current, value, className }: {
  tone: StepTone; node?: ReactNode; children: ReactNode; current?: boolean | undefined; value?: number | undefined; className?: string | undefined;
}) {
  return <li className={`step-rail-item is-${tone}${className ? ` ${className}` : ""}`} aria-current={current ? "step" : undefined} {...(value === undefined ? {} : { value })}>
    {node ?? <StepNode tone={tone} />}
    <div className="step-rail-body">{children}</div>
  </li>;
}

/** A thin determinate bar for counts the Runtime actually reported (never an estimate). */
export function StepCountBar({ done, active, total, label }: { done: number; active?: number; total: number; label: string }) {
  if (total <= 0) return null;
  const pct = (value: number) => `${Math.max(0, Math.min(100, (value / total) * 100))}%`;
  return <span className="step-count-bar" aria-hidden title={label}>
    <i className="is-done" style={{ width: pct(done) }} />
    {active ? <i className="is-active" style={{ width: pct(active) }} /> : null}
  </span>;
}
