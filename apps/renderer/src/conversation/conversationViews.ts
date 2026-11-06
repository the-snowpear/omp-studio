import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { useEffect, type RefObject } from "react";
import type { ConversationIdentity } from "./conversationHost";
import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";

export type ConversationViewState = { runtimeEpoch: number; visibleSessionIds: readonly string[]; blockedSessionIds?: readonly string[]; views?: readonly ConversationViewState[] };
export class ConversationViewLeases {
  readonly #leases = new Map<object, { epoch: number; id: string }>();
  readonly #blockers = new Map<object, { epoch: number; id: string }>();
  #ownerKnown = false;
  #epoch: number | undefined;
  #scheduled = false;
  readonly #epochs = new Set<number>();
  constructor(readonly report: (state: ConversationViewState) => void, readonly multiple = false) {}
  setEpoch(epoch: number | undefined): void { this.#epoch = epoch; if (epoch !== undefined) this.#epochs.add(epoch); this.#schedule(); }
  acquire(epoch: number, id: string): () => void {
    const token = {};
    this.#epochs.add(epoch);
    this.#leases.set(token, { epoch, id }); this.#schedule();
    return () => { this.#leases.delete(token); this.#schedule(); };
  }
  setOwnerKnown(): void { this.#ownerKnown = true; this.#schedule(); }
  block(epoch: number, id: string): () => void {
    const token = {}; this.#blockers.set(token, { epoch, id }); this.#schedule();
    return () => { this.#blockers.delete(token); this.#schedule(); };
  }
  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      const epoch = this.#epoch;
      if (epoch === undefined) return;
      const ids = [...new Set([...this.#leases.values()].filter((lease) => lease.epoch === epoch).map((lease) => lease.id))];
      const blocked = [...new Set([...this.#blockers.values()].filter(lease => lease.epoch === epoch).map(lease => lease.id))];
      if (this.multiple) {
        const views = [...this.#epochs].map(runtimeEpoch => ({ runtimeEpoch,
          visibleSessionIds: [...new Set([...this.#leases.values()].filter(lease => lease.epoch === runtimeEpoch).map(lease => lease.id))],
          blockedSessionIds: [...new Set([...this.#blockers.values()].filter(lease => lease.epoch === runtimeEpoch).map(lease => lease.id))],
        }));
        this.report({ runtimeEpoch: epoch, visibleSessionIds: ids, blockedSessionIds: blocked, views });
      } else if (ids.length <= 8 && blocked.length <= 8) this.report({ runtimeEpoch: epoch, visibleSessionIds: ids, ...(this.#ownerKnown ? { blockedSessionIds: blocked } : {}) });
    });
  }
}
const surfaces = new Map<Document, ConversationViewLeases>();
let currentEpoch: number | undefined;
export function registerConversationSurface(doc: Document): () => void {
  const leases = new ConversationViewLeases(state => { void surfaceWindow(doc).ompStudioChrome?.setConversationViewState?.(state).catch(() => {}); }, true);
  leases.setOwnerKnown(); leases.setEpoch(currentEpoch); surfaces.set(doc, leases);
  return () => { surfaces.delete(doc); };
}
export const conversationViewLeases = new ConversationViewLeases((state) => {
  currentEpoch = state.runtimeEpoch;
  for (const leases of surfaces.values()) leases.setEpoch(currentEpoch);
  void globalThis.ompStudioChrome?.setConversationViewState?.(state).catch(() => {});
}, true);

export function useConversationViewLease(identity: ConversationIdentity | null, demo: boolean, host: RefObject<HTMLElement | null>, enabled = true): void {
  const doc = useSurfaceDocument();
  const target = useExecutionTarget();
  const leases = surfaces.get(doc) ?? conversationViewLeases;
  const epoch = identity?.runtimeEpoch, id = identity?.sessionId;
  useEffect(() => {
    if (target.id !== null || demo || !enabled || epoch === undefined || id === undefined || host.current === null || globalThis.ompStudioChrome?.setConversationViewState === undefined) return;
    let release: (() => void) | undefined;
    const update = (visible: boolean) => {
      if (visible && release === undefined) release = leases.acquire(Number(epoch), id);
      if (!visible) { release?.(); release = undefined; }
    };
    if (typeof IntersectionObserver === "undefined") update(true);
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => update(entries.some((entry) => entry.isIntersecting)));
    observer?.observe(host.current);
    return () => { observer?.disconnect(); release?.(); };
  }, [epoch, id, demo, enabled, host, doc, leases, target.id]);
}
