/**
 * 流式正文的增量分块。
 *
 * 每来一个 chunk 就把整篇累积文本重新解析一遍是二次方的：一条 8KB 的回复在
 * 500 个 tick 里会被解析 500 次、共约 4MB 源码，语法高亮同理。这里改成只解析
 * 尾部：除末尾 {@link UNSTABLE_TAIL_BLOCKS} 个顶层块以外的块一旦确定就冻结，
 * 之后只对冻结点之后的源码增量解析，于是每段源码在整条流里只被解析 O(1) 次。
 *
 * 冻结块的 key 是它在整篇源码里的起始偏移，跨 tick 稳定，React 因此可以按 key
 * 复用已渲染的块（配合调用方缓存的元素，直接命中 bailout 而不重渲染）。
 *
 * 分块只用 CommonMark 语法求顶层块边界，不挂 GFM 扩展：表格、脚注定义这类
 * GFM 结构在 CommonMark 下会退化成同样以空行分隔的段落，块边界一致，而渲染仍由
 * 调用方带 remark-gfm 完成。
 */

import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * 末尾保留的不稳定块数量。末块显然还会继续长；它前面那一块也不安全——惰性续行
 * 与 setext 标题都能让下一个 chunk 改写上一块的形状，留两块即可覆盖。
 */
const UNSTABLE_TAIL_BLOCKS = 2;

/** 一个已冻结的顶层块：源码片段 + 它在整篇文本里的起始偏移（渲染 key）。 */
export type MarkdownBlock = {
  readonly key: number;
  readonly source: string;
};

export type MarkdownBlocks = {
  /** 不再变化的块，按源码顺序。 */
  readonly frozen: readonly MarkdownBlock[];
  /** 冻结点之后的尾部源码，每个 chunk 重新解析这一段。 */
  readonly tail: string;
  /**
   * 文本里出现了引用式定义（脚注定义、链接引用定义）：定义与引用只有在同一次解析里
   * 才能对上，逐块渲染会把它们拆散。为此调用方必须退回整篇渲染。
   *
   * 只看定义、不看引用：没有定义的 `[^1]` / `[a][b]` 在整篇解析里同样是字面文本，
   * 逐块渲染的结果一致；定义随后到达时这里会翻成 true，整篇重渲染补齐。
   */
  readonly crossBlockReference: boolean;
};

/** 行首的 `[label]:` / `[^label]:`；`>` 与缩进覆盖引用块、列表里的定义。 */
const REFERENCE_DEFINITION = /^ {0,3}>? {0,3}\[[^\]\n]+\]:\s*\S/m;

function blockCarriesDefinition(type: string, source: string): boolean {
  // CommonMark 自己就把顶层链接引用定义解析成 definition 节点，精确命中。
  if (type === "definition") return true;
  if (type === "code" || type === "html") return false;
  return REFERENCE_DEFINITION.test(source);
}

const EMPTY_BLOCKS: readonly MarkdownBlock[] = [];

/**
 * 追加式文本的分块器：同一实例喂逐渐变长的同一篇文本。
 * 传入的文本不再是上一次的前缀时（重开会话、落盘改写）自动整体重来。
 */
export class IncrementalMarkdownBlocks {
  #text = "";
  /** 冻结点：整篇源码里已冻结部分的结束偏移。 */
  #base = 0;
  #frozen: MarkdownBlock[] = [];
  #frozenView: readonly MarkdownBlock[] = EMPTY_BLOCKS;
  #crossBlockReference = false;
  #cache: MarkdownBlocks | undefined;

  update(text: string): MarkdownBlocks {
    if (this.#cache !== undefined && text === this.#text) return this.#cache;
    if (!text.startsWith(this.#text)) {
      this.#text = "";
      this.#base = 0;
      this.#frozen = [];
      this.#frozenView = EMPTY_BLOCKS;
      this.#crossBlockReference = false;
    }
    this.#text = text;
    const base = this.#base;
    const blocks = fromMarkdown(text.slice(base)).children;
    const firstUnstable = blocks.length - UNSTABLE_TAIL_BLOCKS;
    if (!this.#crossBlockReference) {
      for (const node of blocks) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        if (blockCarriesDefinition(node.type, text.slice(base + start, base + end))) {
          this.#crossBlockReference = true;
          break;
        }
      }
    }
    if (firstUnstable > 0) {
      const cutEnd = blocks[firstUnstable - 1]?.position?.end.offset;
      const pending: MarkdownBlock[] = [];
      for (let index = 0; index < firstUnstable; index += 1) {
        const position = blocks[index]?.position;
        if (position?.start.offset === undefined || position.end.offset === undefined) {
          pending.length = 0;
          break;
        }
        pending.push({
          key: base + position.start.offset,
          source: text.slice(base + position.start.offset, base + position.end.offset),
        });
      }
      if (cutEnd !== undefined && pending.length === firstUnstable) {
        for (const block of pending) this.#frozen.push(block);
        this.#frozenView = this.#frozen.slice();
        this.#base = base + cutEnd;
      }
    }
    this.#cache = {
      frozen: this.#frozenView,
      tail: text.slice(this.#base),
      crossBlockReference: this.#crossBlockReference,
    };
    return this.#cache;
  }
}
