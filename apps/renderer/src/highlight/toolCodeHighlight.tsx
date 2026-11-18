import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { RenderCache, renderBytes } from "../conversation/renderCache";
import { fileBase, stripFileSelector } from "../conversation/toolMeta";
import { performanceOptions } from "../performanceOptions";
import type { HighlightResult } from "./pool";
import { HIGHLIGHT_MAX_UNITS, type HighlightToken } from "./protocol";
import { renderHighlightTokens, splitTokensByLine, splitTokensBySeparator } from "./renderTokens";
import { highlightPool } from "./service";
import { useHighlightVisibility } from "./visibility";

export { renderHighlightTokens, splitTokensByLine };

const KNOWN_GRAMMARS: Readonly<Record<string, true>> = {
  bash: true, c: true, cpp: true, csharp: true, css: true, diff: true, go: true,
  graphql: true, ini: true, java: true, javascript: true, json: true, kotlin: true,
  less: true, lua: true, makefile: true, markdown: true, objectivec: true,
  perl: true, php: true, python: true, r: true, ruby: true, rust: true, scss: true,
  shell: true, sql: true, swift: true, typescript: true, vbnet: true, wasm: true,
  xml: true, yaml: true, powershell: true,
};

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  bun: "javascript",
  py: "python",
  pyi: "python",
  pyw: "python",
  sh: "bash",
  zsh: "bash",
  fish: "bash",
  pwsh: "powershell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  rs: "rust",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cc: "cpp",
  hh: "cpp",
  hxx: "cpp",
  ino: "cpp",
  h: "c",
  htm: "xml",
  html: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  plist: "xml",
  csproj: "xml",
  props: "xml",
  targets: "xml",
  xhtml: "xml",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  erb: "ruby",
  gemspec: "ruby",
  gql: "graphql",
  wat: "wasm",
  wast: "wasm",
  patch: "diff",
  sass: "scss",
  m: "objectivec",
  mm: "objectivec",
  pl: "perl",
  pm: "perl",
  gradle: "java",
};

const EXACT_FILENAME_LANGUAGE: Readonly<Record<string, string>> = {
  dockerfile: "bash",
  containerfile: "bash",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "makefile",
  "cmakelists.txt": "makefile",
  "package.json": "json",
  "tsconfig.json": "json",
  "jsconfig.json": "json",
  "composer.json": "json",
  "biome.json": "json",
  "turbo.json": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".stylelintrc": "json",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".npmignore": "ini",
  ".dockerignore": "ini",
  ".editorconfig": "ini",
};

