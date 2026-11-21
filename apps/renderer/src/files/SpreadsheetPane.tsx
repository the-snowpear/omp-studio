import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import type { SpreadsheetCopyResult } from "./spreadsheet.worker";

type Cell = { row: number; column: number; text: string; formula?: string };
type Merge = { s: { r: number; c: number }; e: { r: number; c: number } };
type Sheet = { rows: number; columns: number; merges: Merge[]; truncatedRows: boolean; truncatedColumns: boolean };
const columnName = (index: number): string => { let result = ""; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; };
export default function SpreadsheetPane({ url, text }: { url?: string | undefined; text?: string | undefined }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const gridId = useId().replace(/:/g, "");
  const surface = useSurfaceDocument(), scroll = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null), sequence = useRef(0), openGeneration = useRef(0);
  const [workerReady, setWorkerReady] = useState(false);
  const requests = useRef(new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>());
  const [sheets, setSheets] = useState<string[]>([]), [sheet, setSheet] = useState(0), [workbookVersion, setWorkbookVersion] = useState(0), [meta, setMeta] = useState<Sheet>({ rows: 0, columns: 0, merges: [], truncatedRows: false, truncatedColumns: false });
  const [cells, setCells] = useState<Cell[]>([]), [error, setError] = useState("");
  const [copyTooLarge, setCopyTooLarge] = useState(false);
  const [selection, setSelection] = useState({ r: 0, c: 0, endR: 0, endC: 0 });
  const request = <T,>(input: object, transfer: Transferable[] = []) => new Promise<T>((resolve, reject) => {
    const instance = worker.current;
    if (!instance) { reject(new Error(zhRef.current ? "表格工作线程未就绪" : "Spreadsheet worker not ready")); return; }
    const id = ++sequence.current;
    requests.current.set(id, { resolve: value => resolve(value as T), reject });
    try { instance.postMessage({ ...input, id }, transfer); }
    catch (error) { requests.current.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
  });
  useEffect(() => {
    const instance = new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), { type: "module" });
    worker.current = instance;
    setWorkerReady(true);
    let active = true;
    instance.onmessage = event => { const result = requests.current.get(event.data.id); if (!result) return; requests.current.delete(event.data.id); if (event.data.error) result.reject(new Error(event.data.error)); else result.resolve(event.data.result); };
    instance.onerror = event => {
      const error = new Error(event.message || (zhRef.current ? "表格解析失败" : "Failed to parse spreadsheet"));
      for (const pending of requests.current.values()) pending.reject(error);
      requests.current.clear();
      if (active) setError(error.message);
    };
    return () => {
      active = false;
      setWorkerReady(false);
      instance.terminate();
      for (const pending of requests.current.values()) pending.reject(new Error("Worker terminated"));
      requests.current.clear();
      if (worker.current === instance) worker.current = null;
    };
  }, []);
  useEffect(() => {
    if (!workerReady || (text === undefined && !url)) return;
    const controller = new AbortController();
    const generation = ++openGeneration.current;
    let active = true;
    setError("");
    setCopyTooLarge(false);
    if (text === undefined) {
      setSheets([]); setCells([]); setSheet(0);
      setMeta({ rows: 0, columns: 0, merges: [], truncatedRows: false, truncatedColumns: false });
      setSelection({ r: 0, c: 0, endR: 0, endC: 0 });
    }
    const loadPromise = text !== undefined
      ? request<{ sheets: string[] }>({ kind: "openText", text })
      : fetch(url!, { signal: controller.signal })
          .then(response => { if (!response.ok) throw new Error(zhRef.current ? "无法读取表格" : "Unable to read spreadsheet"); return response.arrayBuffer(); })
          .then(bytes => request<{ sheets: string[] }>({ kind: "open", bytes }, [bytes]));
    void loadPromise.then(result => {
      if (!active || generation !== openGeneration.current) return;
      setSheets(result.sheets);
      setSheet(prev => (prev < result.sheets.length ? prev : 0));
      setWorkbookVersion(value => value + 1);
    }).catch(cause => {
      if (active && generation === openGeneration.current && !controller.signal.aborted) setError(String(cause));
    });
    return () => { active = false; controller.abort(); };
  }, [workerReady, url, text]);
  useEffect(() => {
    if (!sheets.length || !workbookVersion) return;
    let active = true;
    void request<Sheet>({ kind: "sheet", sheet }).then(value => {
      if (!active) return;
      setMeta(value);
      setSelection(prev => ({
        r: Math.min(prev.r, Math.max(0, value.rows - 1)),
        c: Math.min(prev.c, Math.max(0, value.columns - 1)),
        endR: Math.min(prev.endR, Math.max(0, value.rows - 1)),
        endC: Math.min(prev.endC, Math.max(0, value.columns - 1)),
      }));
      if (text === undefined) { setCells([]); scroll.current?.scrollTo(0, 0); }
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [sheet, sheets.length, workbookVersion]);
  const rows = useVirtualizer({ count: meta.rows, getScrollElement: () => scroll.current, estimateSize: () => 28, overscan: 5, paddingStart: 28 });
  const columns = useVirtualizer({ horizontal: true, count: meta.columns, getScrollElement: () => scroll.current, estimateSize: () => 144, overscan: 2, paddingStart: 48 });
  const visibleRows = rows.getVirtualItems(), visibleColumns = columns.getVirtualItems();
  const startRow = visibleRows[0]?.index ?? 0, endRow = visibleRows.at(-1)?.index ?? 20, startColumn = visibleColumns[0]?.index ?? 0, endColumn = visibleColumns.at(-1)?.index ?? 7;
  const cellsByRow = useMemo(() => {
    const grouped = new Map<number, Cell[]>();
    for (const cell of cells) {
      const row = grouped.get(cell.row);
      if (row) row.push(cell); else grouped.set(cell.row, [cell]);
    }
    return grouped;
  }, [cells]);
  const visibleMerges = useMemo(
    () => meta.merges.filter(item => item.e.r >= startRow && item.s.r <= endRow && item.e.c >= startColumn && item.s.c <= endColumn),
    [meta.merges, startRow, endRow, startColumn, endColumn],
  );
  useEffect(() => {
    if (!meta.rows || !worker.current || !sheets.length || !workbookVersion) return;
    let active = true;
    void request<Cell[]>({ kind: "cells", sheet, startRow, endRow: Math.min(endRow, meta.rows - 1), startColumn, endColumn: Math.min(endColumn, meta.columns - 1) }).then(value => { if (active) setCells(value); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [sheet, sheets.length, workbookVersion, meta, startRow, endRow, startColumn, endColumn]);
  const copy = async () => {
    if (!meta.rows) return;
    const result = await request<SpreadsheetCopyResult>({ kind: "copy", sheet, startRow: Math.min(selection.r, selection.endR), endRow: Math.max(selection.r, selection.endR), startColumn: Math.min(selection.c, selection.endC), endColumn: Math.max(selection.c, selection.endC) });
    setCopyTooLarge("tooLarge" in result);
    if ("text" in result) await surface.defaultView?.navigator.clipboard.writeText(result.text);
  };
  const selected = `${columnName(Math.min(selection.c, selection.endC))}${Math.min(selection.r, selection.endR) + 1}${selection.r !== selection.endR || selection.c !== selection.endC ? `:${columnName(Math.max(selection.c, selection.endC))}${Math.max(selection.r, selection.endR) + 1}` : ""}`;
  const activeCell = `${gridId}-cell-${sheet}-${selection.endR}-${selection.endC}`;
  const moveSelection = (row: number, column: number, extend: boolean) => {
    const nextRow = Math.max(0, Math.min(Math.max(0, meta.rows - 1), row));
    const nextColumn = Math.max(0, Math.min(Math.max(0, meta.columns - 1), column));
    setSelection(value => extend
      ? { ...value, endR: nextRow, endC: nextColumn }
      : { r: nextRow, c: nextColumn, endR: nextRow, endC: nextColumn });
  };
  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextRow = selection.endR, nextColumn = selection.endC;
    switch (event.key) {
      case "ArrowUp": nextRow--; break;
      case "ArrowDown": nextRow++; break;
      case "ArrowLeft": nextColumn--; break;
      case "ArrowRight": nextColumn++; break;
      case "Home": nextColumn = 0; if (event.ctrlKey || event.metaKey) nextRow = 0; break;
      case "End": nextColumn = Math.max(0, meta.columns - 1); if (event.ctrlKey || event.metaKey) nextRow = Math.max(0, meta.rows - 1); break;
      case "PageUp": nextRow -= Math.max(1, Math.floor((scroll.current?.clientHeight || 280) / 28) - 1); break;
      case "PageDown": nextRow += Math.max(1, Math.floor((scroll.current?.clientHeight || 280) / 28) - 1); break;
      default: return;
    }
    event.preventDefault();
    moveSelection(nextRow, nextColumn, event.shiftKey);
  };
  useEffect(() => {
    const element = scroll.current;
    if (!element || !meta.rows || !meta.columns) return;
    const top = 28 + selection.endR * 28, bottom = top + 28;
    const left = 48 + selection.endC * 144, right = left + 144;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
  }, [selection.endR, selection.endC, meta.rows, meta.columns]);
  const activeCellRendered = cells.some(cell => cell.row === selection.endR && cell.column === selection.endC)
    && !visibleMerges.some(item => selection.endR >= item.s.r && selection.endR <= item.e.r && selection.endC >= item.s.c && selection.endC <= item.e.c && (selection.endR !== item.s.r || selection.endC !== item.s.c));
  const activeRowVisible = visibleRows.some(row => row.index === selection.endR);
  return <div className="file-spreadsheet"><div className="file-subbar">{sheets.length > 1 ? <AppSelect className="file-sheet-select" aria-label={zh ? "工作表" : "Sheet"} value={String(sheet)} onChange={event => { setCells([]); setMeta({ rows: 0, columns: 0, merges: [], truncatedRows: false, truncatedColumns: false }); setSheet(Number(event.target.value)); }}>{sheets.map((name, index) => <option key={name} value={index}>{name}</option>)}</AppSelect> : <span className="file-subbar-title"><Icon name="table" extra="sm" />{sheets[0] ?? (zh ? "表格" : "Sheet")}</span>}<span className="file-subbar-meta">{zh ? `${meta.rows.toLocaleString()} 行 · ${meta.columns.toLocaleString()} 列` : `${meta.rows.toLocaleString()} rows · ${meta.columns.toLocaleString()} cols`}</span><span className="file-subbar-spacer" /><span className="file-cell-ref" data-tip={zh ? "当前选区" : "Current selection"}>{selected}</span><button type="button" className="icon-btn" aria-label={zh ? "复制选区" : "Copy selection"} data-tip={zh ? "复制选区（Ctrl C）" : "Copy selection (Ctrl C)"} disabled={!sheets.length} onClick={() => { void copy().catch(error => setError(String(error))); }}><Icon name="copy" extra="sm" /></button><span className="file-tag" data-tip={zh ? "公式显示已保存的结果" : "Formulas show saved values"}><Icon name="lock" extra="sm" />{zh ? "只读" : "Read-only"}</span></div>
    {meta.truncatedRows || meta.truncatedColumns ? <div className="file-banner is-warning" role="status">{zh ? `此工作表超出 Excel 的${meta.truncatedRows ? "行" : ""}${meta.truncatedRows && meta.truncatedColumns ? "和" : ""}${meta.truncatedColumns ? "列" : ""}数上限，部分内容未显示。` : `This sheet exceeds Excel's ${meta.truncatedRows ? "row" : ""}${meta.truncatedRows && meta.truncatedColumns ? " and " : ""}${meta.truncatedColumns ? "column" : ""} limit; some content is not shown.`}</div> : null}
    {copyTooLarge ? <div className="file-banner is-warning" role="status">{zh ? "选区太大，无法一次复制。请缩小选区后重试。" : "The selection is too large to copy at once. Select a smaller range and try again."}</div> : null}
    {error ? <div className="file-banner is-error" role="alert"><Icon name="alert-c" extra="sm" /><span>{error}</span></div> : null}
    {!sheets.length && !error ? <div className="file-empty"><span className="file-badge is-large tone-green is-loading" aria-hidden="true">XLS</span><h3>{zh ? "正在读取表格…" : "Loading spreadsheet…"}</h3></div> : null}
    <div ref={scroll} className="file-grid-scroll" role="grid" tabIndex={0} aria-label={zh ? "文件表格" : "Spreadsheet"} aria-rowcount={meta.rows + 1} aria-colcount={meta.columns + 1} aria-activedescendant={activeCell} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); void copy().catch(error => setError(String(error))); } else onGridKeyDown(event); }}>
      <div className="file-grid-canvas" style={{ height: rows.getTotalSize(), width: columns.getTotalSize() }}>
        <div className="file-grid-row" role="row" aria-rowindex={1} style={{ top: 0, height: 28, width: columns.getTotalSize() }}>
          <div role="columnheader" aria-colindex={1} className="file-grid-cell file-grid-header" style={{ left: 0, top: 0, width: 48 }} />
          {visibleColumns.map(column => <div role="columnheader" aria-colindex={column.index + 2} key={`c${column.index}`} className="file-grid-cell file-grid-header" style={{ left: column.start, top: 0, width: column.size }}>{columnName(column.index)}</div>)}
        </div>
        {visibleRows.map(row => <div className="file-grid-row" role="row" aria-rowindex={row.index + 2} key={`r${row.index}`} style={{ top: row.start, height: row.size, width: columns.getTotalSize() }}>
          <div role="rowheader" aria-colindex={1} className="file-grid-cell file-grid-rowhead" style={{ left: 0, top: 0, width: 48 }}>{row.index + 1}</div>
          {(cellsByRow.get(row.index) ?? []).map(cell => {
            const merge = visibleMerges.find(item => cell.row >= item.s.r && cell.row <= item.e.r && cell.column >= item.s.c && cell.column <= item.e.c);
            if (merge && (cell.row !== merge.s.r || cell.column !== merge.s.c)) return null;
            const selected = cell.row >= Math.min(selection.r, selection.endR) && cell.row <= Math.max(selection.r, selection.endR) && cell.column >= Math.min(selection.c, selection.endC) && cell.column <= Math.max(selection.c, selection.endC);
            const active = cell.row === selection.endR && cell.column === selection.endC;
            return <div id={`${gridId}-cell-${sheet}-${cell.row}-${cell.column}`} key={`${cell.row}:${cell.column}`} role="gridcell" aria-rowindex={cell.row + 2} aria-colindex={cell.column + 2} aria-selected={selected} className={`file-grid-cell${selected ? " is-selected" : ""}${active ? " is-active" : ""}`} data-tip={cell.formula ? `=${cell.formula}` : undefined} style={{ left: 48 + cell.column * 144, top: 0, width: 144 * (merge ? merge.e.c - merge.s.c + 1 : 1), height: 28 * (merge ? merge.e.r - merge.s.r + 1 : 1) }} onPointerDown={event => { event.preventDefault(); scroll.current?.focus(); setSelection(event.shiftKey ? { ...selection, endR: cell.row, endC: cell.column } : { r: cell.row, c: cell.column, endR: cell.row, endC: cell.column }); }} onPointerEnter={event => { if (event.buttons === 1) setSelection(value => ({ ...value, endR: cell.row, endC: cell.column })); }}>{cell.text}</div>;
          })}
          {!activeCellRendered && row.index === selection.endR ? <div id={activeCell} className="file-grid-active-descendant" role="gridcell" aria-rowindex={selection.endR + 2} aria-colindex={selection.endC + 2} aria-selected="true" aria-label={zh ? `活动单元格 ${selected}` : `Active cell ${selected}`} /> : null}
        </div>)}
        {!activeCellRendered && !activeRowVisible ? <div className="file-grid-row file-grid-active-row" role="row" aria-rowindex={selection.endR + 2} style={{ top: 28 + selection.endR * 28, height: 28, width: columns.getTotalSize() }}><div id={activeCell} className="file-grid-active-descendant" role="gridcell" aria-rowindex={selection.endR + 2} aria-colindex={selection.endC + 2} aria-selected="true" aria-label={zh ? `活动单元格 ${selected}` : `Active cell ${selected}`} /></div> : null}
      </div>
    </div>
  </div>;
}
