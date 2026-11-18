import * as XLSX from "xlsx";

type Merge = { s: { r: number; c: number }; e: { r: number; c: number } };
type SheetBounds = { rows: number; columns: number; merges: Merge[] };
type Request =
  | { id: number; kind: "open"; bytes: ArrayBuffer }
  | { id: number; kind: "openText"; text: string }
  | { id: number; kind: "sheet"; sheet: number }
  | { id: number; kind: "cells" | "copy"; sheet: number; startRow: number; endRow: number; startColumn: number; endColumn: number };

const MAX_SAFE_ROWS = 500_000;
const MAX_SAFE_COLUMNS = 16_384;

let workbook: XLSX.WorkBook;
const boundsCache = new Map<number, SheetBounds>();

function hasCellContent(cell: XLSX.CellObject | undefined): boolean {
  if (!cell) return false;
  if (cell.f) return true;
  if (cell.v !== undefined && cell.v !== "") return true;
  if (cell.w !== undefined && cell.w !== "") return true;
  return false;
}

function computeSheetBounds(sheetIndex: number, sheet: XLSX.WorkSheet): SheetBounds {
  const cached = boundsCache.get(sheetIndex);
  if (cached) return cached;
  let maxRow = -1;
  let maxCol = -1;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    if (!hasCellContent(sheet[key] as XLSX.CellObject | undefined)) continue;
    const address = XLSX.utils.decode_cell(key);
    if (address.r > maxRow) maxRow = address.r;
    if (address.c > maxCol) maxCol = address.c;
  }
  const rawMerges = (sheet["!merges"] ?? []) as Merge[];
  for (const merge of rawMerges) {
    const anchor = sheet[XLSX.utils.encode_cell(merge.s)] as XLSX.CellObject | undefined;
    if (hasCellContent(anchor) && merge.e.r - merge.s.r < 10_000 && merge.e.c - merge.s.c < 1_000) {
      if (merge.e.r > maxRow) maxRow = merge.e.r;
      if (merge.e.c > maxCol) maxCol = merge.e.c;
    }
  }
  const rows = maxRow < 0 ? 1 : Math.min(maxRow + 1, MAX_SAFE_ROWS);
  const columns = maxCol < 0 ? 1 : Math.min(maxCol + 1, MAX_SAFE_COLUMNS);
  const merges: Merge[] = [];
  for (const merge of rawMerges) {
    if (merge.s.r >= rows || merge.s.c >= columns) continue;
    merges.push({
      s: merge.s,
      e: { r: Math.min(merge.e.r, rows - 1), c: Math.min(merge.e.c, columns - 1) },
    });
  }
  const computed: SheetBounds = { rows, columns, merges };
  boundsCache.set(sheetIndex, computed);
  return computed;
}

function readCellText(sheet: XLSX.WorkSheet, row: number, column: number): { text: string; formula?: string } {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
  const text = cell ? (cell.v === undefined && cell.f ? "—" : XLSX.utils.format_cell(cell)) : "";
  return cell?.f ? { text, formula: cell.f } : { text };
}

self.onmessage = (event: MessageEvent<Request>) => {
  const input = event.data;
  try {
    if (input.kind === "open") {
      boundsCache.clear();
      workbook = XLSX.read(input.bytes, { type: "array", cellNF: true });
      self.postMessage({ id: input.id, result: { sheets: workbook.SheetNames } }); return;
    }
    if (input.kind === "openText") {
      boundsCache.clear();
      workbook = XLSX.read(input.text, { type: "string", cellNF: true });
      self.postMessage({ id: input.id, result: { sheets: workbook.SheetNames } }); return;
    }
    const sheet = workbook.Sheets[workbook.SheetNames[input.sheet]!]!;
    const bounds = computeSheetBounds(input.sheet, sheet);
    if (input.kind === "sheet") { self.postMessage({ id: input.id, result: bounds }); return; }
    const rows: string[][] = [], cells: { row: number; column: number; text: string; formula?: string }[] = [];
    const seen = new Set<string>();
    const endRow = Math.min(input.endRow, bounds.rows - 1);
    const endColumn = Math.min(input.endColumn, bounds.columns - 1);
    for (let row = input.startRow; row <= endRow; row++) {
      const values: string[] = [];
      for (let column = input.startColumn; column <= endColumn; column++) {
        const { text, formula } = readCellText(sheet, row, column);
        values.push(text);
        if (input.kind === "cells") {
          seen.add(`${row}:${column}`);
          cells.push({ row, column, text, ...(formula ? { formula } : {}) });
        }
      }
      rows.push(values);
    }
    if (input.kind === "cells") {
      for (const merge of bounds.merges) {
        if (merge.e.r < input.startRow || merge.s.r > endRow || merge.e.c < input.startColumn || merge.s.c > endColumn) continue;
        const key = `${merge.s.r}:${merge.s.c}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { text, formula } = readCellText(sheet, merge.s.r, merge.s.c);
        cells.push({ row: merge.s.r, column: merge.s.c, text, ...(formula ? { formula } : {}) });
      }
    }
    self.postMessage({ id: input.id, result: input.kind === "copy" ? rows.map(row => row.join("\t")).join("\n") : cells });
  } catch (error) { self.postMessage({ id: input.id, error: error instanceof Error ? error.message : String(error) }); }
};
