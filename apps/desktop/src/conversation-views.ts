import { CONVERSATION_LIMITS } from "@omp-studio/studio-protocol";
export const CONVERSATION_VIEW_CHANNEL = "omp-studio:chrome:set-conversation-view-state";
export interface ConversationViewState { runtimeEpoch: number; visibleSessionIds: readonly string[] }
export function parseConversationViewState(value: unknown): ConversationViewState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !Number.isSafeInteger(raw.runtimeEpoch) || Number(raw.runtimeEpoch) <= 0
    || !Array.isArray(raw.visibleSessionIds) || raw.visibleSessionIds.length > 8
    || raw.visibleSessionIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS)) return undefined;
  return { runtimeEpoch: raw.runtimeEpoch as number, visibleSessionIds: [...new Set(raw.visibleSessionIds as string[])] };
}
type Controller = { epoch: () => number | undefined; setVisibleSessions: (ids: ReadonlySet<string> | undefined) => void };
type View = { visible: boolean; state?: ConversationViewState };
/** Window truth and Renderer interest are combined before choosing a policy. */
export class ConversationViews {
  readonly #controllers = new Map<Controller, string>();
  readonly #windows = new Map<object, View>();
  #hasReport = false;
  registerController(controller: Controller): () => void {
    this.#controllers.set(controller, ""); this.refresh();
    return () => { this.#controllers.delete(controller); };
  }
  registerWindow(key: object, visible: boolean): void { this.#windows.set(key, { visible }); this.refresh(); }
  setVisible(key: object, visible: boolean): void { const view = this.#windows.get(key); if (view) { view.visible = visible; this.refresh(); } }
  reset(key: object): void { const view = this.#windows.get(key); if (view) { delete view.state; this.refresh(); } }
  remove(key: object): void { this.#windows.delete(key); this.refresh(); }
  report(key: object, input: unknown): boolean {
    const view = this.#windows.get(key), state = parseConversationViewState(input);
    if (view === undefined || state === undefined || ![...this.#controllers.keys()].some((controller) => controller.epoch() === state.runtimeEpoch)) return false;
    view.state = state; this.#hasReport = true; this.refresh(); return true;
  }
  refresh(): void {
    const epochs = new Set([...this.#controllers.keys()].map((controller) => controller.epoch()));
    for (const view of this.#windows.values()) if (view.state && !epochs.has(view.state.runtimeEpoch)) delete view.state;
    const legacy = !this.#hasReport || [...this.#windows.values()].some((view) => view.state === undefined);
    for (const [controller, previous] of this.#controllers) {
      const epoch = controller.epoch();
      const visible = new Set<string>();
      for (const view of this.#windows.values()) if (view.visible && view.state !== undefined && view.state.runtimeEpoch === epoch) {
        for (const id of view.state.visibleSessionIds) visible.add(id);
      }
      const signature = `${epoch}:${legacy ? "legacy" : [...visible].sort().join("\u0000")}`;
      if (signature === previous) continue;
      this.#controllers.set(controller, signature);
      controller.setVisibleSessions(legacy ? undefined : visible);
    }
  }
}
