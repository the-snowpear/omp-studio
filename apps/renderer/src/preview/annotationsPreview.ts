import type { AnnotationBundle } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewAnnotationFile(zh = isZh()): string {
  return `import type { Workspace } from './workspace';

interface GreetingOptions {
  workspace?: Workspace;
  locale: 'zh' | 'en';
}

/** Welcome the user to their current workspace. */
export function greeting(options: GreetingOptions) {
  const { workspace, locale } = options;
  const title = 'Hello Studio';

  if (!workspace) {
    return locale === 'zh'
      ? '${zh ? "选择一个工作区，开始新的对话。" : "Choose a workspace to start a conversation."}'
      : 'Choose a workspace to start a conversation.';
  }

  return {
    title,
    subtitle: workspace.description,
    actions: [
      { id: 'new-chat', label: '${zh ? "新建对话" : "New chat"}' },
      { id: 'recent', label: '${zh ? "最近会话" : "Recent sessions"}' },
    ],
  };
}
`;
}

export function getPreviewAnnotationDiff(zh = isZh()): string {
  return `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -7,11 +7,13 @@ interface GreetingOptions {
 /** Welcome the user to their current workspace. */
 export function greeting(options: GreetingOptions) {
   const { workspace, locale } = options;
-  const title = 'Hello Studio';
+  const title = workspace?.name ?? 'OMP Studio';

   if (!workspace) {
     return locale === 'zh'
       ? '${zh ? "选择一个工作区，开始新的对话。" : "Choose a workspace to start a conversation."}'
       : 'Choose a workspace to start a conversation.';
   }
+
+  const subtitle = workspace.description?.trim();
@@ -19,4 +21,4 @@ export function greeting(options: GreetingOptions) {
   return {
     title,
-    subtitle: workspace.description,
+    subtitle,
     actions: [
`;
}

export function getPreviewAnnotationBundle(zh = isZh()): AnnotationBundle {
  const file = getPreviewAnnotationFile(zh);
  return {
    schemaVersion: 1,
    revision: 2,
    sources: [{ id: "demo-source", kind: "file", label: "src/app.ts", path: "src/app.ts", text: file, version: "sha256:" + "0".repeat(64) }],
    notes: [{ id: "demo-note", sourceId: "demo-source", note: zh ? "这里应显示当前工作区名称。" : "Should display the current workspace name here.", selection: { start: file.indexOf("Hello Studio"), end: file.indexOf("Hello Studio") + 12 } }],
  };
}

export const PREVIEW_ANNOTATION_FILE = getPreviewAnnotationFile();
export const PREVIEW_ANNOTATION_DIFF = getPreviewAnnotationDiff();
export const PREVIEW_ANNOTATION_BUNDLE: AnnotationBundle = getPreviewAnnotationBundle();
