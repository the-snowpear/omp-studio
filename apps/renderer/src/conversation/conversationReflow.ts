export const CONVERSATION_LAYOUT_BEFORE_CHANGE = "omp-conversation-layout-before-change";
export const CONVERSATION_LAYOUT_CHANGE = "omp-conversation-layout-change";

/** Call around committed geometry changes, not around transcript/token updates. */
export function beforeConversationLayoutChange(): void {
  window.dispatchEvent(new Event(CONVERSATION_LAYOUT_BEFORE_CHANGE));
}
export function afterConversationLayoutChange(): void {
  window.dispatchEvent(new Event(CONVERSATION_LAYOUT_CHANGE));
}

const SCROLL_RESET = "omp-conversation-scroll-reset";
const SCROLL_INTENT = "omp-conversation-scroll-intent";
type ScrollOwner = { readonly identity: string; readonly following: () => boolean };
const owners = new WeakMap<HTMLElement, ScrollOwner>();
const reflowing = new WeakSet<HTMLElement>();
const compensationTop = new WeakMap<HTMLElement, number>();

/** The follow hook remains the authority, including its gesture-unpin grace period. */
export function registerConversationScroll(scroller: HTMLElement, identity: string, following: () => boolean): () => void {
  const owner = { identity, following };
  owners.set(scroller, owner);
  scroller.dispatchEvent(new Event(SCROLL_RESET));
  return () => {
    if (owners.get(scroller) !== owner) return;
    owners.delete(scroller);
    scroller.dispatchEvent(new Event(SCROLL_RESET));
  };
}
export function conversationScrollIdentity(scroller: HTMLElement): string {
  return owners.get(scroller)?.identity ?? "";
}
export function conversationIsFollowing(scroller: HTMLElement): boolean {
  return owners.get(scroller)?.following() ?? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
}
/** Minimap / jump / prepend also count as navigation, even without a wheel event. */
export function cancelConversationReflow(scroller: HTMLElement): void {
  compensationTop.delete(scroller);
  scroller.dispatchEvent(new Event(SCROLL_INTENT));
}
export function isConversationReflowScroll(scroller: HTMLElement): boolean {
  const top = compensationTop.get(scroller);
  if (top !== undefined) compensationTop.delete(scroller);
  return reflowing.has(scroller) || (top !== undefined && Math.abs(top - scroller.scrollTop) < 1);
}
export function isConversationReflowing(scroller: HTMLElement): boolean {
  return reflowing.has(scroller);
}

/** A message plus one visible semantic block. No text copies, character Ranges,
 * or transcript-wide queries: the row window is sorted normal-flow DOM. */
export type ConversationReflowAnchor = {
  readonly rowKey: string;
  readonly row: HTMLElement;
  readonly rowOffset: number;
  readonly block: HTMLElement;
  readonly blockOffset: number;
  readonly blockPath: readonly number[];
  readonly scrollTop: number;
};
const BLOCK = "p,li,pre,blockquote,table,h1,h2,h3,h4,h5,h6,.md-code,.tool-card,.think-card,.ev-head";

function childAtViewport(parent: Element, top: number, bottom: number): HTMLElement | null {
  const children = parent.children;
  let low = 0; let high = children.length - 1;
  // Rows and prose blocks are in document order. Binary search avoids reading
  // every paragraph of a single very long assistant response on every scroll.
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const rect = children[mid]!.getBoundingClientRect();
    if (rect.bottom <= top) low = mid + 1;
    else high = mid - 1;
  }
  const child = children[low];
  if (!(child instanceof HTMLElement)) return null;
  const rect = child.getBoundingClientRect();
  return rect.height > 0 && rect.top < bottom ? child : null;
}
function pathTo(row: HTMLElement, block: HTMLElement): number[] {
  const path: number[] = [];
  let node: Element = block;
  while (node !== row && node.parentElement !== null) {
    const parent = node.parentElement;
    path.push(Array.prototype.indexOf.call(parent.children, node) as number);
    node = parent;
  }
  return path.reverse();
}
function visibleBlock(row: HTMLElement, top: number, bottom: number): HTMLElement {
  const rect = row.getBoundingClientRect();
  const x = rect.left + Math.min(64, rect.width / 2);
  const hit = row.ownerDocument.elementFromPoint?.(x, Math.min(bottom - 1, top + 12));
  if (hit && row.contains(hit)) {
    const block = hit.closest<HTMLElement>(BLOCK);
    if (block && row.contains(block)) return block;
  }
  // Whitespace between blocks (or no hit-testing, e.g. jsdom). Descend only
  // along the visible branch; never querySelectorAll the whole markdown tree.
  let node = row;
  for (let depth = 0; depth < 8; depth++) {
    const child = childAtViewport(node, top, bottom);
    if (child === null) break;
    node = child;
    if (node.matches(BLOCK)) break;
  }
  return node;
}
export function captureConversationReflowAnchor(scroller: HTMLElement, host: HTMLElement): ConversationReflowAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  const row = childAtViewport(host, viewport.top, viewport.bottom);
  const rowKey = row?.dataset.rowKey;
  if (!row || rowKey === undefined) return null;
  const rowRect = row.getBoundingClientRect();
  const block = visibleBlock(row, Math.max(viewport.top, rowRect.top), Math.min(viewport.bottom, rowRect.bottom));
  return {
    rowKey, row, block, blockPath: pathTo(row, block), scrollTop: scroller.scrollTop,
    rowOffset: rowRect.top - viewport.top,
    blockOffset: block.getBoundingClientRect().top - viewport.top,
  };
}

