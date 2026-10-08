import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { mermaidBudget, MermaidQueue } from "./mermaidQueue";

let renderId = 0;
export const mermaidQueue = new MermaidQueue({
  hidden: () => typeof document !== "undefined" && document.hidden,
  render: async (code, config, active) => {
    const { default: mermaid } = await import("mermaid");
    if (!active() || !mermaidBudget(code).allowed) return undefined;
    mermaid.initialize(config);
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none";
    document.body.append(container);
    try { return (await mermaid.render(`omp-mermaid-${++renderId}`, code, container)).svg; }
    finally { container.remove(); }
  },
});
const resume = () => mermaidQueue.pump();
if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
const dispose = () => { document.removeEventListener("visibilitychange", resume); mermaidQueue.dispose(); };
if (typeof window !== "undefined") window.addEventListener("pagehide", dispose, { once: true });
import.meta.hot?.dispose(() => { window.removeEventListener("pagehide", dispose); dispose(); });

export function LazyMermaid({ code, onFailure }: { code: string; onFailure?: (message: string) => void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [result, setResult] = useState<{ code: string; svg: string | null }>();
  const budget = mermaidBudget(code);
  useEffect(() => {
    if (host.current === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), { rootMargin: "240px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !budget.allowed || result?.code === code) return;
    let alive = true;
    let cancel: (() => void) | undefined;
    const request = () => {
      if (cancel !== undefined) return;
      const response = mermaidQueue.request(code, { active: () => alive,
        result: (svg) => { if (alive) setResult({ code, svg }); } });
      if (response.status === "accepted") cancel = response.cancel;
    };
    const offSlot = mermaidQueue.onSlot(request);
    request();
    return () => { alive = false; cancel?.(); offSlot(); };
  }, [code, visible, budget.allowed, result?.code]);
  const svg = result?.code === code ? result.svg : undefined;
  useEffect(() => { if (svg === null || !budget.allowed) onFailure?.(budget.reason ?? (zh ? "图表无法渲染" : "Diagram could not be rendered")); }, [svg, budget.allowed, budget.reason, onFailure, zh]);
  if (svg) return <div ref={host} className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />;
  return <div ref={host} className="mermaid-box">
    <span className="mermaid-pending" role={svg === null || !budget.allowed ? "alert" : "status"}>{budget.reason ?? (svg === null ? (zh ? "图表无法渲染，已保留源码" : "Diagram could not be rendered; source retained") : (zh ? "图表等待渲染…" : "Waiting to render diagram…"))}</span>
    <pre className="codeblock md-code-pre"><code>{code}</code></pre>
  </div>;
}
