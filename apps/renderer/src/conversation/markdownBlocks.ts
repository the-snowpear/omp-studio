export type StreamingCodeFence = { readonly language: string; readonly code: string };
export type StreamingMarkdownParts = {
  readonly closed: readonly string[];
  readonly tail: string;
  readonly openFence?: StreamingCodeFence;
};

const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S+/m;

type Fence = { readonly marker: "`" | "~"; readonly size: number };
type OpenFence = { readonly start: number; readonly contentStart: number; readonly language: string };

/**
 * 可恢复的扫描位置：某个「完整行」的行首偏移，加上扫到那里时的围栏状态与已确定切点数。
 * 追加式增长下这一行之前的判定都不可能再变，所以下一帧从这里接着扫即可。
 */
type Checkpoint = {
  readonly at: number;
  readonly fence: Fence | null;
  readonly openFence: OpenFence | null;
};
type CheckpointCandidate = Checkpoint & { readonly cutCount: number };

/** 扫描结果 + 下一帧续扫所需的全部状态。
 *
 * `frozen` 只在又有块真正越过检查点时换引用；普通 token 追加只更新最多三行的
 * `pending` 与尾块。Renderer 因而能把整段 frozen 子树一起 memo 掉，而不是每帧重新
 * map 全部历史块。
 */
export type StreamingMarkdownScan = {
  readonly source: string;
  readonly keepWhole: boolean;
  readonly frozen: readonly string[];
  readonly pending: readonly string[];
  readonly tail: string;
  readonly openFence?: StreamingCodeFence;
  readonly checkpoint: Checkpoint;
  readonly frozenAt: number;
  /** 上一帧末尾那条未完成行的起点；引用定义只需从这里继续检查。 */
  readonly referenceAt: number;
};

const EMPTY_CHECKPOINT: Checkpoint = { at: 0, fence: null, openFence: null };
const APPEND_HEAD_ANCHOR = 64;
const APPEND_TAIL_ANCHOR = 256;

/**
 * 检查点必须比「最后一个完整行」退后几行。
 *
 * 空行是否成为切点要看它后面两行（`next` 决定是否松散续行，`afterNext` 决定是否
 * setext 下划线），所以行 i 的判定只有在 i+2 也已完整时才算定下来 —— 检查点取
 * `L-2`（L = 最后一个完整行）就够，这里多留一行余量。每帧重扫的行数因此是常数，
 * 与正文长度、代码围栏长度都无关。
 */
const CHECKPOINT_LAG_LINES = 3;

function fenceAt(line: string): Fence | null {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (match === null) return null;
  const token = match[1]!;
  return { marker: token[0] as "`" | "~", size: token.length };
}

/** 从 `from` 起的一行（去掉行尾换行）与下一行起点；`from` 已在末尾时返回 null。 */
function lineAt(source: string, from: number): { readonly line: string; readonly next: number } | null {
  if (from >= source.length) return null;
  const newline = source.indexOf("\n", from);
  const end = newline >= 0 ? newline + 1 : source.length;
  return { line: source.slice(from, end).replace(/\r?\n$/, ""), next: end };
}

/**
 * Runtime 的 message delta 是追加语义。这里用首尾两个定长锚点防住组件复用时的替换，
 * 避免 `startsWith(previous.source)` 为了证明追加关系又把整段前缀扫描一遍。
 * 缩短、等长改写和边界附近改写都会退回全量扫描。
 */
function appendedTo(source: string, previous: StreamingMarkdownScan): boolean {
  if (source.length === previous.source.length) return source === previous.source;
  if (source.length < previous.source.length) return false;
  const headEnd = Math.min(APPEND_HEAD_ANCHOR, previous.source.length);
  const tailStart = Math.max(0, previous.source.length - APPEND_TAIL_ANCHOR);
  return source.slice(0, headEnd) === previous.source.slice(0, headEnd)
    && source.slice(tailStart, previous.source.length) === previous.source.slice(tailStart);
}

function lastIncompleteLineStart(source: string): number {
  return source.lastIndexOf("\n") + 1;
}

function blocksAt(source: string, from: number, cuts: readonly number[]): string[] {
  const blocks: string[] = [];
  let start = from;
  for (const cut of cuts) {
    if (cut <= start || cut >= source.length) continue;
    blocks.push(source.slice(start, cut));
    start = cut;
  }
  return blocks;
}

/**
 * 增量扫描：把不可变的已完成块与可变的流式尾部分开。
 *
 * 把上一帧的结果作为 `previous` 传回来，扫描就从它的检查点续上，只处理新到的文本
 * （加上固定几行的重扫余量）。原实现每帧 `source.split(/(?<=\n)/)` 再逐行跑三四个
 * 正则：回复越长每帧越贵，一段几千行的流式代码围栏更是每帧全量重扫一遍。
 */
