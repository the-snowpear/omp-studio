/**
 * Manual Compact outcome copy. Runtime still says "session too small" when
 * there is nothing older than `compaction.keepRecentTokens` (default 20_000)
 * to summarize — not when the model window is small.
 */

import { pickLocale } from "./i18n";

export const MANUAL_COMPACT_KEEP_RECENT_TOKENS = 20_000;

export function compactNoticeFromOutput(
  output: readonly string[],
  opts?: { readonly successText?: string },
): { readonly text: string; readonly ok: boolean } {
  const failed = output.find((line) => /compaction failed/i.test(line));
  if (failed !== undefined) return { text: formatCompactFailure(failed), ok: false };
  if (opts?.successText !== undefined) return { text: opts.successText, ok: true };
  const line = output.find((item) => item.trim().length > 0);
  return { text: line ?? pickLocale("已压缩上下文", "Context compacted"), ok: true };
}

export function formatCompactFailure(line: string): string {
  if (/already compacted/i.test(line)) {
    return pickLocale("已经压过了，没有新的更早对话可再压缩", "Already compacted; no older messages remain to compact");
  }
  if (/session too small|no messages/i.test(line)) {
    return pickLocale("没有更早的对话可压缩（最近约 2 万 token 会原样保留）", "No older messages to compact (roughly the latest 20k tokens are kept verbatim)");
  }
  const stripped = line.replace(/^compaction failed:\s*/i, "").trim();
  return stripped.length > 0 ? pickLocale(`压缩失败：${stripped}`, `Compaction failed: ${stripped}`) : pickLocale("压缩失败", "Compaction failed");
}
