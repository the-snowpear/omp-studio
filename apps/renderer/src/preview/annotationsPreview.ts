import type { AnnotationBundle } from "@omp-studio/studio-protocol";
export const PREVIEW_ANNOTATION_FILE = `import type { Workspace } from './workspace';

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
      ? '选择一个工作区，开始新的对话。'
      : 'Choose a workspace to start a conversation.';
  }

  return {
    title,
    subtitle: workspace.description,
    actions: [
      { id: 'new-chat', label: '新建对话' },
      { id: 'recent', label: '最近会话' },
    ],
  };
}
`;
export const PREVIEW_ANNOTATION_DIFF = `diff --git a/src/app.ts b/src/app.ts
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
       ? '选择一个工作区，开始新的对话。'
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
export const PREVIEW_ANNOTATION_BUNDLE: AnnotationBundle = {
  schemaVersion: 1, revision: 2,
  sources: [{ id: "demo-source", kind: "file", label: "src/app.ts", path: "src/app.ts", text: PREVIEW_ANNOTATION_FILE, version: "sha256:" + "0".repeat(64) }],
  notes: [{ id: "demo-note", sourceId: "demo-source", note: "这里应显示当前工作区名称。", selection: { start: PREVIEW_ANNOTATION_FILE.indexOf("Hello Studio"), end: PREVIEW_ANNOTATION_FILE.indexOf("Hello Studio") + 12 } }],
};
