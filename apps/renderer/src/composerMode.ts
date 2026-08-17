/**
 * Composer magic-keyword helpers. OMP injects a hidden notice when a
 * standalone lowercase word appears in prompt prose — not inside code.
 */

import { containsMagicKeyword, type MagicKeywordId } from "./magicKeywords";

/** Sticky composer keywords (picker). Same three OMP magic words. */
export type MagicKeyword = MagicKeywordId;

/** True when `keyword` appears as a standalone prose token. */
export function containsStandaloneKeyword(text: string, keyword: MagicKeyword): boolean {
  return containsMagicKeyword(text, keyword);
}

/** Prepend the keyword on its own line when the draft does not already trigger it. */
export function injectMagicKeyword(text: string, keyword: MagicKeyword | null): string {
  if (keyword === null) return text;
  if (containsStandaloneKeyword(text, keyword)) return text;
  return `${keyword}\n${text}`;
}
