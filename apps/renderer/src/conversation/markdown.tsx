import type { ReactNode } from "react";

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\s][^*]*?\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      nodes.push(<span key={`${keyPrefix}-t${index}`}>{text.slice(last, match.index)}</span>);
      index += 1;
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<span key={`${keyPrefix}-c${index}`} className="chip-code">{token.slice(1, -1)}</span>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-b${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={`${keyPrefix}-i${index}`}>{token.slice(1, -1)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = link?.[1] ?? "";
      const href = link?.[2]?.trim() ?? "";
      if (isSafeHref(href)) {
        nodes.push(
          <a key={`${keyPrefix}-a${index}`} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>,
        );
      } else {
        nodes.push(<span key={`${keyPrefix}-l${index}`}>{token}</span>);
      }
    }
    index += 1;
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(<span key={`${keyPrefix}-t${index}`}>{text.slice(last)}</span>);
  return nodes;
}

export function MarkdownInline({ text, k = "m" }: { text: string; k?: string }) {
  return <>{renderInline(text, k)}</>;
}

function listItem(line: string): { ordered: boolean; text: string } | undefined {
  const unordered = line.match(/^[ \t]*[-*+]\s+(.+)$/);
  if (unordered) return { ordered: false, text: unordered[1]! };
  const ordered = line.match(/^[ \t]*\d+[.)]\s+(.+)$/);
  if (ordered) return { ordered: true, text: ordered[1]! };
  return undefined;
}

function paragraphLines(lines: readonly string[], key: string): ReactNode {
  return (
    <p key={key}>
      {lines.map((line, index) => (
        <span key={`${key}-${index}`}>
          {index > 0 ? <br /> : null}
          {renderInline(line, `${key}-${index}`)}
        </span>
      ))}
    </p>
  );
}

export function MarkdownText({
  text,
  streaming,
  truncated,
  mark,
}: {
  text: string;
  streaming?: boolean;
  truncated?: boolean;
  mark?: ReactNode;
}) {
  const blocks: ReactNode[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  let index = 0;
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(paragraphLines(para, `p-${blocks.length}`));
    para = [];
  };
  const flushList = () => {
    if (!list || list.items.length === 0) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={`l-${blocks.length}`}>
        {list.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInline(item, `l-${blocks.length}-${itemIndex}`)}</li>
        ))}
      </Tag>,
    );
    list = undefined;
  };
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      flushPara();
      flushList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <div key={`c-${blocks.length}`} className="codeblock">
          {code.join("\n") || "\u00a0"}
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1]!.length, 3);
      const Tag = (`h${level}` as "h1" | "h2" | "h3");
      blocks.push(<Tag key={`h-${blocks.length}`}>{renderInline(heading[2]!, `h-${blocks.length}`)}</Tag>);
      index += 1;
      continue;
    }
    const item = listItem(line);
    if (item) {
      flushPara();
      if (!list || list.ordered !== item.ordered) {
        flushList();
        list = { ordered: item.ordered, items: [] };
      }
      list.items.push(item.text);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      index += 1;
      continue;
    }
    flushList();
    para.push(line);
    index += 1;
  }
  flushPara();
  flushList();
  return (
    <div className="ev-body">
      {blocks}
      {streaming ? <span className="stream-caret" aria-hidden="true" /> : null}
      {truncated === true ? mark : null}
    </div>
  );
}
