import { SpillLink, isSpillUri, linkSpillText } from "./SpillLink";
import { FileLink, LocalFileImage } from "../files/fileLinks";
import { parseFileReference } from "../files/fileTypes";
import { NumericMarkdownTable } from "./NumericMarkdownTable";
import { SvgFigureImage } from "../graphics/SvgFigureImage";
import { GraphicPreview } from "../graphics/GraphicPreview";
import { graphicFormat } from "../graphics/graphic-types";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { commandLanguages } from "../highlight/commandLanguages";
import remarkGfm from "remark-gfm";
import { scanStreamingMarkdown, type StreamingCodeFence, type StreamingMarkdownScan } from "./markdownBlocks";
import { withMagicKeywordChildren } from "./magicKeywordMarkdown";
import { LazyMermaid } from "./LazyMermaid";
import { performanceOptions } from "../performanceOptions";
import { HighlightedCode } from "../highlight/HighlightedCode";
import { ExtensionAwareLink } from "./ExtensionLinks";
import { CommandBlock, commandShell } from "./CommandBlock";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { withMarkdownSource } from "./markdownSource";

const REMARK: Options["remarkPlugins"] = [remarkGfm];
const HIGHLIGHT: Options["rehypePlugins"] = [[rehypeHighlight, { detect: false, plainText: ["mermaid"], languages: commandLanguages, aliases: { powershell: ["pwsh", "ps1"] } }]];
const MAX_HIGHLIGHT_CHARS = 96 * 1024;

export function isSafeMarkdownUrl(value: string, image = false): boolean {
  const url = value.trim();
  if (image) return /^https?:\/\//i.test(url) || parseFileReference(url, true) !== null;
  if (parseFileReference(url, true)) return true;
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
function LegacyMermaid({ code }: { code: string }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
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
  return <div ref={host} className="mermaid-box" {...(svg ? { dangerouslySetInnerHTML: { __html: svg } } : {})}>{svg === null ? <span className="mermaid-pending">{zh ? "图表等待渲染…" : "Diagram pending…"}</span> : svg === "" ? <pre className="codeblock md-code-pre"><code>{code}</code></pre> : null}</div>;
}

function CodeFrame({ language, text, children, streaming }: { language: string; text: string; children: ReactNode; streaming: boolean }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  if (commandShell(language)) return <CommandBlock language={language} text={text} streaming={streaming}>{children}</CommandBlock>;
  return <div className="md-code">
    <div className="md-code-head">
      <span className="md-code-lang">{language || "text"}</span>
      {streaming ? <span className="md-code-hint">{zh ? "流式输出中" : "Streaming"}</span> : <button type="button" className="md-code-copy" aria-label={copied ? (zh ? "已复制" : "Copied") : (zh ? "复制代码" : "Copy code")} data-tip={copied ? (zh ? "已复制" : "Copied") : (zh ? "复制代码" : "Copy code")} onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}><Icon name={copied ? "check" : "copy"} /></button>}
    </div>
    <pre className="codeblock md-code-pre">{children}</pre>
  </div>;
}

