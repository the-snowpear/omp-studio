export const VIRTUAL_CONVERSATION_REVEAL_EVENT = "omp-conversation-virtual-reveal";

export type VirtualConversationRevealDetail = {
  readonly itemId: string;
  readonly toolCallId?: string;
};

/** Ask the mounted virtual transcript to materialize an offscreen row. */
export function requestVirtualConversationReveal(
  scroller: HTMLElement,
  detail: VirtualConversationRevealDetail,
): boolean {
  const event = new CustomEvent<VirtualConversationRevealDetail>(VIRTUAL_CONVERSATION_REVEAL_EVENT, {
    detail,
    cancelable: true,
  });
  scroller.dispatchEvent(event);
  return event.defaultPrevented;
}
