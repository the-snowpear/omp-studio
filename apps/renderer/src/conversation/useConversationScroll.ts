import type { RefObject, UIEvent } from "react";

/** How close to the tail counts as "back at the tail" when the user returns. */
export const FOLLOW_THRESHOLD_PX = 72;
/** Distances this small *are* the tail (exact landing, or a browser clamp after content shrank). */
export const AT_TAIL_PX = 1;

export type ScrollDirection = "up" | "down";

export function distanceFromBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function shouldFollow(distance: number, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distance <= threshold;
}

/** Keys that scroll the conversation when the scroller itself has focus. */
export function keyScrollDirection(key: string): ScrollDirection | null {
  if (key === "ArrowUp" || key === "PageUp" || key === "Home") return "up";
  if (key === "ArrowDown" || key === "PageDown" || key === "End" || key === " ") return "down";
  return null;
}

export type ScrollBoxLike = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** `overscroll-behavior-y: contain | none` — the wheel never chains outward. */
  readonly containsOverscroll: boolean;
};

/**
 * Does a nested scroller (expanded tool / think card, xd:// list…) swallow this
 * wheel instead of the conversation? Mirrors the browser's own chaining rules,
 * so reading a think card does not detach the transcript from the tail.
 */
export function innerAbsorbsScroll(chain: readonly ScrollBoxLike[], direction: ScrollDirection): boolean {
  for (const box of chain) {
    if (box.scrollHeight - box.clientHeight <= 1) continue;
    if (box.containsOverscroll) return true;
    const room = direction === "up" ? box.scrollTop : box.scrollHeight - box.clientHeight - box.scrollTop;
    if (room > 1) return true;
  }
  return false;
}

export function bindTailGestures(_el: HTMLElement, _pinned: () => boolean, _unpin: () => void): () => void {
  return () => {};
}

export type ScrollAnchor = {
  readonly itemId: string;
  readonly offset: number;
};

export function captureAnchor(_scroller: HTMLElement): ScrollAnchor | null {
  return null;
}

/** First row in document order — changes exactly when a page is prepended. */
export function firstItemId(scroller: HTMLElement): string | null {
  return scroller.querySelector<HTMLElement>("[data-item-id]")?.dataset.itemId ?? null;
}

export function restoreAnchor(_scroller: HTMLElement, _anchor: ScrollAnchor): void {}

/**
 * 贴底跟随的内容指纹。每次 render 都要算一遍，所以只累加长度，不拼字符串：
 * live 缓冲只增不减，任何增长都会改变这两个和。
 */
export function conversationFollowKey(state: {
  readonly liveTools: { readonly [toolCallId: string]: { readonly output?: string } };
  readonly liveMessages: { readonly [messageId: string]: { readonly blocks: readonly { readonly text: string }[] } };
}): string {
  let toolCount = 0;
  let toolChars = 0;
  for (const key in state.liveTools) {
    const tool = state.liveTools[key];
    if (tool === undefined) continue;
    toolCount += 1;
    toolChars += tool.output?.length ?? 0;
  }
  let blockCount = 0;
  let messageChars = 0;
  for (const key in state.liveMessages) {
    const message = state.liveMessages[key];
    if (message === undefined) continue;
    for (const block of message.blocks) {
      blockCount += 1;
      messageChars += block.text.length;
    }
  }
  return `${toolCount}:${toolChars}|${blockCount}:${messageChars}`;
}

export function useConversationScroll(_args: {
  scrollerRef: RefObject<HTMLElement | null>;
  identityKey: string;
  itemCount: number;
  loadingOlder: boolean;
  /** Welcome / new-chat surface stays at the top; transcripts stick to the bottom. */
  pin?: "top" | "bottom";
  /**
   * Grows when live text / tool stdout changes without adding a row.
   * Same follow rules as itemCount: stick when pinned to bottom.
   */
  contentKey?: string;
}): {
  follow: boolean;
  hasNewContent: boolean;
  onScroll: (event: UIEvent<HTMLElement>) => void;
  jumpToLatest: () => void;
  preparePrepend: () => void;
} {
  return {
    follow: true,
    hasNewContent: false,
    onScroll: () => {},
    jumpToLatest: () => {},
    preparePrepend: () => {},
  };
}

// --- Deleted: scroll intent detection, multi-frame sticky, anchor restore, gesture binding implementation ---
