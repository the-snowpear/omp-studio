import { describe, it, expect } from "vitest";
import { fileKind, parseFileReference, relativeFileReference } from "./fileTypes";
describe("file links", () => {
  it("recognizes Windows and workspace links with Chinese names and line locations", () => {
    expect(parseFileReference("D:\\项目\\main.ts:42:8")).toEqual({ path: "D:\\项目\\main.ts", line: 42, column: 8 });
    expect(parseFileReference("/D:/项目/main.ts#L42", true)).toEqual({ path: "/D:/项目/main.ts", line: 42 });
    expect(parseFileReference("docs/说明%20文档.md", true)).toEqual({ path: "docs/说明 文档.md" });
    expect(parseFileReference("https://example.org/report.pdf", true)).toBeNull();
    expect(parseFileReference("#heading", true)).toBeNull();
    expect(parseFileReference("client.query")).toBeNull();
    expect(parseFileReference("说明.md")).toEqual({ path: "说明.md" });
  });
  it("routes Office, spreadsheets, SVG and source HTML to their intended viewers", () => {
    expect(fileKind("REPORT.DOCX")).toBe("office"); expect(fileKind("report.XLSX")).toBe("spreadsheet");
    expect(fileKind("image.svg")).toBe("image"); expect(fileKind("index.html")).toBe("text");
    expect(relativeFileReference("docs/guide.md", "images/chart.png")).toBe("docs/images/chart.png");
  });
});
