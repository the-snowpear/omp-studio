import { SvgFigureImage } from "./SvgFigureImage";
import { graphicLeasePool } from "./graphic-pool";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { GRAPHIC_MAX_BYTES, type GraphicResult } from "./graphic-types";
import { useI18n } from "../i18n";
import { LazyMermaid } from "../conversation/LazyMermaid";
import "./graphics.css";
const GraphicScene = lazy(() => import("./GraphicScene"));
export function GraphicPreview({
  name,
  src,
  text,
}: {
  name: string;
  src?: string;
  text?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const failure = useRef<(reason: string) => void>(() => {});
  const renderFailure = useCallback((reason: string) => failure.current(reason), []);
  const [visible, setVisible] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [result, setResult] = useState<GraphicResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "100px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || collapsed) return;
    if (typeof Worker === "undefined") {
      setError(
        zh ? "当前环境不支持图形 Worker" : "Graphics workers are unavailable",
      );
      return;
    }
    let active = true;
    let current: GraphicResult | undefined;
    const abort = new AbortController();
    let worker: Worker | undefined;
    let releaseSlot = () => {};
    setBusy(true);
    setError("");
    setResult(undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const release = (value: GraphicResult | undefined) => {
      if (value?.kind === "scene")
        for (const bitmap of value.images) bitmap.close();
    };
    const fail = (reason: string) => {
      if (active) {
        setError(reason);
        setBusy(false);
        setResult(undefined);
      }
      clearTimeout(deadline);
      abort.abort();
      worker?.terminate();
      releaseSlot();
      release(current); current = undefined;
    };
    failure.current = fail;
    const startWorker = () => {
      worker = new Worker(new URL("./graphic.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (
        event: MessageEvent<{
          ok: boolean;
          result?: GraphicResult;
          error?: string;
        }>,
      ) => {
        clearTimeout(deadline);
        worker?.terminate();
        if (!active) {
          release(event.data.result);
          return;
        }
        if (!event.data.ok || !event.data.result) {
          fail(event.data.error ?? "Graphic parsing failed");
          return;
        }
        current = event.data.result;
        setResult(current);
        setBusy(false);
      };
      worker.onerror = () =>
        fail(zh ? "图形解析失败" : "Graphic parsing failed");
      const run = async () => {
        let bytes: ArrayBuffer;
        if (text !== undefined) bytes = new TextEncoder().encode(text).buffer;
        else {
          if (!src) throw new Error("Graphic source is unavailable");
          const response = await fetch(src, { signal: abort.signal });
          if (!response.ok) throw new Error("Cannot read graphic file");
          if (
            Number(response.headers.get("content-length")) > GRAPHIC_MAX_BYTES
          )
            throw new Error("Graphic exceeds 32 MiB");
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Graphic stream is unavailable");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const step = await reader.read();
              if (step.done) break;
              size += step.value.byteLength;
              if (size > GRAPHIC_MAX_BYTES)
                throw new Error("Graphic exceeds 32 MiB");
              chunks.push(step.value);
            }
          } finally {
            await reader.cancel();
          }
          const buffer = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
          }
          bytes = buffer.buffer;
        }
        if (!active) return;
        deadline = setTimeout(
          () =>
            fail(
              zh
                ? "图形解析超过 8 秒限额"
                : "Graphic parsing exceeded the 8 second limit",
            ),
          8000,
        );
        worker!.postMessage({ name, data: bytes }, [bytes]);
      };
      void run().catch((cause) => {
        if (!abort.signal.aborted)
          fail(cause instanceof Error ? cause.message : String(cause));
      });
    };
    try {
      releaseSlot = graphicLeasePool.request(() => {
        try {
          startWorker();
        } catch (cause) {
          fail(String(cause));
        }
      });
      if (abort.signal.aborted) releaseSlot();
    } catch (cause) {
      fail(String(cause));
    }
    return () => {
      active = false;
      if (failure.current === fail) failure.current = () => {};
      abort.abort();
      clearTimeout(deadline);
      worker?.terminate();
      releaseSlot();
      release(current);
      setBusy(false);
      setResult(undefined);
    };
  }, [visible, collapsed, name, src, text, zh]);
  return (
    <div className="graphic-preview" ref={host}>
      <div className="graphic-controls">
        <span>{name}</span>
        <button
          className="btn small outline"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed
            ? zh
              ? "打开预览"
              : "Open preview"
            : zh
              ? "关闭预览"
              : "Close preview"}
        </button>
      </div>
      {busy ? (
        <p role="status">{zh ? "正在准备预览…" : "Preparing preview…"}</p>
      ) : null}
      {error ? (
        <div role="alert" className="graphic-failure"><strong>{zh ? "无法显示此图形" : "This graphic could not be displayed"}</strong><p>{error}</p></div>
      ) : null}
      {visible && !collapsed && result?.kind === "scene" ? (
        <Suspense fallback={<p>{zh ? "加载预览…" : "Loading preview…"}</p>}>
          <GraphicScene data={result} onFailure={renderFailure} />
          {result.warnings.map((warning) => (
            <p className="muted small" key={warning}>
              {warning}
            </p>
          ))}
        </Suspense>
      ) : visible && !collapsed && result?.kind === "document" ? (
        <GraphicDocument result={result} onFailure={renderFailure} />
      ) : null}
    </div>
  );
}
function GraphicDocument({
  result, onFailure,
}: {
  result: Extract<GraphicResult, { kind: "document" }>;
  onFailure: (reason: string) => void;
}) {
  const { bundle } = result;
  const source = new TextDecoder().decode(bundle.bytes);
  if (bundle.format === "svg") return <SvgFigureImage source={source} alt={bundle.name} onFailure={onFailure}/>;
  if (bundle.format === "mermaid" || bundle.format === "mmd")
    return <LazyMermaid code={source} onFailure={onFailure} />;
  if (bundle.format === "chart") return <NumericChart source={source} onFailure={onFailure} />;
  return (
    <X3DPreview
      onFailure={onFailure}
      source={source}
      resources={bundle.resources}
      name={bundle.name}
    />
  );
}
function GraphicParseFailure({ message, onFailure }: { message: string; onFailure: (reason: string) => void }) {
 useEffect(() => onFailure(message), [message, onFailure]);
 return null;
}
function NumericChart({ source, onFailure }: { source: string; onFailure: (reason: string) => void }) {
  const { resolvedLanguage } = useI18n();
  try {
    const data = JSON.parse(source) as { columns: string[]; rows: number[][] };
    if (
      !Array.isArray(data.columns) ||
      data.columns.length < 2 ||
      data.columns.length > 8 ||
      !Array.isArray(data.rows) ||
      data.rows.length < 2 ||
      data.rows.length > 2000 ||
      data.rows.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== data.columns.length ||
          row.some(
            (value) => typeof value !== "number" || !Number.isFinite(value),
          ),
      )
    )
      throw new Error("Expected 2–8 columns and 2–2000 finite numeric rows");
    const xs = data.rows.map((row) => row[0]!);
    const ys = data.rows.flatMap((row) => row.slice(1));
    const xmin = Math.min(...xs),
      xmax = Math.max(...xs),
      ymin = Math.min(...ys),
      ymax = Math.max(...ys);
    const colors = [
      "var(--accent)",
      "var(--green)",
      "var(--orange)",
      "var(--blue)",
      "var(--red)",
      "var(--text-2)",
      "var(--text-3)",
    ];
    return (
      <div>
        <svg
          className="graphic-chart"
          viewBox="0 0 600 320"
          role="img"
          aria-label={data.columns.join(", ")}
        >
          <path d="M50 20V280H580" fill="none" stroke="var(--border)" />
          {data.columns.slice(1).map((column, index) => (
            <polyline
              key={index}
              points={data.rows
                .map(
                  (row) =>
                    50 +
                    (530 * (row[0]! - xmin)) / (xmax - xmin || 1) +
                    "," +
                    (280 -
                      (250 * (row[index + 1]! - ymin)) / (ymax - ymin || 1)),
                )
                .join(" ")}
              fill="none"
              stroke={colors[index]}
              strokeWidth="2"
            >
              <title>{column}</title>
            </polyline>
          ))}
          <text x="50" y="304">
            {xmin}
          </text>
          <text x="550" y="304">
            {xmax}
          </text>
          <text x="0" y="25">
            {ymax.toPrecision(3)}
          </text>
          <text x="0" y="280">
            {ymin.toPrecision(3)}
          </text>
        </svg>
        <div className="graphic-controls">
          {data.columns.slice(1).map((column, index) => (
            <span key={index} style={{ color: colors[index] }}>
              {column}
            </span>
          ))}
        </div>
      </div>
    );
  } catch (error) {
    return <GraphicParseFailure message={String(error)} onFailure={onFailure} />;
  }
}
function X3DPreview({
  source,
  resources,
  name, onFailure,
}: {
  onFailure: (reason: string) => void;
  source: string;
  resources: Record<string, Uint8Array>;
  name: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  useEffect(() => {
    setError("");
    setReady(false);
    const timer = setTimeout(() => {
      setError(
        zh ? "三维预览超过加载限额" : "3D preview exceeded its loading budget",
      );
      if (frame.current) frame.current.src = "about:blank";
    }, 10000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.kind === "graphic-ready") {
        frame.current?.contentWindow?.postMessage(
          { kind: "graphic-load", source, resources, name },
          "*",
        );
      } else if (event.data?.kind === "graphic-loaded") {
        clearTimeout(timer);
        setReady(true);
      } else if (event.data?.kind === "graphic-error") {
        clearTimeout(timer);
        onFailure(String(event.data.message).slice(0, 2048));
        if (frame.current) frame.current.src = "about:blank";
      }
    };
    window.addEventListener("message", receive);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [source, resources, name, zh, onFailure]);
  return (
    <div className="graphic-scene">
      <iframe
        key={name + source.length}
        ref={frame}
        sandbox="allow-scripts"
        src={new URL("graphic-preview.html", document.baseURI).href}
        title={zh ? "VRML / X3D 三维预览" : "VRML / X3D preview"}
        className="graphic-x3d"
      />
      <div className="graphic-controls">
        <span>
          {zh ? "拖动旋转 · 滚轮缩放" : "Drag to orbit · Scroll to zoom"}
        </span>
        <button
          className="btn small outline"
          disabled={!ready}
          onClick={() =>
            frame.current?.contentWindow?.postMessage(
              { kind: "graphic-fit" },
              "*",
            )
          }
        >
          {zh ? "适配视图" : "Fit view"}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
