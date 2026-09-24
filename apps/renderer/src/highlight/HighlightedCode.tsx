import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { highlightPool } from "./service";
import type { HighlightResult } from "./pool";
import type { HighlightToken } from "./protocol";

const renderTokens = (tokens: readonly HighlightToken[]): ReactNode => tokens.map((token, index) => token.type === "text"
  ? token.value : <span key={index} className={token.classes.join(" ")}>{renderTokens(token.children)}</span>);

/** Only this code element changes when colors arrive; CodeFrame stays mounted. */
export const HighlightedCode = memo(function HighlightedCode({ language, code }: { language: string; code: string }) {
  const element = useRef<HTMLElement>(null);
  const fallback = typeof IntersectionObserver === "undefined";
  const [visible, setVisible] = useState(fallback);
  const [near, setNear] = useState(fallback);
  const [result, setResult] = useState<{ code: string; language: string; value: HighlightResult }>();
  const current = result?.code === code && result.language === language ? result.value : undefined;
  useEffect(() => {
    if (element.current === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)));
    const overscan = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { rootMargin: "240px" });
    observer.observe(element.current); overscan.observe(element.current);
    return () => { observer.disconnect(); overscan.disconnect(); };
  }, []);
  useEffect(() => {
    if ((!near && !visible) || current !== undefined) return;
    let alive = true;
    let cancel: (() => void) | undefined;
    const request = () => {
      if (cancel !== undefined || !alive) return;
      const response = highlightPool.request(language, code, {
        priority: () => !alive ? "none" : visible ? "visible" : "overscan",
        result: (value) => { if (alive) setResult({ code, language, value }); },
      });
      if (response.status === "accepted") cancel = response.cancel;
      if (response.status === "rejected") setResult({ code, language, value: { ok: false, reason: "unavailable" } });
    };
    const unsubscribe = highlightPool.onSlot(request);
    request();
    return () => { alive = false; cancel?.(); unsubscribe(); };
  }, [code, language, visible, near, current]);
  return <code ref={element} className={`hljs language-${language}`} data-highlight-state={current?.ok ? "ready" : current === undefined ? "pending" : "plain"}>
    {current?.ok ? renderTokens(current.tokens) : code}
  </code>;
});
