import { memo, useMemo, type CSSProperties, type ReactNode } from "react";

/**
 * 长流式文本的布局分块。
 *
 * 一张在跑的 bash 卡保留末尾 1500 行（`BASH_DISPLAY_MAX_ROWS`），而卡体 `max-height`
 * 只有 320px——此前每个流式帧都要为十几行可见内容排上千个行盒，这是流式单帧布局时间
 * 随输出长度放大的主要来源（streaming-perf-gate 的 long-history 场景实测约 4~5 倍）。
 *
 * 这里把文本按行切成块，每块声明 `content-visibility: auto`：视口外的块由浏览器用
 * `contain-intrinsic-height` 占位、跳过内容布局与绘制，卡跟底输出时每帧真正要排的只有
 * 尾部一两个块。回看深度不变（DOM 都在，滚动即可再布局），`contain-intrinsic-width:
 * auto` 让渲染过的块在跳过期间记住自己的实际宽度，横向滚动条的宽度不会随可见块漂移。
 *
 * 短文本（不超过一块）仍走原来的单文本节点路径，不给常见的小输出添一层 DOM。
 */
export const CHUNK_LINES = 64;

export type TextChunk = { readonly text: string; readonly lines: number };

/** 按换行切块；块内行数即占位高度的计算依据，空文本返回空数组。 */
export function chunkText(text: string, chunkLines = CHUNK_LINES): readonly TextChunk[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts.length <= chunkLines) return [{ text, lines: parts.length }];
  const chunks: TextChunk[] = [];
  for (let start = 0; start < parts.length; start += chunkLines) {
    const slice = parts.slice(start, start + chunkLines);
    chunks.push({ text: slice.join("\n"), lines: slice.length });
  }
  return chunks;
}

function chunkStyle(lines: number): CSSProperties {
  return { "--cv-lines": lines } as CSSProperties;
}

/**
 * 把一段 `white-space: pre` / `pre-wrap` 的长文本渲染成若干 cv 块。
 *
 * 按文本身份 memo：流式期间同一输出里只有尾块的文本在变，前面的块全部引用相等跳过，
 * 每帧的切块成本只落在最后一块上。
 */
export const ChunkedText = memo(function ChunkedText({ text }: { text: string }) {
  const chunks = useMemo(() => chunkText(text), [text]);
  if (chunks.length === 0) return null;
  if (chunks.length === 1) return <>{chunks[0]!.text}</>;
  return (
    <>
      {chunks.map((chunk, index) => (
        <div key={index} className="cv-chunk" style={chunkStyle(chunk.lines)}>{chunk.text}</div>
      ))}
    </>
  );
});

/**
 * 「每行一个元素」的长列表分块。
 *
 * `ChunkedText` 分的是单个文本节点，这里分的是行元素列表 —— 工具卡的
 * Read / Write / Edit / Grep / Glob / Lsp 全走后者，每行 3 个元素加一个文本节点。
 * 一次 Read 两万行的文件就在一张 220px 高的卡里挂出六万个元素，而虚拟列表只限制
 * 挂载**行数**（120），不限制单行内的节点数。分块之后视口外的块由浏览器用
 * `contain-intrinsic-height` 占位、跳过内容布局与绘制。
 *
 * `chunkClassName` 默认 `cv-chunk`；横向可滚的容器（`.tc-code` / `.tc-diff`，
 * 行本身是 `width: max-content; min-width: 100%`）要传 `cv-chunk-rows`，
 * 否则包一层普通块会把 `100%` 的参照系从滚动容器改成包裹层。
 *
 * 不加 `memo`：调用方的 `renderRow` 是内联闭包，每次渲染身份都变，memo 只会白比一次。
 * 这里的收益来自 `content-visibility` 而不是 React 层的跳过。
 */
export function ChunkedRows({
  count,
  renderRow,
  chunkLines = CHUNK_LINES,
  chunkClassName = "cv-chunk",
}: {
  count: number;
  renderRow: (index: number) => ReactNode;
  chunkLines?: number;
  chunkClassName?: string;
}) {
  const rows = (from: number, to: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (let index = from; index < to; index += 1) out.push(renderRow(index));
    return out;
  };
  if (count <= chunkLines) return <>{rows(0, count)}</>;
  const chunks: ReactNode[] = [];
  for (let start = 0; start < count; start += chunkLines) {
    const end = Math.min(count, start + chunkLines);
    chunks.push(
      <div key={start} className={chunkClassName} style={chunkStyle(end - start)}>{rows(start, end)}</div>,
    );
  }
  return <>{chunks}</>;
}

