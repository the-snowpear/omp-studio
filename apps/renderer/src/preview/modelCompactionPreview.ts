import type { AvailableModelRecord } from "@omp-studio/client-contract";
import type { CompactionPreview } from "@omp-studio/studio-protocol";

/** Display-only compaction scenario. Real input is always planned by OMP. */
export function previewModelCompaction(model: AvailableModelRecord, input: string): { plan: CompactionPreview; entry: number | string | null } {
  const text = input.trim();
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  const tokens = /^(f)?(\d+)([kmb])?$/i.exec(text);
  const count = tokens ? Number(tokens[2]) * ({ k: 1_000, m: 1_000_000, b: 1_000_000_000 }[tokens[3]?.toLowerCase() ?? ""] ?? 1) : 0;
  const fixed = Boolean(tokens?.[1]);
  const share = percent ? Number(percent[1]) : 85;
  const standard = model.contextWindow;
  const ceiling = model.maxContextWindow ?? standard;
  const invalid = text !== "" && ((!percent && !tokens) || (percent && (share <= 0 || share > 100)) || (tokens && (!Number.isSafeInteger(count) || count <= 0 || (ceiling !== undefined && (fixed ? count >= ceiling : count > ceiling)))));
  if (invalid) return { plan: { valid: false, extended: false }, entry: null };
  const extended = standard !== undefined && ceiling !== undefined && ceiling > standard && (fixed ? count >= standard : count > standard);
  const window = extended ? ceiling : standard;
  const base = count && !fixed ? Math.min(count, window ?? count) : window;
  const trigger = fixed ? count : base ? Math.floor(base * Math.min(99, Math.max(1, share)) / 100) : undefined;
  const summary = fixed ? `compacts at exactly ${count.toLocaleString()} tokens`
    : `${share}% of ${count ? `${count.toLocaleString()} base` : "window"}`;
  return {
    plan: { valid: true, extended, ...(window === undefined ? {} : { window }), ...(trigger === undefined ? {} : { trigger }), summary: text ? summary : `resets: ${summary}` },
    entry: !text ? null : percent ? text : fixed ? `f${count}` : count,
  };
}
