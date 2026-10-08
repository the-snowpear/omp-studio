import { describe, expect, it } from "vitest";
import { nativeTableFigure } from "./native-table-chart";
import { validateSvgFigure } from "./SvgFigureImage";
import { closePartialSvg } from "../../../../omp-patch/vendor/oh-my-pi/packages/tui/src/chat/svg-source";
describe("native Studio figures", () => {
  it("uses native numeric inference and safely escapes table labels in generated charts", () => {
    const figure = nativeTableFigure({
      header: ["Model", "Latency"],
      rows: [
        ["<script>alert(1)</script> & unsafe", "10 ms"],
        ["B", "20 ms"],
        ["C", "40 ms"],
        ["D", "60 ms"],
      ],
    });
    expect(figure?.svg).not.toContain("<script>");
    expect(figure?.svg).toContain("&amp;");
    expect(figure?.alt).toContain("Latency");
    expect(
      nativeTableFigure({
        header: ["Name", "Status"],
        rows: [
          ["A", "Ready"],
          ["B", "Stopped"],
        ],
      }),
    ).toBeUndefined();
  });
  it("rejects chart requests beyond the explicit row budget", () => {
    expect(() =>
      nativeTableFigure({
        header: ["X", "Y"],
        rows: Array.from({ length: 2001 }, (_, i) => [
          String(i),
          String(i * i),
        ]),
      }),
    ).toThrow(/2,000 row/);
  });
  it("closes streamed SVG with the native helper and rejects executable or external resources", () => {
    const closed = closePartialSvg(
      '<svg viewBox="0 0 100 50"><g><rect width="12" height="8"/><path d="',
    );
    expect(closed).toBe(
      '<svg viewBox="0 0 100 50"><g><rect width="12" height="8"/></g></svg>',
    );
    validateSvgFigure(closed!);
    validateSvgFigure(
      '<svg><defs><linearGradient id="a"/></defs><rect fill="url(#a)" width="12" height="8"/></svg>',
    );
    expect(() =>
      validateSvgFigure(
        '<svg><image href="https://example.com/private.png"/></svg>',
      ),
    ).toThrow(/external/);
    expect(() =>
      validateSvgFigure("<svg><script>alert(1)</script></svg>"),
    ).toThrow(/Executable/);
    expect(() => validateSvgFigure('<svg onload="alert(1)"/>')).toThrow(
      /event handlers/,
    );
    expect(() => validateSvgFigure("<svg><rect></svg>")).toThrow(
      /incomplete|invalid/,
    );
  });
});
