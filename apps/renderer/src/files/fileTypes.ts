export type FileKind = "text" | "markdown" | "pdf" | "image" | "audio" | "video" | "spreadsheet" | "office";
export const extension = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
export function fileKind(name: string): FileKind {
  const ext = extension(name);
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) return "image";
  if (["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "opus", "flac", "m4a", "aac"].includes(ext)) return "audio";
  if (["xls", "xlsx", "csv", "tsv"].includes(ext)) return "spreadsheet";
  if (["doc", "docx", "odt", "rtf", "ppt", "pptx", "odp"].includes(ext)) return "office";
  return "text";
}
export const textEditable = (name: string) => ["text", "markdown"].includes(fileKind(name)) || ["csv", "tsv"].includes(extension(name));
const LANGUAGES: Record<string, [label: string, badge: string, tone: string]> = {
  ts: ["TypeScript", "TS", "blue"], tsx: ["TypeScript JSX", "TSX", "blue"], mts: ["TypeScript", "TS", "blue"], cts: ["TypeScript", "TS", "blue"],
  js: ["JavaScript", "JS", "amber"], jsx: ["JavaScript JSX", "JSX", "amber"], mjs: ["JavaScript", "JS", "amber"], cjs: ["JavaScript", "JS", "amber"],
  json: ["JSON", "{ }", "amber"], jsonc: ["JSON", "{ }", "amber"], yaml: ["YAML", "YML", "red"], yml: ["YAML", "YML", "red"], toml: ["TOML", "TOML", "red"], ini: ["INI", "INI", "gray"],
  md: ["Markdown", "MD", "blue"], mdx: ["MDX", "MDX", "blue"], markdown: ["Markdown", "MD", "blue"],
  py: ["Python", "PY", "blue"], rs: ["Rust", "RS", "amber"], go: ["Go", "GO", "blue"], java: ["Java", "JAVA", "red"], kt: ["Kotlin", "KT", "accent"], swift: ["Swift", "SWF", "amber"],
  c: ["C", "C", "blue"], h: ["C Header", "H", "blue"], cpp: ["C++", "C++", "blue"], hpp: ["C++ Header", "H++", "blue"], cs: ["C#", "C#", "accent"], rb: ["Ruby", "RB", "red"], php: ["PHP", "PHP", "accent"],
  sh: ["Shell", "SH", "green"], bash: ["Shell", "SH", "green"], zsh: ["Shell", "SH", "green"], ps1: ["PowerShell", "PS", "blue"], bat: ["Batch", "BAT", "gray"], cmd: ["Batch", "CMD", "gray"],
  sql: ["SQL", "SQL", "amber"], html: ["HTML", "HTML", "red"], htm: ["HTML", "HTML", "red"], css: ["CSS", "CSS", "blue"], scss: ["SCSS", "SCSS", "accent"], less: ["Less", "LESS", "blue"], xml: ["XML", "XML", "amber"], svg: ["SVG", "SVG", "amber"], vue: ["Vue", "VUE", "green"], svelte: ["Svelte", "SV", "red"],
  csv: ["CSV", "CSV", "green"], tsv: ["TSV", "TSV", "green"], xls: ["Excel", "XLS", "green"], xlsx: ["Excel", "XLSX", "green"], pdf: ["PDF", "PDF", "red"],
  doc: ["Word", "DOC", "blue"], docx: ["Word", "DOCX", "blue"], odt: ["文档", "ODT", "blue"], rtf: ["RTF", "RTF", "blue"], ppt: ["PowerPoint", "PPT", "amber"], pptx: ["PowerPoint", "PPTX", "amber"], odp: ["演示文稿", "ODP", "amber"],
  txt: ["纯文本", "TXT", "gray"], log: ["日志", "LOG", "gray"], lock: ["Lock", "LOCK", "gray"], env: ["Env", "ENV", "gray"],
};
const KIND_BADGE: Record<FileKind, [string, string, string]> = { text: ["纯文本", "TXT", "gray"], markdown: ["Markdown", "MD", "blue"], pdf: ["PDF", "PDF", "red"], image: ["图片", "IMG", "green"], audio: ["音频", "AUD", "accent"], video: ["视频", "VID", "accent"], spreadsheet: ["表格", "XLS", "green"], office: ["文档", "DOC", "blue"] };
/** Short colored badge and human language name for headers and status bars. */
export function fileBadge(name: string): { label: string; badge: string; tone: string } {
  const base = name.split(/[\\/]/).pop() ?? name;
  const named = /^(Dockerfile|Makefile)$/i.test(base) ? [base, base === "Makefile" ? "MK" : "DKR", "blue"] as const : /^\.git(ignore|attributes)$/.test(base) ? ["Git", "GIT", "red"] as const : undefined;
  const [label, badge, tone] = named ?? LANGUAGES[extension(base)] ?? KIND_BADGE[fileKind(base)];
  return { label, badge, tone };
}
export function formatBytes(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"]; let value = size / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
export interface FileReference { path: string; line?: number; column?: number }
export function parseFileReference(value: string, explicitLink = false): FileReference | null {
  let text = value.trim();
  if (!text || /^[#?]/.test(text) || /^(?:https?:|mailto:|data:|javascript:|tel:)/i.test(text)) return null;
  if (/^[a-z][\w+.-]*:/i.test(text) && !/^(?:file:|[a-z]:[\\/])/i.test(text)) return null;
  const location = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/.exec(text);
  let path = location ? text.slice(0, location.index) : text;
  try { if (!/^file:/i.test(path)) path = decodeURIComponent(path); } catch { /* A literal percent is also a valid filename. */ }
  if (!explicitLink && (/[\n\r<>{}=]/.test(path))) return null;
  if (!explicitLink && !/[/\\]/.test(path)) {
    const named = ["README", "LICENSE", "Dockerfile", "Makefile", ".gitignore", ".gitattributes", ".env"].includes(path);
    const formats = /\.(?:[cm]?js|jsx|tsx?|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|sh|ps1|sql|json|ya?ml|toml|ini|conf|txt|log|md|mdx|markdown|html?|css|scss|xml|csv|tsv|xlsx?|pdf|png|jpe?g|gif|webp|bmp|avif|svg|mp4|webm|mov|mkv|mp3|wav|ogg|flac|m4a|docx?|pptx?|odt|odp|rtf)$/i.test(path);
    if (!named && (!formats || path.startsWith(".") || !/^[\p{L}\p{N}_ .@+-]+$/u.test(path))) return null;
  }
  return { path, ...(location ? { line: Number(location[1] ?? location[3]), ...(location[2] || location[4] ? { column: Number(location[2] ?? location[4]) } : {}) } : {}) };
}
export function relativeFileReference(base: string, path: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[/\\]|file:)/.test(path)) return path;
  const directory = base.replaceAll("\\", "/").split("/").slice(0, -1).join("/");
  return directory ? `${directory}/${path}` : path;
}
