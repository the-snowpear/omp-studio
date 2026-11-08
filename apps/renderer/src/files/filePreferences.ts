export type FileScope = "conversation" | "workspace";
const KEY = "omp.file-viewer.scope";
let demo: FileScope = "conversation";
export function readFileScope(preview = false): FileScope { return preview ? demo : localStorage.getItem(KEY) === "workspace" ? "workspace" : "conversation"; }
export function saveFileScope(value: FileScope, preview = false): void { if (preview) demo = value; else localStorage.setItem(KEY, value); }
