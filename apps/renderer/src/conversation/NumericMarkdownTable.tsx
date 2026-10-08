import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Element, ElementContent } from "hast";
import { useI18n } from "../i18n";
import { graphicLeasePool } from "../graphics/graphic-pool";
import type { NumericTableData } from "../graphics/native-table-chart";
import { SvgFigureImage } from "../graphics/SvgFigureImage";
function content(node: ElementContent): string {
  return node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(content).join("")
      : "";
}
export function tableData(
  node: Element | undefined,
): NumericTableData | undefined {
  if (!node) return;
  const rows: string[][] = [];
  for (const group of node.children) {
    if (group.type !== "element") continue;
    const candidates =
      group.tagName === "tr"
        ? [group]
        : group.children.filter(
            (row): row is Element =>
              row.type === "element" && row.tagName === "tr",
          );
    for (const row of candidates) {
      if (rows.length > 2000)
        throw new Error("Table exceeds the 2,000 row chart limit");
      rows.push(
        row.children
          .filter(
            (cell): cell is Element =>
              cell.type === "element" && ["th", "td"].includes(cell.tagName),
          )
          .map((cell) => content(cell)),
      );
    }
  }
  if (rows.length < 3) return;
  return { header: rows[0]!, rows: rows.slice(1) };
}
export function NumericMarkdownTable({
  node,
  children,
  streaming,
}: {
  node: Element | undefined;
  children: ReactNode;
  streaming: boolean;
}) {
  const { resolvedLanguage } = useI18n(),
    zh = resolvedLanguage === "zh",
    host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false),
    [open, setOpen] = useState(true),
    [figure, setFigure] = useState<{ svg: string; alt: string }>(),
    [error, setError] = useState("");
  useEffect(() => {
    if (!host.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (rows) => setVisible(rows.some((row) => row.isIntersecting)),
      { rootMargin: "100px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setError("");
    setFigure(undefined);
    if (streaming || !visible || !open || typeof Worker === "undefined") return;
    let data: NumericTableData | undefined;
    try {
      data = tableData(node);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    if (!data) return;
    let current = true,
      failed = false,
      worker: Worker | undefined,
      timer: number | undefined,
      release = () => {};
    const fail = (message: string) => {
      failed = true;
      if (current) setError(message);
      worker?.terminate();
      clearTimeout(timer);
      release();
    };
    try {
      release = graphicLeasePool.request(() => {
        try {
          worker = new Worker(
            new URL("../graphics/table-chart.worker.ts", import.meta.url),
            { type: "module" },
          );
          worker.onmessage = (
            event: MessageEvent<{
              ok: boolean;
              figure?: { svg: string; alt: string };
              error?: string;
            }>,
          ) => {
            if (current) {
              if (event.data.ok) setFigure(event.data.figure);
              else setError(event.data.error ?? "Chart unavailable");
            }
            worker?.terminate();
            clearTimeout(timer);
            release();
          };
          worker.onerror = () =>
            fail(zh ? "无法生成图表" : "Chart unavailable");
          timer = window.setTimeout(
            () =>
              fail(
                zh
                  ? "图表计算超过 2 秒限额"
                  : "Chart exceeded the 2 second limit",
              ),
            2000,
          );
          worker.postMessage(data);
        } catch (cause) {
          fail(String(cause));
        }
      });
      if (failed) release();
    } catch (cause) {
      fail(String(cause));
    }
    return () => {
      current = false;
      worker?.terminate();
      clearTimeout(timer);
      release();
    };
  }, [node, streaming, visible, open, zh]);
  return (
    <div ref={host}>
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
      {figure || error || !open ? (
        <div className="graphic-controls">
          <button
            className="btn small ghost"
            onClick={() => setOpen((value) => !value)}
          >
            {open
              ? zh
                ? "收起图表"
                : "Hide chart"
              : zh
                ? "显示图表"
                : "Show chart"}
          </button>
        </div>
      ) : null}
      {open && figure ? (
        <div className="md-native-table-chart">
          <SvgFigureImage source={figure.svg} alt={figure.alt} />
        </div>
      ) : null}
      {open && error ? (
        <p className="small muted" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
