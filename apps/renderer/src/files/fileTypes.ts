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
