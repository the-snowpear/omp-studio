import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons";

/** Shared status vocabulary for Runtime-owned panes: one pill and one callout, styled in components.css. */
export type StateTone = "ready" | "idle" | "warn" | "blocked" | "active";

/** `live` pulses the dot: the state is waiting on someone right now. */
export function StatePill({ tone, children, className, live }: { tone: StateTone; children: ReactNode; className?: string; live?: boolean }) {
  return <span className={`state-pill${className ? ` ${className}` : ""}`} data-tone={tone} data-live={live || undefined}><i aria-hidden />{children}</span>;
}

export function Callout({ tone = "info", icon, children, role = "status", className }: {
  tone?: "info" | "warn" | "error" | "success";
  icon?: IconName;
  children: ReactNode;
  role?: "status" | "alert" | "note";
  className?: string;
}) {
  const glyph: IconName = icon ?? (tone === "error" ? "alert-c" : tone === "warn" ? "alert" : tone === "success" ? "check" : "info");
  return <div className={`ui-callout${className ? ` ${className}` : ""}`} data-tone={tone} role={role}>
    <Icon name={glyph} extra="sm" /><div className="ui-callout-body">{children}</div>
  </div>;
}
