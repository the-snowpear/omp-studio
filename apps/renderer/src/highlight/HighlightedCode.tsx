import { memo, useEffect, useRef, useState } from "react";
import type { HighlightResult } from "./pool";
import { renderHighlightTokens } from "./renderTokens";
import { highlightPool } from "./service";
import { useHighlightVisibility } from "./visibility";

/** Only this code element changes when colors arrive; CodeFrame stays mounted. */
export const HighlightedCode = memo(function HighlightedCode({ language, code }: { language: string; code: string }) {
  const element = useRef<HTMLElement>(null);
  const [result, setResult] = useState<{ code: string; language: string; value: HighlightResult }>();
  const current = result?.code === code && result.language === language ? result.value : undefined;
  const { active, visibleRef } = useHighlightVisibility(element, current === undefined);

  useEffect(() => {
    if (!active || current !== undefined) return;
    let alive = true;
    let cancel: (() => void) | undefined;
    const request = () => {
      if (cancel !== undefined || !alive) return;
      const response = highlightPool.request(language, code, {
        priority: () => (!alive ? "none" : visibleRef.current ? "visible" : "overscan"),
        result: (value) => { if (alive) setResult({ code, language, value }); },
      });
      if (response.status === "accepted") cancel = response.cancel;
      if (response.status === "rejected") setResult({ code, language, value: { ok: false, reason: "unavailable" } });
    };
    const unsubscribe = highlightPool.onSlot(request);
    request();
    return () => { alive = false; cancel?.(); unsubscribe(); };
  }, [code, language, active, current, visibleRef]);

  return <code ref={element} className={`hljs language-${language}`} data-highlight-state={current?.ok ? "ready" : current === undefined ? "pending" : "plain"}>
    {current?.ok ? renderHighlightTokens(current.tokens) : code}
  </code>;
});