/** Reflow is NOT prepend. It can shrink as well as grow, and content below the
 * reader is irrelevant. If the message is gone, do nothing — never apply a
 * total-scrollHeight delta or force the reader to the tail. */
export function restoreConversationReflowAnchor(scroller: HTMLElement, host: HTMLElement, anchor: ConversationReflowAnchor): boolean {
  const row = anchor.row.parentElement === host ? anchor.row : Array.from(host.children).find((node) => (node as HTMLElement).dataset.rowKey === anchor.rowKey);
  if (!(row instanceof HTMLElement)) return false;
  let block: Element | undefined = anchor.block;
  if (!row.contains(block)) {
    block = row;
    for (const index of anchor.blockPath) block = block?.children[index];
    if (block?.tagName !== anchor.block.tagName) block = undefined;
  }
  const node = block ?? row;
  const offset = block === undefined ? anchor.rowOffset : anchor.blockOffset;
  const delta = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  if (Math.abs(delta) > 0.5) {
    scroller.scrollTop += delta;
    compensationTop.set(scroller, scroller.scrollTop);
  }
  return true;
}

type StableLayout = {
  readonly width: number;
  readonly owner: ScrollOwner | undefined;
  readonly following: boolean;
  readonly anchor: ConversationReflowAnchor | null;
};
type PendingReflow = { readonly saved: StableLayout; remaining: number; expectedTop: number };
export type ConversationReflowObserver = { afterCommit: () => void; dispose: () => void };

/** One observer for the host/scroller/parent, shared with margin measurement.
 * Native resize starts from a previously saved stable layout/scroll snapshot —
 * the ResizeObserver callback is already too late to capture the old geometry. */
