import type { ReactNode } from "react";
import { Icon } from "../icons";
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
  return <footer className="file-status" aria-label="文件状态">
    <div className="file-status-group">
      {cursor ? <button type="button" className="file-status-item is-button" data-tip="跳转到行（Ctrl G）" onClick={onGoto}>行 {cursor.line}，列 {cursor.column}</button> : null}
      {cursor?.selected ? <span className="file-status-item">已选 {cursor.selected} 字符{cursor.selectedLines > 1 ? `（${cursor.selectedLines} 行）` : ""}</span> : null}
      {git && (git.additions || git.deletions) ? <span className="file-status-item file-status-git" data-tip="工作区改动"><Icon name="branch" extra="sm" />{git.additions ? <b className="add">+{git.additions}</b> : null}{git.deletions ? <b className="del">−{git.deletions}</b> : null}</span> : null}
      {extra}
    </div>
    <div className="file-status-group">
      <span className="file-status-item">{language}</span>
      {format ? <span className="file-status-item">{ENCODING[format.encoding]}{format.bom ? " BOM" : ""}</span> : null}
      {format ? <span className="file-status-item">{format.lineEnding === "crlf" ? "CRLF" : "LF"}</span> : null}
      {size ? <span className="file-status-item">{size}</span> : null}
      {fontSize && defaultFontSize && fontSize !== defaultFontSize ? <button type="button" className="file-status-item is-button" data-tip="重置字号（Ctrl 0）" onClick={onResetFont}>{Math.round(fontSize / defaultFontSize * 100)}%</button> : null}
      {saved ? <span className={`file-status-item file-save-state is-${saved}`}>{saved === "saving" ? "保存中…" : saved === "dirty" ? <><i aria-hidden="true" />未保存</> : <><Icon name="check" extra="sm" />已保存</>}</span> : null}
    </div>
  </footer>;
}
