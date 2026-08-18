import type { ReactNode } from "react";

/**
 * Marks a control with `data-tip`. TipHost paints the bubble in a portal so
 * overflow:hidden git panes cannot clip it. Do not use native `title`.
 */
export function GitTip({ text, children }: { readonly text: string; readonly children: ReactNode }) {
  return <span className="git-tip" data-tip={text}>{children}</span>;
}
