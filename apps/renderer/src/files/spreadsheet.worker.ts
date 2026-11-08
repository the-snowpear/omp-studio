import * as XLSX from "xlsx";
let workbook: XLSX.WorkBook;
type Request = { id: number; kind: "open"; bytes: ArrayBuffer } | { id: number; kind: "sheet"; sheet: number } | { id: number; kind: "cells" | "copy"; sheet: number; startRow: number; endRow: number; startColumn: number; endColumn: number };
self.onmessage = (event: MessageEvent<Request>) => {
  const input = event.data;
  try {
    if (input.kind === "open") {
      workbook = XLSX.read(input.bytes, { type: "array", cellNF: true });
      self.postMessage({ id: input.id, result: { sheets: workbook.SheetNames } }); return;
    }
    const sheet = workbook.Sheets[workbook.SheetNames[input.sheet]!]!;
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
    if (input.kind === "sheet") { self.postMessage({ id: input.id, result: { rows: range.e.r + 1, columns: range.e.c + 1, merges: sheet["!merges"] ?? [] } }); return; }
    const rows: string[][] = [], cells: { row: number; column: number; text: string; formula?: string }[] = [];
    for (let row = input.startRow; row <= input.endRow; row++) {
      const values: string[] = [];
      for (let column = input.startColumn; column <= input.endColumn; column++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
        const text = cell ? cell.v === undefined && cell.f ? "—" : XLSX.utils.format_cell(cell) : "";
        values.push(text); if (input.kind === "cells") cells.push({ row, column, text, ...(cell?.f ? { formula: cell.f } : {}) });
      }
      rows.push(values);
    }
    self.postMessage({ id: input.id, result: input.kind === "copy" ? rows.map(row => row.join("\t")).join("\n") : cells });
  } catch (error) { self.postMessage({ id: input.id, error: error instanceof Error ? error.message : String(error) }); }
};
