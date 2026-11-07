import type { PromptCacheStatus, ShellVizPreferences, ShellVizPresentation } from "@omp-studio/studio-protocol";

export const PREVIEW_PROMPT_CACHE: PromptCacheStatus = { state: "warm", inferred: false, tier: "short", touchedAt: Date.now(), ttlMs: 300000, cachedTokens: 24000, nextTokens: 25100 };
export function previewShellPresentation(preferences: ShellVizPreferences): ShellVizPresentation {
  const cursor = preferences.cursor ?? 4;
  const lines = preferences.view === "raw" ? ["cd ./workspace", "FILES=$(rg --files src)", "npm run check -- --only renderer"] : ["with directory('./workspace'):", "    FILES = run('rg --files src')", "    run('npm run check -- --only renderer')"];
  const rows: ShellVizPresentation["rows"] = lines.map((text, index) => ({ id: String(index), depth: 0, node: `0:0:${index}`, segments: [{ text, state: cursor > index ? "ok" : "pending" }], effects: [], ...(index === 1 && preferences.layers.inline ? { annotations: [{ name: "FILES", value: "src/App.tsx …" }] } : {}) }));
  return { preferences, rows, original: preferences.split ? [{ id: "raw", depth: 0, segments: [{ text: "npm run check -- --only renderer" }], effects: [] }] : [], output: cursor >= 4 ? "All renderer checks passed.\n" : "Checking renderer…\n", executing: false, watches: [], timeline: { length: 4, cursor, elapsedNs: cursor * 1000000000, durationNs: 4000000000 } };
}

export const PREVIEW_EXTENSION_SCHEMES = ["studio-demo"] as const;
