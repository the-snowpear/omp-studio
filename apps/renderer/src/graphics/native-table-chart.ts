import { analyzeTable } from "../../../../omp-patch/vendor/oh-my-pi/packages/tui/src/charts/table-data";
import {
  buildChart,
  planChart,
  worthCharting,
} from "../../../../omp-patch/vendor/oh-my-pi/packages/tui/src/charts/chart-plan";
import { renderChartSvg } from "../../../../omp-patch/vendor/oh-my-pi/packages/tui/src/charts/chart-svg";
export interface NumericTableData {
  header: string[];
  rows: string[][];
}
export function nativeTableFigure(
  data: NumericTableData,
): { svg: string; alt: string } | undefined {
  if (data.header.length < 2 || data.header.length > 8 || data.rows.length < 2)
    return;
  if (data.rows.length > 2000 || JSON.stringify(data).length > 256000)
    throw new Error("Table exceeds the 2,000 row / 256 kB chart limit");
  if (
    data.header.some((cell) => typeof cell !== "string" || cell.length > 256) ||
    data.rows.some(
      (row) =>
        row.length !== data.header.length ||
        row.some((cell) => typeof cell !== "string" || cell.length > 256),
    )
  )
    throw new Error("Table cells exceed the chart limit");
  const analysis = analyzeTable(data.header, data.rows),
    plan = planChart(analysis);
  if (!plan) return;
  const spec = buildChart(analysis, plan);
  if (!spec || !worthCharting(spec)) return;
  // Upstream returns the SVG document; its size and screen-reader label live on the root element.
  const svg = renderChartSvg(spec);
  const root = /^<svg\b[^>]*>/u.exec(svg)?.[0] ?? "";
  const width = Number(/\swidth="(\d+(?:\.\d+)?)"/u.exec(root)?.[1] ?? Number.NaN);
  const height = Number(/\sheight="(\d+(?:\.\d+)?)"/u.exec(root)?.[1] ?? Number.NaN);
  if (!(width <= 4096) || !(height <= 4096) || svg.length > 800000)
    throw new Error("Chart exceeds the 4,096 px / 800 kB figure limit");
  return { svg, alt: unescapeXml(/\saria-label="([^"]*)"/u.exec(root)?.[1] ?? "") };
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
