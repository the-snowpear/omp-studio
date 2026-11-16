import type { PromptHistoryItem, PromptHistoryScope } from "@omp-studio/studio-protocol";
import { demoPath } from "./demoPaths";

/** Demo prompt history. Bodies are static strings; the panel only reads them on demand. */
interface DemoPrompt { scope: PromptHistoryScope; zh: string; en: string; ageMin: number; useCount: number; cwd?: string; session?: string; truncated?: boolean }

const PROMPTS: DemoPrompt[] = [
  { scope: "session", ageMin: 6, useCount: 1, session: "preview-t1",
    zh: "把 SessionChanges 的聚焦逻辑改成跟随 focusPath，再补一条回归测试：切换轮次后仍停在同一文件。",
    en: "Make SessionChanges follow focusPath, then add a regression test: switching turns keeps the same file open." },
  { scope: "workspace", ageMin: 48, useCount: 4,
    zh: "运行 npm run check -- --only renderer，只看失败用例，给出最小修复，不要改测试夹具。",
    en: "Run npm run check -- --only renderer, look at failing cases only, and propose the smallest fix without touching fixtures." },
  { scope: "workspace", ageMin: 190, useCount: 2, truncated: true,
    zh: "复查 docs/UPSTREAM-SYNC.md 的同步范围：\n1. 依赖与锁文件是否对齐；\n2. Studio Bridge 与会话目录是否保留；\n3. Mermaid 主题类型与全屏缩放是否复查。\n逐条给出证据（文件与行号），缺失的列成待办。",
    en: "Review the sync scope in docs/UPSTREAM-SYNC.md:\n1. Are dependencies and the lockfile aligned?\n2. Are Studio Bridge and the session directory preserved?\n3. Were Mermaid theme types and fullscreen zoom reviewed?\nCite evidence (file and line) for each item and list what is missing as todos." },
  { scope: "profile", ageMin: 60 * 26, useCount: 7, cwd: demoPath("omp-studio"),
    zh: "用三句话总结这次改动，再写一条符合 Conventional Commits 的提交标题。",
    en: "Summarize this change in three sentences, then write a Conventional Commits subject." },
  { scope: "profile", ageMin: 60 * 72, useCount: 1, cwd: demoPath("bridge-lab"),
    zh: "解释 bridge-protocol.ts 里 leaseGeneration 的作用，并画一张时序图。",
    en: "Explain what leaseGeneration does in bridge-protocol.ts and draw a sequence diagram." },
];

const RANK: Record<PromptHistoryScope, number> = { session: 0, workspace: 1, profile: 2 };

function preview(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function previewPromptHistory(scope: PromptHistoryScope, query: string, zh: boolean, now = Date.now()): PromptHistoryItem[] {
  const needle = query.trim().toLowerCase();
  return PROMPTS.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => RANK[entry.scope] <= RANK[scope])
    .filter(({ entry }) => !needle || (zh ? entry.zh : entry.en).toLowerCase().includes(needle))
    .map(({ entry, index }) => ({
      id: index + 1, revision: `demo-${index + 1}`, preview: preview(zh ? entry.zh : entry.en),
      createdAt: now - entry.ageMin * 60_000, useCount: entry.useCount,
      ...(entry.cwd ? { cwd: entry.cwd } : {}), ...(entry.session ? { sourceSessionId: entry.session } : {}),
    }));
}

export function previewPromptBody(id: number, zh: boolean): { prompt: string; truncated: boolean } | undefined {
  const entry = PROMPTS[id - 1];
  if (!entry) return undefined;
  const prompt = zh ? entry.zh : entry.en;
  return entry.truncated ? { prompt: prompt.slice(0, Math.ceil(prompt.length * 0.7)), truncated: true } : { prompt, truncated: false };
}
