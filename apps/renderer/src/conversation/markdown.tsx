import { isValidElement, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { withMagicKeywordChildren } from "./magicKeywordMarkdown";
import { IncrementalMarkdownBlocks } from "./incrementalMarkdown";

/** 插件表在模块级固定：每次渲染新建数组只会让 react-markdown 白跑一遍等价管道。 */
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [[rehypeHighlight, { detect: false, plainText: ["mermaid"] }]];

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

function reactNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => reactNodeText(child)).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return reactNodeText(props.children);
  }
  return "";
}

type Mermaid = typeof import("mermaid")["default"];

let mermaidModule: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= import("mermaid").then((mod) => mod.default);
  return mermaidModule;
}

function currentThemeIsDark(): boolean {
  return typeof document === "object" && document.documentElement.getAttribute("data-theme") === "dark";
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setSvg(undefined);
    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: currentThemeIsDark() ? "dark" : "default",
        });
        const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
        return mermaid.render(id, code);
      })
      .then((result) => {
        if (alive) setSvg(result.svg);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [code]);
  if (failed) {
    return (
      <div className="md-code">
        <div className="md-code-head">
          <span className="md-code-lang">mermaid</span>
          <span className="md-code-err">图渲染失败</span>
        </div>
        <pre className="codeblock md-code-pre">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className="mermaid-box" {...(svg === undefined ? {} : { dangerouslySetInnerHTML: { __html: svg } })}>
      {svg === undefined ? <span className="mermaid-pending">图表生成中…</span> : null}
    </div>
  );
}

function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="md-code-copy"
      onClick={() => {
        const clipboard = typeof navigator === "object" ? navigator.clipboard : undefined;
        if (!clipboard) return;
        clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

type PreChildProps = { className?: unknown; children?: ReactNode };

function firstElementChild(children: ReactNode): PreChildProps | undefined {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (isValidElement(child)) return child.props as PreChildProps;
  }
  return undefined;
}

function createComponents(streaming: boolean, magicKeywords: boolean): Components {
  const prose = (children: ReactNode): ReactNode =>
    magicKeywords ? withMagicKeywordChildren(children) : children;

  return {
    p({ children }) {
      return <p>{prose(children)}</p>;
    },
    li({ children }) {
      return <li>{prose(children)}</li>;
    },
    h1({ children }) {
      return <h1>{prose(children)}</h1>;
    },
    h2({ children }) {
      return <h2>{prose(children)}</h2>;
    },
    h3({ children }) {
      return <h3>{prose(children)}</h3>;
    },
    h4({ children }) {
      return <h4>{prose(children)}</h4>;
    },
    h5({ children }) {
      return <h5>{prose(children)}</h5>;
    },
    h6({ children }) {
      return <h6>{prose(children)}</h6>;
    },
    blockquote({ children }) {
      return <blockquote>{prose(children)}</blockquote>;
    },
    td({ children }) {
      return <td>{prose(children)}</td>;
    },
    th({ children }) {
      return <th>{prose(children)}</th>;
    },
    strong({ children }) {
      return <strong>{prose(children)}</strong>;
    },
    em({ children }) {
      return <em>{prose(children)}</em>;
    },
    del({ children }) {
      return <del>{prose(children)}</del>;
    },
    a({ href, children }) {
      const url = typeof href === "string" ? href.trim() : "";
      if (!isSafeHref(url)) return <span>{prose(children)}</span>;
      return (
        <a href={url} target="_blank" rel="noreferrer noopener">
          {prose(children)}
        </a>
      );
    },
    img({ src, alt }) {
      const url = typeof src === "string" ? src.trim() : "";
      if (!/^https?:\/\//i.test(url)) return null;
      return <img src={url} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
    },
    table({ children }) {
      return (
        <div className="md-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
    code({ className, children }) {
      const cls = typeof className === "string" ? className : "";
      if (cls.length > 0) return <code className={cls}>{children}</code>;
      return <code className="chip-code">{children}</code>;
    },
    pre({ children }) {
      const child = firstElementChild(children);
      const cls = typeof child?.className === "string" ? child.className : "";
      const lang = /language-([\w+#.-]+)/.exec(cls)?.[1] ?? "";
      const text = reactNodeText(child?.children).replace(/\n$/, "");
      if (lang === "mermaid") {
        if (streaming) {
          return (
            <div className="md-code">
              <div className="md-code-head">
                <span className="md-code-lang">mermaid</span>
                <span className="md-code-hint">流式输出中</span>
              </div>
              <pre className="codeblock md-code-pre">
                <code>{text}</code>
              </pre>
            </div>
          );
        }
        return <MermaidBlock code={text} />;
      }
      return (
        <div className="md-code">
          <div className="md-code-head">
            <span className="md-code-lang">{lang || "text"}</span>
            <CodeCopyButton text={text} />
          </div>
          <pre className="codeblock md-code-pre">{children}</pre>
        </div>
      );
    },
  };
}

export function MarkdownInline({ text }: { text: string; k?: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      components={{
        p: ({ children }) => <>{children}</>,
        a({ href, children }) {
          const url = typeof href === "string" ? href.trim() : "";
          if (!isSafeHref(url)) return <span>{children}</span>;
          return (
            <a href={url} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
        img({ src, alt }) {
          const url = typeof src === "string" ? src.trim() : "";
          if (!/^https?:\/\//i.test(url)) return null;
          return <img src={url} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

type CachedBlock = { readonly source: string; readonly node: ReactNode };

type StreamingState = {
  readonly blocks: IncrementalMarkdownBlocks;
  readonly cache: Map<number, CachedBlock>;
  readonly components: Components;
};

/**
 * 流式正文：已冻结的顶层块只解析、只高亮一次，元素随后被缓存（React 见到同一个元素
 * 对象直接 bailout），每个 chunk 只重新解析尾部那点源码。
 *
 * react-markdown 的根是 Fragment，不额外套元素；mdast-util-to-hast 又只在顶层块
 * *之间* 插一个 `\n` 文本节点，所以这里按同样规则在块之间补上分隔符，逐块渲染的
 * DOM 与整篇一次性渲染逐字节一致，`.ev-body p:first-child` 这类选择器不受影响。
 */
function StreamingMarkdownBody({ text, components }: { text: string; components: Components }) {
  const stateRef = useRef<StreamingState | undefined>(undefined);
  let state = stateRef.current;
  if (state === undefined || state.components !== components) {
    state = { blocks: new IncrementalMarkdownBlocks(), cache: new Map(), components };
    stateRef.current = state;
  }
  const { frozen, tail, crossBlockReference } = state.blocks.update(text);
  if (crossBlockReference) {
    // 脚注与链接引用要跨块对齐，逐块渲染会把它们拆散：这一条回复整篇渲染。
    state.cache.clear();
    return (
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    );
  }
  const parts: ReactNode[] = [];
  for (const block of frozen) {
    const cached = state.cache.get(block.key);
    if (cached !== undefined && cached.source === block.source) {
      parts.push(cached.node);
      continue;
    }
    const node = (
      <ReactMarkdown
        key={block.key}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {block.source}
      </ReactMarkdown>
    );
    state.cache.set(block.key, { source: block.source, node });
    parts.push(node);
  }
  // 只有空白的尾部渲染不出任何节点，也就不该占一个分隔符。
  if (tail.trim().length > 0) {
    parts.push(
      <ReactMarkdown
        key="tail"
        remarkPlugins={REMARK_PLUGINS}
        components={components}
      >
        {tail}
      </ReactMarkdown>,
    );
  }
  const nodes: ReactNode[] = [];
  for (const part of parts) {
    if (nodes.length > 0) nodes.push("\n");
    nodes.push(part);
  }
  return <>{nodes}</>;
}

export const MarkdownText = memo(function MarkdownText({
  text,
  streaming,
  truncated,
  mark,
  magicKeywords,
}: {
  text: string;
  streaming?: boolean;
  truncated?: boolean;
  mark?: ReactNode;
  /** Paint OMP magic keywords (static gradient) in prose text nodes. */
  magicKeywords?: boolean;
}) {
  const components = useMemo(
    () => createComponents(streaming === true, magicKeywords === true),
    [streaming, magicKeywords],
  );
  return (
    <div className="ev-body">
      {streaming === true ? (
        <StreamingMarkdownBody text={text} components={components} />
      ) : (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
          {text}
        </ReactMarkdown>
      )}
      {truncated === true ? mark : null}
    </div>
  );
});
