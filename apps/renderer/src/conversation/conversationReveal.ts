import { scrollOffsetToCenter } from "./ConversationMinimap";
import { requestVirtualConversationReveal } from "./virtualConversationReveal";

const FLASH_MS = 900;

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
  if (node === null) {
    return target.itemId === undefined
      ? false
      : requestVirtualConversationReveal(scroller, { itemId: target.itemId, toolCallId: target.toolCallId });
  }
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
