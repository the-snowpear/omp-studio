export type FileScope = "conversation" | "workspace";
const KEY = "omp.file-viewer.scope";
let demo: FileScope = "conversation";
export function readFileScope(preview = false): FileScope { return preview ? demo : localStorage.getItem(KEY) === "workspace" ? "workspace" : "conversation"; }
export function saveFileScope(value: FileScope, preview = false): void { if (preview) demo = value; else localStorage.setItem(KEY, value); }

/** Editor display preferences shared by every text file window. */
export interface EditorPrefs { wrap: boolean; fontSize: number }
export const DEFAULT_EDITOR_PREFS: EditorPrefs = { wrap: true, fontSize: 13 };
export const clampFontSize = (value: number) => Math.min(24, Math.max(10, Math.round(value)));
const EDITOR_KEY = "omp.file-viewer.editor";
let demoEditor = DEFAULT_EDITOR_PREFS;
const editorListeners = new Set<() => void>();
let cached: EditorPrefs | undefined;
export function readEditorPrefs(preview = false): EditorPrefs {
  if (preview) return demoEditor;
  if (cached) return cached;
  try {
    const value = JSON.parse(localStorage.getItem(EDITOR_KEY) ?? "{}") as Partial<EditorPrefs>;
    cached = { wrap: typeof value.wrap === "boolean" ? value.wrap : DEFAULT_EDITOR_PREFS.wrap, fontSize: typeof value.fontSize === "number" ? clampFontSize(value.fontSize) : DEFAULT_EDITOR_PREFS.fontSize };
  } catch { cached = DEFAULT_EDITOR_PREFS; }
  return cached;
}
export function saveEditorPrefs(patch: Partial<EditorPrefs>, preview = false): void {
  const next = { ...readEditorPrefs(preview), ...patch };
  next.fontSize = clampFontSize(next.fontSize);
  if (preview) demoEditor = next;
  else { cached = next; try { localStorage.setItem(EDITOR_KEY, JSON.stringify(next)); } catch { /* Preference stays for this session. */ } }
  for (const listener of editorListeners) listener();
}
export function subscribeEditorPrefs(listener: () => void) { editorListeners.add(listener); return () => { editorListeners.delete(listener); }; }
