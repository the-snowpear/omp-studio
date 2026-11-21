import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createSpreadsheetWorkerRuntime } from "./spreadsheet.worker";

describe("spreadsheet worker", () => {
  it("reads and copies populated cells beyond row 500,000", () => {
    const sheet = XLSX.utils.aoa_to_sheet([["first"]]);
    sheet.A500002 = { t: "s", v: "late value" };
    sheet.B500002 = { t: "s", v: "last value" };
    sheet["!ref"] = "A1:B500002";
    const workbook: XLSX.WorkBook = { SheetNames: ["Data"], Sheets: { Data: sheet } };
    const encoded = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const bytes = new Uint8Array(encoded).buffer as ArrayBuffer;
    const handle = createSpreadsheetWorkerRuntime();

    expect(handle({ id: 1, kind: "open", bytes })).toMatchObject({ id: 1, result: { sheets: ["Data"] } });
    expect(handle({ id: 2, kind: "sheet", sheet: 0 })).toMatchObject({ id: 2, result: { rows: 500_002, columns: 2 } });
    expect(handle({ id: 3, kind: "cells", sheet: 0, startRow: 500_001, endRow: 500_001, startColumn: 0, endColumn: 0 }))
      .toMatchObject({ id: 3, result: [{ row: 500_001, column: 0, text: "late value" }] });
    expect(handle({ id: 4, kind: "copy", sheet: 0, startRow: 0, endRow: 500_001, startColumn: 0, endColumn: 1 }))
      .toEqual({ id: 4, result: { tooLarge: true } });
    expect(handle({ id: 5, kind: "copy", sheet: 0, startRow: 500_001, endRow: 500_001, startColumn: 0, endColumn: 0 }))
      .toEqual({ id: 5, result: { text: "late value" } });
  });
});
