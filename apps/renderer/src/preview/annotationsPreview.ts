import type { AnnotationBundle } from "@omp-studio/studio-protocol";
export const PREVIEW_ANNOTATION_FILE = "export function greeting() {\n  return 'Hello Studio';\n}\n";
export const PREVIEW_ANNOTATION_DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const ready = false;\n+const ready = true;\n";
export const PREVIEW_ANNOTATION_BUNDLE: AnnotationBundle = {
  schemaVersion: 1, revision: 2,
  sources: [{ id: "demo-source", kind: "file", label: "src/app.ts", path: "src/app.ts", text: PREVIEW_ANNOTATION_FILE, version: "sha256:" + "0".repeat(64) }],
  notes: [{ id: "demo-note", sourceId: "demo-source", note: "这里应显示当前工作区名称。", selection: { start: PREVIEW_ANNOTATION_FILE.indexOf("Hello Studio"), end: PREVIEW_ANNOTATION_FILE.indexOf("Hello Studio") + 12 } }],
};
