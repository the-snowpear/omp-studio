import type { ReactNode } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import type { EditorCursor } from "./FileTextEditor";
import type { TextFormat } from "./fileDocuments";

const ENCODING = { utf8: "UTF-8", utf16le: "UTF-16 LE", utf16be: "UTF-16 BE" } as const;
/** Bottom strip: caret / selection, Git delta and file facts, like an editor status bar. */
export function FileStatusBar({ cursor, onGoto, git, language, format, size, fontSize, defaultFontSize, onResetFont, saved, extra }: {
  cursor?: EditorCursor | null | undefined; onGoto?: (() => void) | undefined;
  git?: { additions: number; deletions: number } | null | undefined;
  language: string; format?: TextFormat | undefined; size: string; fontSize?: number | undefined; defaultFontSize?: number | undefined; onResetFont?: (() => void) | undefined;
  saved?: "saved" | "dirty" | "saving" | undefined; extra?: ReactNode;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  return <footer className="file-status" aria-label={zh ? "文件状态" : "File status"}>
    <div className="file-status-group">
      {cursor ? <button type="button" className="file-status-item is-button" data-tip={zh ? "跳转到行（Ctrl G）" : "Go to line (Ctrl G)"} onClick={onGoto}>{zh ? `行 ${cursor.line}，列 ${cursor.column}` : `Ln ${cursor.line}, Col ${cursor.column}`}</button> : null}
      {cursor?.selected ? <span className="file-status-item">{zh ? `已选 ${cursor.selected} 字符${cursor.selectedLines > 1 ? `（${cursor.selectedLines} 行）` : ""}` : `${cursor.selected} selected${cursor.selectedLines > 1 ? ` (${cursor.selectedLines} lines)` : ""}`}</span> : null}
      {git && (git.additions || git.deletions) ? <span className="file-status-item file-status-git" data-tip={zh ? "工作区改动" : "Working-tree changes"}><Icon name="branch" extra="sm" />{git.additions ? <b className="add">+{git.additions}</b> : null}{git.deletions ? <b className="del">−{git.deletions}</b> : null}</span> : null}
      {extra}
    </div>
    <div className="file-status-group">
      <span className="file-status-item">{language}</span>
      {format ? <span className="file-status-item">{ENCODING[format.encoding]}{format.bom ? " BOM" : ""}</span> : null}
      {format ? <span className="file-status-item">{format.lineEnding === "crlf" ? "CRLF" : "LF"}</span> : null}
      {size ? <span className="file-status-item">{size}</span> : null}
      {fontSize && defaultFontSize && fontSize !== defaultFontSize ? <button type="button" className="file-status-item is-button" data-tip={zh ? "重置字号（Ctrl 0）" : "Reset font size (Ctrl 0)"} onClick={onResetFont}>{Math.round(fontSize / defaultFontSize * 100)}%</button> : null}
      {saved ? <span className={`file-status-item file-save-state is-${saved}`}>{saved === "saving" ? (zh ? "保存中…" : "Saving…") : saved === "dirty" ? <><i aria-hidden="true" />{zh ? "未保存" : "Unsaved"}</> : <><Icon name="check" extra="sm" />{zh ? "已保存" : "Saved"}</>}</span> : null}
    </div>
  </footer>;
}