export function scanStreamingMarkdown(source: string, previous?: StreamingMarkdownScan): StreamingMarkdownScan {
  if (source.length === 0) {
    return {
      source,
      keepWhole: false,
      frozen: [],
      pending: [],
      tail: source,
      checkpoint: EMPTY_CHECKPOINT,
      frozenAt: 0,
      referenceAt: 0,
    };
  }
  const appended = previous !== undefined && appendedTo(source, previous);
  /* 引用定义可以由上一帧末尾的半行补成，所以从那条半行的行首开始检查；此前的完整行
     已经判过，不必每帧再跑一遍全文正则。一旦命中，append-only 流里永远保持 true。 */
  const referenceFrom = appended && previous !== undefined ? previous.referenceAt : 0;
  const keepWhole = appended && previous?.keepWhole === true
    ? true
    : REFERENCE_DEFINITION.test(source.slice(referenceFrom));
  const resumable = appended && previous !== undefined && previous.keepWhole === keepWhole;
  const base = resumable ? previous.checkpoint : EMPTY_CHECKPOINT;
  const baseFrozen = resumable ? previous.frozen : [];
  const baseFrozenAt = resumable ? previous.frozenAt : 0;
  const cuts: number[] = [];
  let fence = base.fence;
  let openFence = base.openFence;
  /** 最近 CHECKPOINT_LAG_LINES 个完整行行首的可恢复状态，够数时取最旧的那个当新检查点。 */
  const candidates: CheckpointCandidate[] = [];
  let offset = base.at;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const complete = newline >= 0;
    /* 只有完整行能当检查点：末尾那半行的内容下一帧还会变。 */
    if (complete) {
      candidates.push({ at: offset, fence, openFence, cutCount: cuts.length });
      if (candidates.length > CHECKPOINT_LAG_LINES) candidates.shift();
    }
    const raw = source.slice(offset, complete ? newline + 1 : source.length);
    const line = raw.replace(/\r?\n$/, "");
    const token = fenceAt(line);
    if (token !== null) {
      if (fence === null) {
        const markerOffset = line.search(/[`~]/);
        const info = line.slice(markerOffset + token.size).trim();
        fence = token;
        openFence = {
          start: offset,
          contentStart: offset + raw.length,
          language: /^[\w+#.-]+/.exec(info)?.[0] ?? "",
        };
      } else if (token.marker === fence.marker && token.size >= fence.size) {
        fence = null;
        openFence = null;
      }
    }
    offset += raw.length;
    if (keepWhole || fence !== null || line.trim().length !== 0) continue;
    const first = lineAt(source, offset);
    const next = first?.line ?? "";
    const second = first === null ? null : lineAt(source, first.next);
    const afterNext = second?.line ?? "";
    if (next.length === 0 || /^\s/.test(next) || /^\s{0,3}(?:=+|-+)\s*$/.test(afterNext)) continue;
    cuts.push(offset);
  }
  /* 候选不够数说明这一段里完整行本来就少（消息刚开头）；此时沿用旧检查点 —— 它当初
     就满足「退后两行」，而最后一个完整行只会往后走，所以现在依然安全。 */
  const candidate = candidates.length >= CHECKPOINT_LAG_LINES
    ? candidates[0]
    : undefined;
  const promoteCount = candidate?.cutCount ?? 0;
  const promotedCuts = cuts.slice(0, promoteCount);
  const checkpoint: Checkpoint = candidate === undefined
    ? base
    : { at: candidate.at, fence: candidate.fence, openFence: candidate.openFence };
  const promoted = blocksAt(source, baseFrozenAt, promotedCuts);
  const frozen = promoted.length === 0 ? baseFrozen : [...baseFrozen, ...promoted];
  const frozenAt = promotedCuts.at(-1) ?? baseFrozenAt;
  const pendingCuts = cuts.slice(promoteCount);
  const pending = blocksAt(source, frozenAt, pendingCuts);
  const start = pendingCuts.at(-1) ?? frozenAt;
  const referenceAt = lastIncompleteLineStart(source);
  if (openFence !== null && openFence.start >= start) {
    return {
      source,
      keepWhole,
      frozen,
      pending,
      tail: source.slice(start, openFence.start),
      openFence: { language: openFence.language, code: source.slice(openFence.contentStart) },
      checkpoint,
      frozenAt,
      referenceAt,
    };
  }
  return { source, keepWhole, frozen, pending, tail: source.slice(start), checkpoint, frozenAt, referenceAt };
}

/** 一次性分块（无续扫状态）。只返回渲染需要的三个字段。 */
export function splitStreamingMarkdown(source: string): StreamingMarkdownParts {
  const scan = scanStreamingMarkdown(source);
  const closed = scan.pending.length === 0 ? scan.frozen : [...scan.frozen, ...scan.pending];
  return scan.openFence === undefined
    ? { closed, tail: scan.tail }
    : { closed, tail: scan.tail, openFence: scan.openFence };
}
