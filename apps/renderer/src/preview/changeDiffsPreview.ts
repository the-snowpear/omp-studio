import { getPreviewDiff, type PreviewDiffLine } from "./fixtures";
import { isZh } from "../i18n";

type PreviewFileDiff = { add: number; del: number; lines: readonly PreviewDiffLine[]; partial?: boolean };

/** File-specific excerpts shared by Changes and Git; counts describe the full file change. */
export function getPreviewFileDiffs(zh = isZh()): Readonly<Record<string, PreviewFileDiff>> {
  const diff = getPreviewDiff(zh);
  return {
    [diff.file]: { ...diff, partial: true },
    "docs/UPSTREAM-SYNC.md": { add: 214, del: 0, lines: zh ? [
      ["+", "", "1", "# 上游同步记录 · v0.8.1"],
      ["+", "", "2", ""],
      ["+", "", "3", "## 同步范围"],
      ["+", "", "4", "- 对齐依赖与锁文件。"],
      ["+", "", "5", "- 保留 Studio Bridge 和会话目录。"],
      ["+", "", "6", "- 复查 Mermaid 主题类型与全屏缩放。"],
      ["collapse", "中间 204 行新增内容已折叠", "", ""],
      ["+", "", "211", "## 验收记录"],
      ["+", "", "212", "- [x] Windows 类型检查"],
      ["+", "", "213", "- [x] 文档入口"],
      ["+", "", "214", "- [ ] macOS 交互复查"],
    ] : [
      ["+", "", "1", "# Upstream Sync Notes · v0.8.1"],
      ["+", "", "2", ""],
      ["+", "", "3", "## Sync Scope"],
      ["+", "", "4", "- Align dependencies and lockfile."],
      ["+", "", "5", "- Preserve Studio Bridge and session directory."],
      ["+", "", "6", "- Review Mermaid theme types and fullscreen zoom."],
      ["collapse", "204 added lines folded", "", ""],
      ["+", "", "211", "## Verification Log"],
      ["+", "", "212", "- [x] Windows typecheck"],
      ["+", "", "213", "- [x] Documentation entrypoints"],
      ["+", "", "214", "- [ ] macOS interaction review"],
    ] },
    "README.md": { add: 3, del: 1, lines: zh ? [
      [" ", "46", "46", "## 文档"],
      ["-", "47", "", "- [旧同步笔记](docs/sync-notes.md)"],
      ["+", "", "47", "- [上游同步](docs/UPSTREAM-SYNC.md)"],
      ["+", "", "48", "- [验收记录](docs/上游同步检查记录%20v0.8.1.md)"],
      ["+", "", "49", "- [架构说明](docs/ARCH.md)"],
      [" ", "48", "50", ""],
    ] : [
      [" ", "46", "46", "## Documentation"],
      ["-", "47", "", "- [Legacy sync notes](docs/sync-notes.md)"],
      ["+", "", "47", "- [Upstream Sync](docs/UPSTREAM-SYNC.md)"],
      ["+", "", "48", "- [Verification notes](docs/upstream-sync-notes%20v0.8.1.md)"],
      ["+", "", "49", "- [Architecture](docs/ARCH.md)"],
      [" ", "48", "50", ""],
    ] },
    "package.json": { add: 4, del: 4, lines: [
      [" ", "18", "18", '  "dependencies": {'],
      ["-", "19", "", '    "@earendil-works/pi-core": "0.8.0",'],
      ["+", "", "19", '    "@earendil-works/pi-core": "0.8.1",'],
      ["-", "20", "", '    "@earendil-works/pi-ai": "0.8.0",'],
      ["+", "", "20", '    "@earendil-works/pi-ai": "0.8.1",'],
      ["-", "21", "", '    "@earendil-works/pi-agent-core": "0.8.0",'],
      ["+", "", "21", '    "@earendil-works/pi-agent-core": "0.8.1",'],
      ["-", "22", "", '    "@earendil-works/pi-web-ui": "0.8.0"'],
      ["+", "", "22", '    "@earendil-works/pi-web-ui": "0.8.1"'],
      [" ", "23", "23", "  }"],
    ] },
    "app/App.tsx": { add: 18, del: 9, lines: [
      [" ", "83", "83", "function ConversationView({ sessionId }: Props) {"],
      ["-", "84", "", "  const rows = useTranscript();"],
      ["+", "", "84", "  const rows = useTranscript(sessionId);"],
      ["+", "", "85", "  const readingPosition = useReadingPosition(sessionId);"],
      ["collapse", zh ? "中间布局变更已折叠" : "Middle layout changes folded", "", ""],
      ["-", "124", "", "  return <Timeline rows={rows} />;"],
      ["+", "", "133", "  return <Timeline rows={rows} readingPosition={readingPosition} />;"],
      [" ", "125", "134", "}"],
    ] },
    "hooks/useCodeTheme.ts": { add: 11, del: 6, lines: [
      ["+", "", "1", 'type MermaidTheme = "default" | "dark";'],
      [" ", "1", "2", ""],
      ["-", "2", "", "export function getCodeTheme(): string {"],
      ["+", "", "3", "export function getCodeTheme(): MermaidTheme {"],
      [" ", "3", "4", '  return isDarkTheme() ? "dark" : "default";'],
      [" ", "4", "5", "}"],
      ["collapse", zh ? "中间主题订阅变更已折叠" : "Middle theme subscription changes folded", "", ""],
      ["+", "", "31", "return useMemo(() => getCodeTheme(), [theme]);"],
    ] },
    "config.yml": { add: 7, del: 0, lines: [
      ["+", "", "1", "preview:"],
      ["+", "", "2", "  theme: system"],
      ["+", "", "3", "  inertia: false"],
      ["+", "", "4", "checks:"],
      ["+", "", "5", "  - types"],
      ["+", "", "6", "  - markdown"],
      ["+", "", "7", "  - conversation-restore"],
    ] },
  };
}

export const PREVIEW_FILE_DIFFS: Readonly<Record<string, PreviewFileDiff>> = getPreviewFileDiffs();
