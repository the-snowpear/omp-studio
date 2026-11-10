import type { LocalResourceRow, ResourcePage } from "@omp-studio/studio-protocol";

// Kept for callers that already use the original resource fixture.
export const PREVIEW_RESOURCE: ResourcePage = {
  uri: "local://notes.md", version: "0".repeat(64), offset: 0, total: 3,
  text: "# Session notes\n\nThis is a local preview resource.", truncated: false,
};

type PreviewLocalFile = LocalResourceRow & { text: string; version: string };
const LOCAL_CONTENT = [
  { name: "PLAN.md", modifiedAt: "2026-10-28T10:00:00Z", text: "# 实施计划\n\n## 目标\n\n为当前会话整理实现步骤与验证记录。\n\n## 实现步骤\n\n- [x] 确认会话身份与工作区边界\n- [x] 梳理资源读取与版本校验\n- [ ] 验证队列和附件\n- [ ] 复核保存前后的文件内容\n\n## 验收\n\n切换会话不携带旧请求；外部修改不覆盖草稿。\n" },
  { name: "notes.md", modifiedAt: "2026-10-28T09:42:00Z", text: PREVIEW_RESOURCE.text },
  { name: "review.md", modifiedAt: "2026-10-27T15:20:00Z", text: "# Review notes\n\n## Scope\n\nThe session owns its local files. Project files stay in the workspace.\n\n## Checks\n\n1. Read the complete file before editing.\n2. Save against the version that was opened.\n3. Keep the draft if the source changes externally.\n4. Reopen the latest source before resolving a conflict.\n\n## Follow-up\n\nReview the attachment and record any remaining UI issues.\n" },
  { name: "verify.py", modifiedAt: "2026-10-27T11:35:00Z", text: "from pathlib import Path\n\n\ndef inspect_notes(root: Path) -> list[str]:\n    return sorted(path.name for path in root.glob('*.md'))\n\n\nif __name__ == '__main__':\n    for name in inspect_notes(Path.cwd()):\n        print(name)\n" },
];

export function createPreviewLocalFiles(): PreviewLocalFile[] {
  return LOCAL_CONTENT.map((file, index) => ({
    name: file.name, uri: `local://${file.name}`, text: file.text,
    bytes: new TextEncoder().encode(file.text).byteLength,
    modifiedAt: Date.parse(file.modifiedAt), version: String(index).repeat(64),
  }));
}

export const PREVIEW_RESOURCE_EXAMPLES = {
  local: PREVIEW_RESOURCE.uri,
  omp: "omp://docs",
  attachment: "attachment://1",
  conflict: "conflict://1/ours",
} as const;

const DOCS = "# OMP documentation\n\nBuilt-in documentation available to the runtime.\n\n## Getting started\n\n- Sessions and conversation history\n- Tools and command reference\n- Configuration and model roles\n\n## Working with resources\n\nlocal:// - files owned by the active session\nomp://docs - built-in documentation index\nattachment://1 - an image attached to this session\nconflict://1/ours - one side of a registered conflict\n\n## Editing local files\n\nOpen an existing UTF-8 text file, edit its contents, and save\nagainst the version returned when the file was opened.\n\nExternal changes require reopening the original file.\n";
const CONFLICT = {
  "conflict://1": "<<<<<<< ours\nconst resourceScope = 'session';\n||||||| base\nconst resourceScope = 'default';\n=======\nconst resourceScope = 'workspace';\n>>>>>>> theirs",
  "conflict://1/ours": "const resourceScope = 'session';",
  "conflict://1/theirs": "const resourceScope = 'workspace';",
  "conflict://1/base": "const resourceScope = 'default';",
} as const;

// A static 480×270 wireframe attachment. No network URL or fake Host file path.
const ATTACHMENT_PNG = "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";

/** The preview reader exercises the same pagination flow using only local fixtures. */
export function readPreviewResource(uri: string, offset = 0, version?: string): ResourcePage {
  let text: string;
  let resourceVersion: string;
  if (uri.startsWith("local://")) {
    const file = createPreviewLocalFiles().find(file => file.uri === uri);
    if (!file) throw new Error("没有此本地资源 / Local resource not found");
    text = file.text;
    resourceVersion = uri === PREVIEW_RESOURCE.uri ? PREVIEW_RESOURCE.version : file.version;
  } else if (uri === "omp://" || uri === "omp://docs") {
    text = DOCS; resourceVersion = "d".repeat(64);
  } else if (uri === "attachment://1") {
    return { uri, version: "e".repeat(64), offset: 0, total: 1, text: "Session attachment · workspace wireframe", truncated: false, image: { mimeType: "image/png", data: ATTACHMENT_PNG } };
  } else if (Object.hasOwn(CONFLICT, uri)) {
    text = CONFLICT[uri as keyof typeof CONFLICT]; resourceVersion = "f".repeat(64);
  } else throw new Error("找不到此资源，请检查地址 / Resource not found; check the URI");
  if (version && version !== resourceVersion) throw new Error("资源版本已变更，请重新读取 / Resource changed; read it again");
  const lines = text.split("\n");
  const end = Math.min(offset + 8, lines.length);
  return { uri, version: resourceVersion, offset, total: lines.length, text: lines.slice(offset, end).join("\n"), truncated: end < lines.length, ...(end < lines.length ? { nextOffset: end } : {}) };
}
