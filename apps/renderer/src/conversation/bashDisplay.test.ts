import { describe, expect, it } from "vitest";
import { applyCarriageReturns, bashDisplayRows, displayBashOutput, stripAnsi } from "./bashDisplay";

describe("bashDisplay", () => {
  it("strips CSI colors so live npm lines stay readable", () => {
    expect(stripAnsi("\u001b[32mpass\u001b[0m 12")).toBe("pass 12");
  });

  it("applies carriage-return overwrites instead of stacking progress", () => {
    expect(applyCarriageReturns("Building... 10%\rBuilding... 100%")).toBe("Building... 100%");
    expect(applyCarriageReturns("hello\rwo")).toBe("wollo");
  });

  it("displayBashOutput strips ANSI then applies \\r", () => {
    expect(displayBashOutput("\u001b[33mBuilding... 10%\u001b[0m\r\u001b[33mBuilding... 100%\u001b[0m")).toBe(
      "Building... 100%",
    );
  });

  it("bashDisplayRows keeps preview array classes and cleans string output", () => {
    expect(bashDisplayRows([["> tsc --noEmit", "dim"], ["0 errors", "ok"]])).toEqual([
      { text: "> tsc --noEmit", cls: "c-dim" },
      { text: "0 errors", cls: "c-ok" },
    ]);
    expect(bashDisplayRows("\u001b[32mok\u001b[0m\n")).toEqual([
      { text: "ok", cls: "" },
      { text: "", cls: "" },
    ]);
  });
});
