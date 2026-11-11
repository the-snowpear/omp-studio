import { scrollOffsetToCenter } from "./ConversationMinimap";
import { MOTION_MS } from "../motion";

const FLASH_MS = MOTION_MS.flash;
export const CONVERSATION_REVEAL = "omp-conversation-reveal";
export type ConversationRevealRequest = {
  toolCallId?: string;
  itemId?: string;
  offset?: number;
  flash?: boolean;
  finish: (found: boolean) => void;
};

/** The transcript resolves data identity before the virtualizer mounts the row. */
export function revealConversationTarget(scroller: HTMLElement | null, target: Omit<ConversationRevealRequest, "finish">): Promise<boolean> {
  if (scroller === null) return Promise.resolve(false);
  return new Promise(resolve => {
    const request: ConversationRevealRequest = { ...target, finish: resolve };
    if (scroller.dispatchEvent(new CustomEvent(CONVERSATION_REVEAL, { detail: request, cancelable: true }))) resolve(false);
  });
}

export function revealMountedConversationItem(scroller: HTMLElement, request: ConversationRevealRequest): void {
  const item = request.itemId === undefined ? null : scroller.querySelector<HTMLElement>(`[data-item-id="${cssEscape(request.itemId)}"]`);
  const tool = request.toolCallId === undefined ? null : scroller.querySelector<HTMLElement>(`[data-tool-call-id="${cssEscape(request.toolCallId)}"]`);
  const node = tool ?? item;
  if (node === null) { request.finish(false); return; }
  const top = request.offset === undefined ? scrollOffsetToCenter(scroller, node)
    : scroller.scrollTop + node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - request.offset;
  scroller.scrollTop = top;
  if (request.flash !== false) flashRow(node);
  request.finish(true);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

function flashRow(node: HTMLElement): void {
  node.classList.remove("mm-flash");
  void node.offsetWidth;
  node.classList.add("mm-flash");
  window.setTimeout(() => node.classList.remove("mm-flash"), FLASH_MS);
}

/** Scroll the conversation scroller to the matching bash card. Never uses scrollIntoView. */
export function revealConversationTool(
  scroller: HTMLElement | null,
  target: { readonly toolCallId: string; readonly itemId?: string },
): boolean {
  if (scroller === null) return false;
  const toolNode = scroller.querySelector<HTMLElement>(`[data-tool-call-id="${cssEscape(target.toolCallId)}"]`);
  const node = toolNode ?? (
    target.itemId === undefined
      ? null
      : scroller.querySelector<HTMLElement>(`[data-item-id="${cssEscape(target.itemId)}"]`)
  );
  if (node === null) return false;
  if (toolNode !== null && !toolNode.classList.contains("open")) {
    toolNode.querySelector<HTMLButtonElement>("button.tl-row")?.click();
  }
  const top = scrollOffsetToCenter(scroller, node);
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top, behavior: "smooth" });
  } else {
    scroller.scrollTop = top;
  }
  flashRow(node);
  return true;
}
