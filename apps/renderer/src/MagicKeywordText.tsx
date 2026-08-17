/**
 * Paint magic keywords with OMP-style per-character HSL gradients.
 * `animated` enables shimmer (composer focus + sent user bubbles).
 */

import { createElement, type CSSProperties, type ReactNode } from "react";

import { findMagicKeywordMatches, type MagicKeywordId } from "./magicKeywords";

const HUE: Readonly<Record<MagicKeywordId, (t: number) => number>> = {
  ultrathink: (t) => t * 330,
  orchestrate: (t) => 150 + t * 130,
  workflowz: (t) => 30 + t * 120,
};

function paintKeyword(keyword: MagicKeywordId, word: string, animated: boolean, key: string): ReactNode {
  const n = word.length;
  const chars: ReactNode[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = n <= 1 ? 0 : i / n;
    const hue = Math.round(HUE[keyword](t));
    const style = {
      "--magic-hue": String(hue),
      "--magic-i": String(i),
    } as CSSProperties;
    chars.push(
      createElement(
        "span",
        {
          key: `${key}-${i}`,
          className: "magic-kw-ch",
          style,
        },
        word[i],
      ),
    );
  }
  return createElement(
    "span",
    {
      key,
      className: `magic-kw magic-kw-${keyword}${animated ? " is-animated" : ""}`,
      "data-magic": keyword,
    },
    chars,
  );
}

/** Split `text` into plain strings + gradient keyword spans. */
export function renderMagicKeywordText(text: string, animated = false): ReactNode {
  const matches = findMagicKeywordMatches(text);
  if (matches.length === 0) return text;
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of matches) {
    if (match.start > last) nodes.push(text.slice(last, match.start));
    nodes.push(paintKeyword(match.keyword, text.slice(match.start, match.end), animated, `mk-${match.start}`));
    last = match.end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