export function normalizeHighlightLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const lower = language.trim().toLowerCase();
  if (!lower || !/^[\w+#.-]{1,80}$/.test(lower)) return undefined;
  const mapped = LANGUAGE_ALIASES[lower] ?? lower;
  return KNOWN_GRAMMARS[mapped] === true ? mapped : undefined;
}

export function languageFromFilePath(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined;
  const rightSide = rawPath.includes(" → ") ? rawPath.split(" → ").at(-1)!.trim() : rawPath.trim();
  const withoutCount = rightSide.replace(/\s+\(\+\d+\)$/, "").replace(/^(?:file|local|skill):\/\//i, "");
  const sshStripped = /^ssh:\/\/[^/]+(\/.+)$/i.exec(withoutCount)?.[1] ?? withoutCount;
  const cleaned = stripFileSelector(sshStripped);
  const name = fileBase(cleaned).toLowerCase();
  if (!name) return undefined;
  const exact = EXACT_FILENAME_LANGUAGE[name];
  if (exact !== undefined) return exact;
  if (name.endsWith(".gradle.kts")) return "kotlin";
  if (name.startsWith(".env")) return "ini";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return normalizeHighlightLanguage(name.slice(dot + 1));
}

type ComputeModule = typeof import("./compute");
let syncComputeModule: ComputeModule | undefined;
let syncComputePromise: Promise<ComputeModule | undefined> | undefined;
const syncReadyListeners = new Set<() => void>();

function loadSyncCompute(): ComputeModule | undefined {
  if (syncComputeModule !== undefined) return syncComputeModule;
  if (!syncComputePromise) {
    syncComputePromise = import("./compute")
      .then((mod) => {
        syncComputeModule = mod;
        for (const notify of [...syncReadyListeners]) notify();
        syncReadyListeners.clear();
        return mod;
      })
      .catch(() => undefined);
  }
  return undefined;
}

// Pre-warm lazy fallback only when Worker mode is off (dev/jsdom), keeping `./compute` out of prod main chunk.
if (!performanceOptions.highlightWorker || typeof Worker === "undefined") {
  void loadSyncCompute();
}

export async function preloadSyncHighlight(): Promise<void> {
  loadSyncCompute();
  await syncComputePromise;
}

function useSyncComputeReady(needed: boolean): boolean {
  const [ready, setReady] = useState(() => syncComputeModule !== undefined);
  useEffect(() => {
    if (!needed || syncComputeModule !== undefined) {
      if (syncComputeModule !== undefined && !ready) setReady(true);
      return;
    }
    const onReady = () => setReady(true);
    syncReadyListeners.add(onReady);
    void loadSyncCompute();
    return () => {
      syncReadyListeners.delete(onReady);
    };
  }, [needed, ready]);
  return ready || syncComputeModule !== undefined;
}

const syncCache = new RenderCache<readonly HighlightToken[]>(128, 8 * 1024 * 1024);
const syncRejected = new Set<string>();

function highlightSyncCached(lang: string, code: string, batch = false): readonly HighlightToken[] | undefined {
  if (!code || code.length > HIGHLIGHT_MAX_UNITS || syncRejected.has(lang)) return undefined;
  const mod = loadSyncCompute();
  if (!mod) return undefined;
  const key = `${batch ? "batch:" : ""}${lang}\u0000${code}`;
  const cached = syncCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const tokens = batch ? mod.computeHighlightBatch(lang, code) : mod.computeHighlight(lang, code);
    syncCache.put(key, tokens, renderBytes(code) * 4);
    return tokens;
  } catch (error) {
    if (error instanceof Error && error.message === "unknown-language") syncRejected.add(lang);
    return undefined;
  }
}

export function useCodeHighlight(
  language: string | undefined,
  code: string,
  options?: { readonly disabled?: boolean; readonly rootRef?: RefObject<HTMLElement | null> },
): readonly HighlightToken[] | undefined {
  const lang = normalizeHighlightLanguage(language);
  const disabled = options?.disabled === true || !lang || !code || code.length > HIGHLIGHT_MAX_UNITS;
  const workerMode = performanceOptions.highlightWorker && typeof Worker !== "undefined";
  const syncReady = useSyncComputeReady(!disabled && !workerMode);
  const [workerResult, setWorkerResult] = useState<{ key: string; value: HighlightResult }>();
  const requestKey = lang && !disabled ? `${lang}\u0000${code}` : "";
  const currentWorker = workerResult?.key === requestKey ? workerResult.value : undefined;
  const { active, visibleRef } = useHighlightVisibility(
    workerMode && !disabled ? options?.rootRef : undefined,
    workerMode && !disabled && currentWorker === undefined,
  );

  const syncTokens = useMemo(
    () => (!disabled && !workerMode && syncReady && lang ? highlightSyncCached(lang, code, false) : undefined),
    [disabled, workerMode, syncReady, lang, code],
  );

  useEffect(() => {
    if (disabled || !workerMode || !lang || !active || currentWorker !== undefined) return;
    let alive = true;
    let cancel: (() => void) | undefined;
    const submit = () => {
      if (cancel !== undefined || !alive) return;
      const response = highlightPool.request(lang, code, {
        priority: () => (!alive ? "none" : visibleRef.current ? "visible" : "overscan"),
        result: (value) => {
          if (alive) setWorkerResult({ key: requestKey, value });
        },
      });
      if (response.status === "accepted") cancel = response.cancel;
      if (response.status === "rejected") setWorkerResult({ key: requestKey, value: { ok: false, reason: "unavailable" } });
    };
    const unsubscribe = highlightPool.onSlot(submit);
    submit();
    return () => {
      alive = false;
      cancel?.();
      unsubscribe();
    };
  }, [disabled, workerMode, lang, code, active, currentWorker, requestKey, visibleRef]);

  if (disabled) return undefined;
  if (!workerMode) return syncTokens;
  return currentWorker?.ok ? currentWorker.tokens : undefined;
}

export function useHighlightedLines(
  language: string | undefined,
  lines: readonly string[],
  options?: { readonly disabled?: boolean; readonly rootRef?: RefObject<HTMLElement | null> },
): readonly (readonly HighlightToken[])[] | undefined {
  const code = useMemo(() => (lines.length === 0 ? "" : lines.join("\n")), [lines]);
  const tokens = useCodeHighlight(language, code, options);
  return useMemo(() => (tokens === undefined ? undefined : splitTokensByLine(tokens)), [tokens]);
}

type BatchGroup = {
  readonly key: string;
  readonly lang: string;
  readonly code: string;
  readonly entryIndices: readonly number[];
};

export function useHighlightedBatch(
  entries: ReadonlyArray<{ readonly language: string | undefined; readonly text: string }>,
  options?: { readonly disabled?: boolean; readonly rootRef?: RefObject<HTMLElement | null> },
): ReadonlyArray<readonly HighlightToken[] | undefined> {
  const disabled = options?.disabled === true || entries.length === 0;
  const workerMode = performanceOptions.highlightWorker && typeof Worker !== "undefined";
  const syncReady = useSyncComputeReady(!disabled && !workerMode);
  const { active, visibleRef } = useHighlightVisibility(
    workerMode && !disabled ? options?.rootRef : undefined,
    workerMode && !disabled,
  );

  const groups = useMemo<readonly BatchGroup[]>(() => {
    if (disabled) return [];
    const byLang = new Map<string, { texts: string[]; entryIndices: number[]; chars: number }>();
    entries.forEach((entry, entryIndex) => {
      if (!entry.text || entry.text.includes("\u0000")) return;
      const lang = normalizeHighlightLanguage(entry.language);
      if (!lang) return;
      let bucket = byLang.get(lang);
      if (!bucket) {
        bucket = { texts: [], entryIndices: [], chars: 0 };
        byLang.set(lang, bucket);
      }
      const nextChars = bucket.chars + (bucket.texts.length > 0 ? 1 : 0) + entry.text.length;
      if (nextChars > HIGHLIGHT_MAX_UNITS) return;
      bucket.texts.push(entry.text);
      bucket.entryIndices.push(entryIndex);
      bucket.chars = nextChars;
    });
    const built: BatchGroup[] = [];
    for (const [lang, bucket] of byLang) {
      if (bucket.texts.length === 0) continue;
      const code = bucket.texts.join("\u0000");
      built.push({ key: `batch:${lang}\u0000${code}`, lang, code, entryIndices: bucket.entryIndices });
    }
    return built;
  }, [disabled, entries]);

  const [workerMap, setWorkerMap] = useState<Readonly<Record<string, HighlightResult>>>({});
  const workerMapRef = useRef(workerMap);
  workerMapRef.current = workerMap;

  // Prune stale group keys when entries/groups change so streaming updates do not retain old token maps.
  useEffect(() => {
    const validKeys = new Set(groups.map((group) => group.key));
    setWorkerMap((prev) => {
      const prevKeys = Object.keys(prev);
      if (prevKeys.length === 0 || prevKeys.every((key) => validKeys.has(key))) return prev;
      const next: Record<string, HighlightResult> = {};
      for (const key of prevKeys) {
        if (validKeys.has(key)) next[key] = prev[key]!;
      }
      workerMapRef.current = next;
      return next;
    });
  }, [groups]);

  useEffect(() => {
    if (disabled || !workerMode || groups.length === 0 || !active) return;
    let alive = true;
    const cancels = new Map<string, () => void>();
    const submitAll = () => {
      if (!alive) return;
      for (const group of groups) {
        if (cancels.has(group.key) || workerMapRef.current[group.key] !== undefined) continue;
        const response = highlightPool.request(
          group.lang,
          group.code,
          {
            priority: () => (!alive ? "none" : visibleRef.current ? "visible" : "overscan"),
            result: (value) => {
              if (!alive) return;
              setWorkerMap((prev) => {
                if (prev[group.key] === value) return prev;
                const next = { ...prev, [group.key]: value };
                workerMapRef.current = next;
                return next;
              });
            },
          },
          true,
        );
        if (response.status === "accepted") cancels.set(group.key, response.cancel);
        if (response.status === "rejected") {
          setWorkerMap((prev) => {
            if (prev[group.key] !== undefined) return prev;
            const next: Record<string, HighlightResult> = { ...prev, [group.key]: { ok: false, reason: "unavailable" } };
            workerMapRef.current = next;
            return next;
          });
        }
      }
    };
    const unsubscribe = highlightPool.onSlot(submitAll);
    submitAll();
    return () => {
      alive = false;
      for (const cancel of cancels.values()) cancel();
      unsubscribe();
    };
  }, [disabled, workerMode, groups, active, visibleRef]);

  return useMemo(() => {
    const out: Array<readonly HighlightToken[] | undefined> = Array.from({ length: entries.length }, () => undefined);
    if (disabled || groups.length === 0 || (!workerMode && !syncReady)) return out;
    for (const group of groups) {
      const tokens = workerMode
        ? (workerMap[group.key]?.ok === true ? (workerMap[group.key] as Extract<HighlightResult, { ok: true }>).tokens : undefined)
        : highlightSyncCached(group.lang, group.code, true);
      if (!tokens) continue;
      const segments = splitTokensBySeparator(tokens, "\u0000");
      for (let index = 0; index < group.entryIndices.length; index += 1) {
        const entryIndex = group.entryIndices[index]!;
        out[entryIndex] = segments[index];
      }
    }
    return out;
  }, [disabled, entries.length, groups, workerMode, syncReady, workerMap]);
}
