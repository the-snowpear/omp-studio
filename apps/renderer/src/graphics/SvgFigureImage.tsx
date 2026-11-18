import { useEffect, useRef, useState } from "react";
import {
  prepareSvg,
  closePartialSvg,
} from "../../../../omp-patch/vendor/oh-my-pi/packages/tui/src/chat/svg-source";
import { useI18n } from "../i18n";
const TOKENS: Record<string, string> = {
  fg: "text",
  muted: "text-3",
  border: "border-strong",
  accent: "accent",
  surface: "surface-2",
  success: "green",
  warning: "amber",
  error: "red",
  c1: "purple",
  c2: "green",
  c3: "blue",
  c4: "amber",
  c5: "red",
  c6: "text-2",
};
function externalCssUrl(value: string): boolean {
  return [...value.matchAll(/url\(\s*([\x27\x22]?)(.*?)\1\s*\)/gi)].some(
    (match) => !match[2]?.trim().startsWith("#"),
  );
}
export function validateSvgFigure(source: string): void {
  if (source.length > 800000)
    throw new Error("SVG exceeds the 800 kB display limit");
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("SVG document types and entities are disabled");
  const document = new DOMParser().parseFromString(source, "image/svg+xml"),
    root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror"))
    throw new Error("SVG is incomplete or invalid");
  const nodes = [root, ...Array.from(root.querySelectorAll("*"))];
  if (nodes.length > 16000) throw new Error("SVG exceeds 16,000 elements");
  for (const node of nodes) {
    if (
      [
        "script",
        "foreignobject",
        "iframe",
        "object",
        "embed",
        "audio",
        "video",
      ].includes(node.localName.toLowerCase())
    )
      throw new Error("Executable SVG elements are disabled");
    for (const attribute of Array.from(node.attributes)) {
      const key = attribute.localName.toLowerCase(),
        value = attribute.value.trim();
      if (key.startsWith("on"))
        throw new Error("SVG event handlers are disabled");
      if ((key === "href" || key === "src") && value && !value.startsWith("#"))
        throw new Error("SVG external resources are not loaded");
      if (externalCssUrl(value))
        throw new Error("SVG external resources are not loaded");
    }
    if (
      node.localName === "style" &&
      (/@import/i.test(node.textContent ?? "") ||
        externalCssUrl(node.textContent ?? ""))
    )
      throw new Error("SVG external resources are not loaded");
  }
  for (const name of ["width", "height"]) {
    const value = root.getAttribute(name);
    if (
      value &&
      /^\d+(?:\.\d+)?(?:px)?$/.test(value) &&
      Number.parseFloat(value) > 4096
    )
      throw new Error("SVG exceeds the 4,096 px image limit");
  }
}
const themeWatchers = new WeakMap<Document, { observer: MutationObserver; listeners: Set<() => void> }>();

function subscribeSvgTheme(doc: Document, listener: () => void): () => void {
  const ObserverCtor = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (typeof ObserverCtor === "undefined" || !doc.documentElement) return () => {};
  let entry = themeWatchers.get(doc);
  if (!entry) {
    const listeners = new Set<() => void>();
    const observer = new ObserverCtor(() => {
      for (const fn of [...listeners]) fn();
    });
    observer.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    entry = { observer, listeners };
    themeWatchers.set(doc, entry);
  }
  entry.listeners.add(listener);
  const current = entry;
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.observer.disconnect();
      themeWatchers.delete(doc);
    }
  };
}

export function SvgFigureImage({
  source,
  alt,
  streaming = false,
  onFailure,
}: {
  source: string;
  alt: string;
  streaming?: boolean;
  onFailure?: ((reason: string) => void) | undefined;
}) {
  const { resolvedLanguage } = useI18n(),
    zh = resolvedLanguage === "zh";
  const [url, setUrl] = useState<string>(),
    [error, setError] = useState(""),
    [theme, setTheme] = useState(0);
  const hostRef = useRef<HTMLImageElement>(null),
    last = useRef<string | undefined>(undefined),
    lastRender = useRef(0),
    failure = useRef(onFailure);
  failure.current = onFailure;
  useEffect(() => {
    const doc = hostRef.current?.ownerDocument ?? document;
    return subscribeSvgTheme(doc, () => setTheme((value) => value + 1));
  }, []);
  useEffect(() => {
    const render = () => {
      lastRender.current = Date.now();
      try {
        const complete = streaming ? closePartialSvg(source) : source;
        if (!complete) return;
        validateSvgFigure(complete);
        const doc = hostRef.current?.ownerDocument ?? document;
        const win = doc.defaultView ?? window;
        const style = win.getComputedStyle(doc.documentElement),
          palette = Object.fromEntries(
            Object.entries(TOKENS).map(([key, value]) => [
              key,
              style.getPropertyValue("--" + value).trim(),
            ]),
          );
        const prepared = prepareSvg(complete, palette),
          next = URL.createObjectURL(
            new Blob([prepared], { type: "image/svg+xml" }),
          );
        if (last.current) URL.revokeObjectURL(last.current);
        last.current = next;
        setUrl(next);
        setError("");
      } catch (cause) {
        if (!streaming || source.length > 800000) {
          if (last.current) {
            URL.revokeObjectURL(last.current);
            last.current = undefined;
            setUrl(undefined);
          }
          const message =
            cause instanceof Error ? cause.message : String(cause);
          setError(message);
          failure.current?.(message);
        }
      }
    };
    if (streaming) {
      const timer = window.setTimeout(
        render,
        Math.max(0, 200 - (Date.now() - lastRender.current)),
      );
      return () => clearTimeout(timer);
    }
    render();
  }, [source, streaming, theme]);
  useEffect(
    () => () => {
      if (last.current) URL.revokeObjectURL(last.current);
    },
    [],
  );
  return error ? (
    <p role="alert" className="graphic-failure">
      {error}
    </p>
  ) : url ? (
    <img
      ref={hostRef}
      className="graphic-svg"
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (!streaming) {
          if (last.current) {
            URL.revokeObjectURL(last.current);
            last.current = undefined;
            setUrl(undefined);
          }
          const message = zh ? "SVG 无法显示" : "SVG could not be displayed";
          setError(message);
          failure.current?.(message);
        }
      }}
    />
  ) : streaming ? (
    <p className="small muted" role="status">
      {zh ? "SVG 正在生成…" : "SVG is streaming…"}
    </p>
  ) : null;
}