export function observeConversationReflow({ scroller, host, beforeEvent, changeEvent, measureMargin, measure, pinRow }: {
  scroller: HTMLElement;
  host: HTMLElement;
  beforeEvent: string;
  changeEvent: string;
  measureMargin: () => void;
  measure: (width: number) => void;
  pinRow: (key: string | null) => void;
}): ConversationReflowObserver {
  let stable: StableLayout | null = null;
  let pending: PendingReflow | null = null;
  let width = host.getBoundingClientRect().width;
  let settleFrame = 0; let snapshotFrame = 0;
  let disposed = false;
  const readStable = () => {
    const following = conversationIsFollowing(scroller);
    stable = { width, owner: owners.get(scroller), following, anchor: following ? null : captureConversationReflowAnchor(scroller, host) };
  };
  const snapshot = () => {
    snapshotFrame = 0;
    if (disposed || pending !== null) return;
    const nextWidth = host.getBoundingClientRect().width;
    // A scroll event can precede RO delivery during native resize. Do not
    // overwrite the old-layout snapshot with positions from the new width.
    if (Math.abs(nextWidth - width) >= 0.5) return;
    readStable();
  };
  const scheduleSnapshot = () => {
    if (!snapshotFrame && !disposed) snapshotFrame = requestAnimationFrame(snapshot);
  };
  const cancel = () => {
    cancelAnimationFrame(settleFrame); settleFrame = 0;
    pending = null;
    reflowing.delete(scroller);
    pinRow(null);
  };
  const intent = () => {
    cancel();
    stable = null;
    scheduleSnapshot();
  };
  const restore = () => {
    if (pending === null) return;
    if (pending.saved.owner !== owners.get(scroller)) { intent(); return; }
    const anchor = pending.saved.anchor;
    if (anchor !== null) restoreConversationReflowAnchor(scroller, host, anchor);
    pending.expectedTop = scroller.scrollTop;
  };
  const settle = () => {
    settleFrame = 0;
    if (pending === null || disposed) return;
    // The virtualizer defers its own row RO measurements one frame. Keep the
    // anchor through those commits, then release without a final scroll write.
    if (pending.remaining-- > 0) {
      restore();
      settleFrame = requestAnimationFrame(settle);
    } else {
      cancel();
      readStable();
    }
  };
  const begin = (saved: StableLayout | null) => {
    if (pending !== null || saved === null) return;
    if (saved.owner !== owners.get(scroller)) return;
    // No tail writer here. The existing useConversationScroll observes the
    // final document and owns every follow-to-tail write.
    if (saved.following || saved.anchor === null) return;
    pending = { saved, remaining: 2, expectedTop: scroller.scrollTop };
    reflowing.add(scroller);
    pinRow(saved.anchor.rowKey);
  };
  const before = () => {
    const actualWidth = host.getBoundingClientRect().width;
    if (pending === null && Math.abs(actualWidth - width) < 0.5) readStable();
    begin(stable);
  };
  const changed = () => {
    begin(stable);
    width = host.getBoundingClientRect().width;
    measureMargin();
    measure(width);
    restore();
    if (pending !== null) {
      pending.remaining = 2;
      if (!settleFrame) settleFrame = requestAnimationFrame(settle);
    } else scheduleSnapshot();
  };
  const resized = () => {
    const actualWidth = host.getBoundingClientRect().width;
    if (Math.abs(actualWidth - width) >= 0.5) changed();
    else { measureMargin(); scheduleSnapshot(); }
  };
  const wheel = (event: WheelEvent) => { if (event.deltaY !== 0) intent(); };
  const key = (event: KeyboardEvent) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) intent(); };
  const scroll = () => {
    // Scrollbar/minimap momentum can continue after pointerup with no new
    // gesture event. Only our own exact correction may keep a transaction alive.
    if (pending !== null && Math.abs(scroller.scrollTop - pending.expectedTop) > 1) intent();
    scheduleSnapshot();
  };
  const reset = () => { intent(); width = host.getBoundingClientRect().width; measure(width); };
  window.addEventListener(CONVERSATION_LAYOUT_BEFORE_CHANGE, before);
  window.addEventListener(CONVERSATION_LAYOUT_CHANGE, changed);
  window.addEventListener(beforeEvent, before);
  window.addEventListener(changeEvent, changed);
  scroller.addEventListener(SCROLL_RESET, reset);
  scroller.addEventListener(SCROLL_INTENT, intent);
  scroller.addEventListener("wheel", wheel, { passive: true });
  scroller.addEventListener("keydown", key);
  scroller.addEventListener("pointerdown", intent, { passive: true });
  scroller.addEventListener("touchstart", intent, { passive: true });
  scroller.addEventListener("scroll", scroll, { passive: true });
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
  observer?.observe(host);
  observer?.observe(scroller);
  if (host.parentElement !== null) observer?.observe(host.parentElement);
  measure(width);
  readStable();
  scheduleSnapshot();
  return {
    afterCommit: () => { restore(); },
    dispose: () => {
      disposed = true;
      cancel();
      cancelAnimationFrame(snapshotFrame);
      observer?.disconnect();
      window.removeEventListener(CONVERSATION_LAYOUT_BEFORE_CHANGE, before);
      window.removeEventListener(CONVERSATION_LAYOUT_CHANGE, changed);
      window.removeEventListener(beforeEvent, before);
      window.removeEventListener(changeEvent, changed);
      scroller.removeEventListener(SCROLL_RESET, reset);
      scroller.removeEventListener(SCROLL_INTENT, intent);
      scroller.removeEventListener("wheel", wheel);
      scroller.removeEventListener("keydown", key);
      scroller.removeEventListener("pointerdown", intent);
      scroller.removeEventListener("touchstart", intent);
      scroller.removeEventListener("scroll", scroll);
    },
  };
}