const componentCache = new Map<string, Components>();
function componentsFor(streaming: boolean, magic: boolean, highlightEligible = false, staticPreview = false): Components {
  const key = `${streaming}:${magic}:${highlightEligible}:${staticPreview}`;
  const cached = componentCache.get(key);
  if (cached !== undefined) return cached;
  const prose = (children: ReactNode) => magic ? withMagicKeywordChildren(children) : children;
  const paragraphText = (children: ReactNode) => prose(staticPreview ? children : linkSpillText(children));
  const components: Components = {
    p: ({ children, node: _node, ...props }) => <p {...props}>{paragraphText(children)}</p>,
    li: ({ children, node: _node, ...props }) => <li {...props}>{paragraphText(children)}</li>,
    a: ({ href, children }) => {
      if (staticPreview) return <span className="md-static-link">{prose(children)}</span>;
      const url = typeof href === "string" ? href.trim() : "";
      if (isSpillUri(url)) return <SpillLink uri={url}>{children}</SpillLink>;
      return parseFileReference(url, true) ? <FileLink href={url}>{prose(children)}</FileLink> : <ExtensionAwareLink href={url} safe={isSafeMarkdownUrl(url)}>{prose(children)}</ExtensionAwareLink>;
    },
    img: ({ src, alt }) => {
      if (staticPreview) return alt ? <span className="md-static-image">{alt}</span> : null;
      const url = typeof src === "string" ? src.trim() : "";
      if (parseFileReference(url, true)) return <LocalFileImage src={url} alt={alt ?? ""} />;
      return isSafeMarkdownUrl(url, true) ? <img src={url} alt={alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null;
    },
    table: ({ children,node }) => staticPreview
      ? <div className="md-table-wrap"><table>{children}</table></div>
      : <NumericMarkdownTable node={node} streaming={streaming}>{children}</NumericMarkdownTable>,
    input: props => {
      if (!staticPreview) return <input {...props} />;
      return props.type === "checkbox"
        ? <span className="md-task-marker" aria-hidden="true">{props.checked ? "✓" : ""}</span>
        : null;
    },
    code: ({ className, children }) => {
      if (className) return <code className={className}>{children}</code>;
      if (staticPreview) return <code className="chip-code">{children}</code>;
      const text = nodeText(children);
      if (isSpillUri(text)) return <code className="chip-code"><SpillLink uri={text}>{children}</SpillLink></code>;
      return <code className="chip-code">{parseFileReference(text) ? <FileLink href={text} inline>{children}</FileLink> : children}</code>;
    },
    pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children;
      const props = child && typeof child === "object" && "props" in child ? (child as { props: { className?: string; children?: ReactNode } }).props : {};
      const language = /language-([\w+#.-]+)/.exec(props.className ?? "")?.[1] ?? "";
      const text = nodeText(props.children).replace(/\n$/, "");
      if (staticPreview) return <pre className="codeblock md-code-pre">{children}</pre>;
      if (language !== "mermaid" && graphicFormat("graphic."+language) && (!streaming || language === "svg")) return <GraphicPreview name={"graphic."+language} text={text}/>;
      if (language === "mermaid" && !streaming) return performanceOptions.boundedMermaid ? <LazyMermaid code={text} /> : <LegacyMermaid key={text} code={text} />;
      if (performanceOptions.highlightWorker && highlightEligible && language && language !== "mermaid") {
        return <CodeFrame language={language} text={text} streaming={streaming}>
          <HighlightedCode language={language} code={nodeText(props.children)} />
        </CodeFrame>;
      }
      return <CodeFrame language={language} text={text} streaming={streaming}>{children}</CodeFrame>;
    },
  };
  componentCache.set(key, components);
  return components;
}

const MarkdownBlock = memo(function MarkdownBlock({ text, streaming, magic, staticPreview, sourceOffset }: { text: string; streaming: boolean; magic: boolean; staticPreview: boolean; sourceOffset?: number | undefined }) {
  const highlightEligible = !streaming && text.length <= MAX_HIGHLIGHT_CHARS;
  const plugins = highlightEligible && !performanceOptions.highlightWorker ? HIGHLIGHT : undefined;
  const components = useMemo(() => {
    const base = componentsFor(streaming, magic, highlightEligible, staticPreview);
    return sourceOffset === undefined ? base : withMarkdownSource(base, sourceOffset);
  }, [streaming, magic, highlightEligible, staticPreview, sourceOffset]);
  return <ReactMarkdown urlTransform={(url, key) => key === "href" || parseFileReference(url, true) ? url : defaultUrlTransform(url)} remarkPlugins={REMARK} rehypePlugins={plugins} components={components}>{text}</ReactMarkdown>;
});

const NO_CLOSED_BLOCKS: readonly string[] = [];
const MarkdownBlockList = memo(function MarkdownBlockList({ blocks, magic, staticPreview, scope }: {
  blocks: readonly string[];
  magic: boolean;
  staticPreview: boolean;
  scope: "frozen" | "pending";
}) {
  return <>{blocks.map((block, index) => (
    <MarkdownBlock key={`${scope}:${index}:${block.length}`} text={block} streaming={false} magic={magic} staticPreview={staticPreview} />
  ))}</>;
});

type MarkdownRenderParts = {
  readonly frozen: readonly string[];
  readonly pending: readonly string[];
  readonly tail: string;
  readonly openFence?: StreamingCodeFence;
};

export const MarkdownText = memo(function MarkdownText({ text, streaming = false, truncated = false, mark, magicKeywords = false, sourceOffset, staticPreview = false }: {
  text: string; streaming?: boolean; truncated?: boolean; mark?: ReactNode; magicKeywords?: boolean; sourceOffset?: number | undefined; staticPreview?: boolean;
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
      <MarkdownBlockList blocks={parts.frozen} magic={magicKeywords} staticPreview={staticPreview} scope="frozen" />
      <MarkdownBlockList blocks={parts.pending} magic={magicKeywords} staticPreview={staticPreview} scope="pending" />
      {parts.tail.length > 0 ? <MarkdownBlock text={parts.tail} streaming={streaming} magic={magicKeywords} staticPreview={staticPreview} sourceOffset={sourceOffset} /> : null}
      {parts.openFence?.language.toLowerCase() === "svg" ? <SvgFigureImage source={parts.openFence.code} alt="SVG" streaming/> : parts.openFence !== undefined ? (
        <CodeFrame language={parts.openFence.language} text={parts.openFence.code} streaming>
          <code className={parts.openFence.language ? `language-${parts.openFence.language}` : undefined}>{parts.openFence.code}</code>
        </CodeFrame>
      ) : null}
    </div>
    {truncated ? mark : null}
  </div>;
});

export const MarkdownInline = memo(function MarkdownInline({ text, magicKeywords = false }: { text: string; magicKeywords?: boolean; k?: string }) {
  return <span className="md-inline"><ReactMarkdown urlTransform={(url, key) => key === "href" || parseFileReference(url, true) ? url : defaultUrlTransform(url)} remarkPlugins={REMARK} components={componentsFor(false, magicKeywords)} unwrapDisallowed>{text}</ReactMarkdown></span>;
});
