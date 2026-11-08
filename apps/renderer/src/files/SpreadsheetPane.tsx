import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { useSurfaceDocument } from "../dock/SurfaceContext";

type Cell = { row: number; column: number; text: string; formula?: string };
type Merge = { s: { r: number; c: number }; e: { r: number; c: number } };
type Sheet = { rows: number; columns: number; merges: Merge[] };
const columnName = (index: number): string => { let result = ""; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; };
export default function SpreadsheetPane({ url }: { url: string }) {
  const surface = useSurfaceDocument(), scroll = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null), sequence = useRef(0), requests = useRef(new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>());
  const [sheets, setSheets] = useState<string[]>([]), [sheet, setSheet] = useState(0), [meta, setMeta] = useState<Sheet>({ rows: 0, columns: 0, merges: [] });
  const [cells, setCells] = useState<Cell[]>([]), [error, setError] = useState("");
  const [selection, setSelection] = useState({ r: 0, c: 0, endR: 0, endC: 0 });
  const request = <T,>(input: object, transfer: Transferable[] = []) => new Promise<T>((resolve, reject) => {
    const id = ++sequence.current; requests.current.set(id, { resolve: value => resolve(value as T), reject }); worker.current!.postMessage({ ...input, id }, transfer);
  });
  useEffect(() => {
    const instance = new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), { type: "module" }); worker.current = instance;
    const controller = new AbortController(); let active = true;
    instance.onmessage = event => { const result = requests.current.get(event.data.id); if (!result) return; requests.current.delete(event.data.id); if (event.data.error) result.reject(new Error(event.data.error)); else result.resolve(event.data.result); };
    instance.onerror = event => { if (active) setError(event.message || "表格解析失败"); };
    setSheets([]); setCells([]); setError(""); setSheet(0);
    void fetch(url, { signal: controller.signal }).then(response => { if (!response.ok) throw new Error("无法读取表格"); return response.arrayBuffer(); }).then(bytes => request<{ sheets: string[] }>({ kind: "open", bytes }, [bytes])).then(result => { if (active) setSheets(result.sheets); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; controller.abort(); instance.terminate(); requests.current.clear(); if (worker.current === instance) worker.current = null; };
  }, [url]);
  useEffect(() => {
    if (!sheets.length) return;
    let active = true;
    void request<Sheet>({ kind: "sheet", sheet }).then(value => { if (active) { setMeta(value); setCells([]); scroll.current?.scrollTo(0, 0); } }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [sheet, sheets]);
  const rows = useVirtualizer({ count: meta.rows, getScrollElement: () => scroll.current, estimateSize: () => 28, overscan: 5, paddingStart: 28 });
  const columns = useVirtualizer({ horizontal: true, count: meta.columns, getScrollElement: () => scroll.current, estimateSize: () => 144, overscan: 2, paddingStart: 48 });
  const visibleRows = rows.getVirtualItems(), visibleColumns = columns.getVirtualItems();
  const startRow = visibleRows[0]?.index ?? 0, endRow = visibleRows.at(-1)?.index ?? 20, startColumn = visibleColumns[0]?.index ?? 0, endColumn = visibleColumns.at(-1)?.index ?? 7;
  useEffect(() => {
    if (!meta.rows || !worker.current || !sheets.length) return;
    let active = true;
    void request<Cell[]>({ kind: "cells", sheet, startRow, endRow: Math.min(endRow, meta.rows - 1), startColumn, endColumn: Math.min(endColumn, meta.columns - 1) }).then(value => { if (active) setCells(value); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [sheet, sheets, meta, startRow, endRow, startColumn, endColumn]);
  const copy = async () => {
    const text = await request<string>({ kind: "copy", sheet, startRow: Math.min(selection.r, selection.endR), endRow: Math.max(selection.r, selection.endR), startColumn: Math.min(selection.c, selection.endC), endColumn: Math.max(selection.c, selection.endC) });
    await surface.defaultView?.navigator.clipboard.writeText(text);
  };
  const selected = `${columnName(Math.min(selection.c, selection.endC))}${Math.min(selection.r, selection.endR) + 1}${selection.r !== selection.endR || selection.c !== selection.endC ? `:${columnName(Math.max(selection.c, selection.endC))}${Math.max(selection.r, selection.endR) + 1}` : ""}`;
  return <div className="file-spreadsheet"><div className="file-subbar">{sheets.length > 1 ? <AppSelect className="file-sheet-select" aria-label="工作表" value={String(sheet)} onChange={event => setSheet(Number(event.target.value))}>{sheets.map((name, index) => <option key={name} value={index}>{name}</option>)}</AppSelect> : <span className="file-subbar-title"><Icon name="table" extra="sm" />{sheets[0] ?? "表格"}</span>}<span className="file-subbar-meta">{meta.rows.toLocaleString()} 行 · {meta.columns.toLocaleString()} 列</span><span className="file-subbar-spacer" /><span className="file-cell-ref" data-tip="当前选区">{selected}</span><button type="button" className="icon-btn" aria-label="复制选区" data-tip="复制选区（Ctrl C）" disabled={!sheets.length} onClick={() => { void copy().catch(error => setError(String(error))); }}><Icon name="copy" extra="sm" /></button><span className="file-tag" data-tip="公式显示已保存的结果"><Icon name="lock" extra="sm" />只读</span></div>
    {error ? <div className="file-banner is-error" role="alert"><Icon name="alert-c" extra="sm" /><span>{error}</span></div> : null}
    {!sheets.length && !error ? <div className="file-empty"><span className="file-badge is-large tone-green is-loading" aria-hidden="true">XLS</span><h3>正在读取表格…</h3></div> : null}
    <div ref={scroll} className="file-grid-scroll" role="grid" tabIndex={0} aria-label="文件表格" aria-rowcount={meta.rows} aria-colcount={meta.columns} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); void copy().catch(error => setError(String(error))); } }}>
      <div className="file-grid-canvas" style={{ height: rows.getTotalSize(), width: columns.getTotalSize() }}>
        {visibleColumns.map(column => <div role="columnheader" key={`c${column.index}`} className="file-grid-cell file-grid-header" style={{ left: column.start, top: 0, width: column.size }}>{columnName(column.index)}</div>)}
        {visibleRows.map(row => <div role="rowheader" key={`r${row.index}`} className="file-grid-cell file-grid-rowhead" style={{ left: 0, top: row.start, width: 48 }}>{row.index + 1}</div>)}
        {cells.map(cell => {
          const merge = meta.merges.find(item => cell.row >= item.s.r && cell.row <= item.e.r && cell.column >= item.s.c && cell.column <= item.e.c);
          if (merge && (cell.row !== merge.s.r || cell.column !== merge.s.c)) return null;
          const selected = cell.row >= Math.min(selection.r, selection.endR) && cell.row <= Math.max(selection.r, selection.endR) && cell.column >= Math.min(selection.c, selection.endC) && cell.column <= Math.max(selection.c, selection.endC);
          return <div key={`${cell.row}:${cell.column}`} role="gridcell" aria-selected={selected} className={`file-grid-cell${selected ? " is-selected" : ""}`} data-tip={cell.formula ? `=${cell.formula}` : undefined} style={{ left: 48 + cell.column * 144, top: 28 + cell.row * 28, width: 144 * (merge ? merge.e.c - merge.s.c + 1 : 1), height: 28 * (merge ? merge.e.r - merge.s.r + 1 : 1) }} onPointerDown={event => { event.preventDefault(); scroll.current?.focus(); setSelection(event.shiftKey ? { ...selection, endR: cell.row, endC: cell.column } : { r: cell.row, c: cell.column, endR: cell.row, endC: cell.column }); }} onPointerEnter={event => { if (event.buttons === 1) setSelection(value => ({ ...value, endR: cell.row, endC: cell.column })); }}>{cell.text}</div>;
        })}
      </div>
    </div>
  </div>;
}
