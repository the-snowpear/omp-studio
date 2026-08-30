import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { scanStreamingMarkdown, type StreamingCodeFence, type StreamingMarkdownScan } from "./markdownBlocks";
import { withMagicKeywordChildren } from "./magicKeywordMarkdown";

const REMARK: Options["remarkPlugins"] = [remarkGfm];
const HIGHLIGHT: Options["rehypePlugins"] = [[rehypeHighlight, { detect: false, plainText: ["mermaid"] }]];
const MAX_HIGHLIGHT_CHARS = 96 * 1024;

export function isSafeMarkdownUrl(value: string, image = false): boolean {
  const url = value.trim();
  if (image) return /^https?:\/\//i.test(url);
  return /^(?:https?:|mailto:)/i.test(url) || /^(?:[/.#?]|[^:\s]+$)/.test(url);
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in node) return nodeText((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

const mermaidCache = new Map<string, string>();
function cacheMermaid(key: string, svg: string): void {
  if (mermaidCache.size >= 32) mermaidCache.delete(mermaidCache.keys().next().value as string);
  mermaidCache.set(key, svg);
}
function LazyMermaid({ code }: { code: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(() => mermaidCache.get(code) ?? null);
  useEffect(() => {
    if (svg !== null || host.current === null) return;
    let active = true;
    const render = () => { void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      const result = await mermaid.render(`omp-mermaid-${Math.random().toString(36).slice(2)}`, code);
      if (active) { cacheMermaid(code, result.svg); setSvg(result.svg); }
    }).catch(() => { if (active) setSvg(""); }); };
    if (typeof IntersectionObserver === "undefined") render();
    else {
      const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); render(); } }, { rootMargin: "240px" });
      observer.observe(host.current);
      return () => { active = false; observer.disconnect(); };
    }
    return () => { active = false; };
  }, [code, svg]);
  return <div ref={host} className="mermaid-box" {...(svg ? { dangerouslySetInnerHTML: { __html: svg } } : {})}>{svg === null ? <span className="mermaid-pending">图表等待渲染…</span> : svg === "" ? <pre className="codeblock md-code-pre"><code>{code}</code></pre> : null}</div>;
}

function CodeFrame({ language, text, children, streaming }: { language: string; text: string; children: ReactNode; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return <div className="md-code">
    <div className="md-code-head">
      <span className="md-code-lang">{language || "text"}</span>
      {streaming ? <span className="md-code-hint">流式输出中</span> : <button type="button" className="md-code-copy" onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}>{copied ? "已复制" : "复制"}</button>}
    </div>
    <pre className="codeblock md-code-pre">{children}</pre>
  </div>;
}

const componentCache = new Map<string, Components>();
function componentsFor(streaming: boolean, magic: boolean): Components {
  const key = `${streaming}:${magic}`;
  const cached = componentCache.get(key);
  if (cached !== undefined) return cached;
  const prose = (children: ReactNode) => magic ? withMagicKeywordChildren(children) : children;
  const components: Components = {
    p: ({ children }) => <p>{prose(children)}</p>,
    li: ({ children }) => <li>{prose(children)}</li>,
    a: ({ href, children }) => {
      const url = typeof href === "string" ? href.trim() : "";
      return isSafeMarkdownUrl(url) ? <a href={url} target="_blank" rel="noreferrer noopener">{prose(children)}</a> : <span>{prose(children)}</span>;
    },
    img: ({ src, alt }) => {
      const url = typeof src === "string" ? src.trim() : "";
      return isSafeMarkdownUrl(url, true) ? <img src={url} alt={alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null;
    },
    table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
    code: ({ className, children }) => className ? <code className={className}>{children}</code> : <code className="chip-code">{children}</code>,
    pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children;
      const props = child && typeof child === "object" && "props" in child ? (child as { props: { className?: string; children?: ReactNode } }).props : {};
      const language = /language-([\w+#.-]+)/.exec(props.className ?? "")?.[1] ?? "";
      const text = nodeText(props.children).replace(/\n$/, "");
      if (language === "mermaid" && !streaming) return <LazyMermaid code={text} />;
      return <CodeFrame language={language} text={text} streaming={streaming}>{children}</CodeFrame>;
    },
  };
  componentCache.set(key, components);
  return components;
}

const MarkdownBlock = memo(function MarkdownBlock({ text, streaming, magic }: { text: string; streaming: boolean; magic: boolean }) {
  const plugins = !streaming && text.length <= MAX_HIGHLIGHT_CHARS ? HIGHLIGHT : undefined;
  return <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={plugins} components={componentsFor(streaming, magic)}>{text}</ReactMarkdown>;
});

const NO_CLOSED_BLOCKS: readonly string[] = [];
const MarkdownBlockList = memo(function MarkdownBlockList({ blocks, magic, scope }: {
  blocks: readonly string[];
  magic: boolean;
  scope: "frozen" | "pending";
}) {
  return <>{blocks.map((block, index) => (
    <MarkdownBlock key={`${scope}:${index}:${block.length}`} text={block} streaming={false} magic={magic} />
  ))}</>;
});

type MarkdownRenderParts = {
  readonly frozen: readonly string[];
  readonly pending: readonly string[];
  readonly tail: string;
  readonly openFence?: StreamingCodeFence;
};

export const MarkdownText = memo(function MarkdownText({ text, streaming = false, truncated = false, mark, magicKeywords = false }: {
  text: string; streaming?: boolean; truncated?: boolean; mark?: ReactNode; magicKeywords?: boolean;
}) {
  /* 续扫状态。流式期间正文只在尾部追加，把上一帧的扫描结果传回去，分块代价就只跟
     「这一帧新增的字符」有关，而不是跟已经产出的全文有关。 */
  const scan = useRef<StreamingMarkdownScan | null>(null);
  const parts = useMemo<MarkdownRenderParts>(() => {
    if (!streaming) {
      scan.current = null;
      return { frozen: NO_CLOSED_BLOCKS, pending: NO_CLOSED_BLOCKS, tail: text };
    }
    const next = scanStreamingMarkdown(text, scan.current ?? undefined);
    scan.current = next;
    return next;
  }, [streaming, text]);
  return <div className="ev-body">
    <div className={`convo-md${streaming ? " is-streaming" : ""}`}>
      <MarkdownBlockList blocks={parts.frozen} magic={magicKeywords} scope="frozen" />
      <MarkdownBlockList blocks={parts.pending} magic={magicKeywords} scope="pending" />
      {parts.tail.length > 0 ? <MarkdownBlock text={parts.tail} streaming={streaming} magic={magicKeywords} /> : null}
      {parts.openFence !== undefined ? (
        <CodeFrame language={parts.openFence.language} text={parts.openFence.code} streaming>
          <code className={parts.openFence.language ? `language-${parts.openFence.language}` : undefined}>{parts.openFence.code}</code>
        </CodeFrame>
      ) : null}
    </div>
    {truncated ? mark : null}
  </div>;
});

export const MarkdownInline = memo(function MarkdownInline({ text, magicKeywords = false }: { text: string; magicKeywords?: boolean; k?: string }) {
  return <span className="md-inline"><ReactMarkdown remarkPlugins={REMARK} components={componentsFor(false, magicKeywords)} unwrapDisallowed>{text}</ReactMarkdown></span>;
});
