import { useEffect, type RefObject } from "react";
import type { ConversationIdentity } from "./conversationHost";

export type ConversationViewState = { runtimeEpoch: number; visibleSessionIds: readonly string[] };
export class ConversationViewLeases {
  readonly #leases = new Map<object, { epoch: number; id: string }>();
  #epoch: number | undefined;
  #scheduled = false;
  constructor(readonly report: (state: ConversationViewState) => void) {}
  setEpoch(epoch: number | undefined): void { this.#epoch = epoch; this.#schedule(); }
  acquire(epoch: number, id: string): () => void {
    const token = {};
    this.#leases.set(token, { epoch, id }); this.#schedule();
    return () => { this.#leases.delete(token); this.#schedule(); };
  }
  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      const epoch = this.#epoch;
      if (epoch === undefined) return;
      const ids = [...new Set([...this.#leases.values()].filter((lease) => lease.epoch === epoch).map((lease) => lease.id))];
      if (ids.length <= 8) this.report({ runtimeEpoch: epoch, visibleSessionIds: ids });
    });
  }
}
export const conversationViewLeases = new ConversationViewLeases((state) => {
  void globalThis.ompStudioChrome?.setConversationViewState?.(state).catch(() => {});
});

export function useConversationViewLease(identity: ConversationIdentity | null, demo: boolean, host: RefObject<HTMLElement | null>, enabled = true): void {
  const epoch = identity?.runtimeEpoch, id = identity?.sessionId;
  useEffect(() => {
    if (demo || !enabled || epoch === undefined || id === undefined || host.current === null || globalThis.ompStudioChrome?.setConversationViewState === undefined) return;
    let release: (() => void) | undefined;
    const update = (visible: boolean) => {
      if (visible && release === undefined) release = conversationViewLeases.acquire(Number(epoch), id);
      if (!visible) { release?.(); release = undefined; }
    };
    if (typeof IntersectionObserver === "undefined") update(true);
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => update(entries.some((entry) => entry.isIntersecting)));
    observer?.observe(host.current);
    return () => { observer?.disconnect(); release?.(); };
  }, [epoch, id, demo, enabled, host]);
}
