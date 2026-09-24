import { useEffect, useRef, useState } from "react";
import { mermaidBudget, MermaidQueue } from "./mermaidQueue";

let renderId = 0;
export const mermaidQueue = new MermaidQueue({
  hidden: () => typeof document !== "undefined" && document.hidden,
  render: async (code, config, active) => {
    const { default: mermaid } = await import("mermaid");
    if (!active() || !mermaidBudget(code).allowed) return undefined;
    mermaid.initialize(config);
    return (await mermaid.render(`omp-mermaid-${++renderId}`, code)).svg;
  },
});
const resume = () => mermaidQueue.pump();
if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
const dispose = () => { document.removeEventListener("visibilitychange", resume); mermaidQueue.dispose(); };
if (typeof window !== "undefined") window.addEventListener("pagehide", dispose, { once: true });
import.meta.hot?.dispose(() => { window.removeEventListener("pagehide", dispose); dispose(); });

export function LazyMermaid({ code }: { code: string }) {
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
  if (svg) return <div ref={host} className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />;
  return <div ref={host} className="mermaid-box">
    <span className="mermaid-pending">{budget.reason ?? (svg === null ? "图表无法渲染，已保留源码" : "图表等待渲染…")}</span>
    <pre className="codeblock md-code-pre"><code>{code}</code></pre>
  </div>;
}
