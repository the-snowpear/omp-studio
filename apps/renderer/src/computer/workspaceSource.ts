import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import type {
  ComputerAction, ComputerFrame, ComputerObservationLease, ComputerWorkspaceChange,
  ComputerWorkspaceCommand, ComputerWorkspaceResultMap, ComputerWorkspaceSnapshot,
} from "@omp-studio/studio-protocol";
import { hostErrorMessage, waitReceipt } from "../hostError";

export async function computerCommand<K extends ComputerWorkspaceCommand["kind"]>(client: StudioClient, kind: K, input: CommandInput<K>): Promise<ComputerWorkspaceResultMap[K]> {
  const handle = await client.command(kind, input);
  return (await waitReceipt<{ result: ComputerWorkspaceResultMap[K] }>(client, handle.requestId, 30000)).result;
}
export type ComputerReadState = {
  snapshot: ComputerWorkspaceSnapshot | undefined;
  actions: readonly ComputerAction[];
  frames: readonly ComputerFrame[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | undefined;
  error: string;
};
const initialState = (): ComputerReadState => ({ snapshot: undefined, actions: [], frames: [], loading: true, loadingMore: false, nextCursor: undefined, error: "" });
function merge<T>(old: readonly T[], incoming: readonly T[], identity: (value: T) => string, max = 200): T[] {
  const byId = new Map(old.map(item => [identity(item), item]));
  for (const item of incoming) byId.set(identity(item), item);
  return [...byId.values()].slice(-max);
}
export type ObservationUpdate = { frame?: ComputerFrame; error?: string; paused?: boolean };
type Observation = { listeners: Set<(value: ObservationUpdate) => void>; timer?: ReturnType<typeof setTimeout>; idleSince: number; stopped: boolean };

/** Small renderer-only metadata subscription; no pixels, conversation reducer or input authority. */
export class ComputerWorkspaceSource {
  private state = initialState();
  private listeners = new Set<() => void>();
  private off: (() => void) | undefined;
  private generation = 0;
  private subscriptionGeneration = 0;
  mediaRevision = 0;
  private refreshing: Promise<void> | undefined;
  private pending: ComputerWorkspaceChange[] = [];
  private revision = -1;
  private lease: ComputerObservationLease | undefined;
  private leasePromise: Promise<ComputerObservationLease> | undefined;
  private leaseGeneration = 0;
  private observations = new Map<string, Observation>();
  private captures = new Map<string, Promise<ComputerFrame>>();
  private authority: string | undefined;
  private confirmedControl: ComputerWorkspaceSnapshot["control"] | undefined;
  constructor(readonly client: StudioClient, readonly sessionId: string, readonly scopeKey: string) {}
  getSnapshot = () => this.state;
  private publish(patch: Partial<ComputerReadState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.generation++; this.subscriptionGeneration++;
      this.off?.(); this.off = undefined;
      this.refreshing = undefined; this.pending = [];
      this.stopObserving();
      // Metadata may remain visible while parked. Extra observation frames never do.
      this.state = { ...this.state, frames: this.state.frames.filter(frame => frame.source === "execution") };
    };
  };
  private start() {
    this.generation++;
    const subscription = ++this.subscriptionGeneration;
    this.off = this.client.subscribe({ scope: "runtime" }, event => {
      if (subscription !== this.subscriptionGeneration) return;
      const authority = `${event.authorityEpoch}:${event.runtimeEpoch ?? ""}`;
      if (this.authority !== undefined && this.authority !== authority) {
        this.authority = authority;
        this.invalidate();
        return;
      }
      this.authority = authority;
      if (event.kind === "computer.changed" && event.change.sessionId === this.sessionId) {
        if (this.refreshing) this.pending.push(event.change);
        else this.applyChange(event.change);
      } else if (event.kind === "resync.required" || event.kind === "runtime.changed") this.invalidate();
    });
    void this.refresh();
  }
  private invalidate() {
    this.generation++; this.mediaRevision++; this.confirmedControl = undefined;
    this.stopObserving(); this.revision = -1; this.pending = []; this.refreshing = undefined;
    this.publish(initialState());
    void this.refresh();
  }
  refresh = (): Promise<void> => {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    this.publish({ loading: true, error: "" });
    const task = Promise.all([
      this.client.query("computer.workspace.get", { sessionId: this.sessionId }),
      this.client.query("computer.activity.list", { sessionId: this.sessionId, limit: 50 }),
    ]).then(([snapshot, page]) => {
      if (generation !== this.generation) return;
      this.revision = snapshot.revision;
      const bufferedActions = this.pending.flatMap(change => change.kind === "action" && change.revision > page.revision && change.revision <= snapshot.revision ? [change.action] : []);
      this.publish({ snapshot: this.withConfirmedControl(snapshot), actions: merge(merge(page.items, bufferedActions, action => action.id), snapshot.active, action => action.id), frames: merge(page.frames, snapshot.frames, frame => frame.frameId), nextCursor: page.nextCursor, loading: false });
    }).catch(cause => {
      if (generation === this.generation) this.publish({ loading: false, error: hostErrorMessage(cause, "无法读取电脑工作区 / Cannot read Computer workspace") });
    }).finally(() => {
      if (generation !== this.generation) return;
      this.refreshing = undefined;
      const queued = this.pending; this.pending = [];
      for (const change of queued) this.applyChange(change);
    });
    this.refreshing = task;
    return task;
  };
  private applyChange(change: ComputerWorkspaceChange) {
    if (change.revision <= this.revision && change.kind !== "reset") return;
    if (change.kind === "reset" || this.revision < 0 || change.revision > this.revision + 1) { void this.refresh(); return; }
    this.revision = change.revision;
    if (change.kind === "state") this.publish({ snapshot: this.withConfirmedControl(change.snapshot), frames: merge(this.state.frames, change.snapshot.frames, frame => frame.frameId), actions: merge(this.state.actions, change.snapshot.active, action => action.id) });
    else if (change.kind === "action") {
      const snapshot = this.state.snapshot;
      const active = snapshot?.active.filter(action => action.id !== change.action.id) ?? [];
      if (change.action.status === "running" || change.action.status === "waiting") active.push(change.action);
      this.publish({ actions: merge(this.state.actions, [change.action], action => action.id), ...(snapshot ? { snapshot: { ...snapshot, active } } : {}) });
    } else this.recordFrame(change.frame);
  }
  recordFrame(frame: ComputerFrame) {
    // Only the latest observation per target belongs to the live read model.
    const frames = frame.source === "observation" ? this.state.frames.filter(old => old.source !== "observation" || old.targetId !== frame.targetId) : this.state.frames;
    this.publish({ frames: merge(frames, [frame], item => item.frameId) });
  }
  private withConfirmedControl(snapshot: ComputerWorkspaceSnapshot): ComputerWorkspaceSnapshot {
    const confirmed = this.confirmedControl;
    if (confirmed && (confirmed.revision > snapshot.control.revision || confirmed.revision === snapshot.control.revision && confirmed.updatedAt > snapshot.control.updatedAt)) return { ...snapshot, control: confirmed };
    this.confirmedControl = snapshot.control;
    return snapshot;
  }
  setControl(control: ComputerWorkspaceSnapshot["control"]) {
    if (this.confirmedControl && control.revision < this.confirmedControl.revision) return;
    this.confirmedControl = control;
    if (this.state.snapshot) this.publish({ snapshot: this.withConfirmedControl({ ...this.state.snapshot, control }) });
  }
  loadMore = async () => {
    if (!this.state.nextCursor || this.state.loadingMore) return;
    const generation = this.generation;
    this.publish({ loadingMore: true });
    try {
      const page = await this.client.query("computer.activity.list", { sessionId: this.sessionId, cursor: this.state.nextCursor, limit: 50 });
      if (generation !== this.generation) return;
      this.publish({ actions: merge(this.state.actions, page.items, action => action.id), frames: merge(this.state.frames, page.frames, frame => frame.frameId), nextCursor: page.nextCursor });
    } catch (cause) {
      if (generation === this.generation) this.publish({ error: hostErrorMessage(cause, "无法读取更早动作 / Cannot load earlier actions") });
    } finally { if (generation === this.generation) this.publish({ loadingMore: false }); }
  };
  async getFrame(frameId: string) {
    return this.state.frames.find(frame => frame.frameId === frameId) ?? await this.client.query("computer.frame.get", { sessionId: this.sessionId, frameId });
  }
  private async ensureLease() {
    if (!this.listeners.size) throw new Error("观察面板已隐藏 / Computer panel is hidden");
    if (this.lease && this.lease.expiresAt > Date.now()) return this.lease;
    if (this.leasePromise) return this.leasePromise;
    if (this.lease) this.closeLease();
    const generation = this.leaseGeneration;
    const task = computerCommand(this.client, "computer.observe.open", { sessionId: this.sessionId, consumerId: `renderer:${crypto.randomUUID()}` }).then(lease => {
      if (generation !== this.leaseGeneration || !this.listeners.size) {
        void computerCommand(this.client, "computer.observe.close", { sessionId: this.sessionId, leaseId: lease.leaseId }).catch(() => {});
        throw new Error("观察范围已改变 / Observation scope changed");
      }
      this.lease = lease; return lease;
    }).finally(() => { if (generation === this.leaseGeneration) this.leasePromise = undefined; });
    this.leasePromise = task;
    return task;
  }
  private closeLease() {
    this.leaseGeneration++;
    const lease = this.lease;
    this.lease = undefined; this.leasePromise = undefined; this.captures.clear();
    if (lease) void computerCommand(this.client, "computer.observe.close", { sessionId: this.sessionId, leaseId: lease.leaseId }).catch(() => {});
  }
  stopObserving() {
    for (const observer of this.observations.values()) { observer.stopped = true; clearTimeout(observer.timer); }
    this.observations.clear(); this.closeLease();
  }
  capture(targetId: string): Promise<ComputerFrame> {
    const existing = this.captures.get(targetId);
    if (existing) return existing;
    const generation = this.generation;
    let leaseGeneration = this.leaseGeneration;
    const task = this.ensureLease().then(lease => {
      leaseGeneration = this.leaseGeneration;
      const screen = this.state.snapshot?.screen;
      if (!this.listeners.size || screen?.locked || screen?.asleep || lease.expiresAt <= Date.now()) throw new Error("屏幕锁定、休眠或观察已结束 / Screen locked, asleep, or observation ended");
      return computerCommand(this.client, "computer.frame.capture", { sessionId: this.sessionId, leaseId: lease.leaseId, targetId });
    }).then(frame => {
      if (generation !== this.generation || leaseGeneration !== this.leaseGeneration) throw new Error("观察范围已改变 / Observation scope changed");
      this.recordFrame(frame); return frame;
    }).finally(() => { if (this.captures.get(targetId) === task) this.captures.delete(targetId); });
    this.captures.set(targetId, task);
    return task;
  }
  async structure(targetId: string) {
    const lease = await this.ensureLease();
    return this.client.query("computer.structure.get", { sessionId: this.sessionId, leaseId: lease.leaseId, targetId });
  }
  observe(targetId: string, listener: (value: ObservationUpdate) => void) {
    let observer = this.observations.get(targetId);
    if (!observer) {
      observer = { listeners: new Set(), idleSince: Date.now(), stopped: false };
      this.observations.set(targetId, observer);
      const value = observer;
      const tick = async () => {
        if (value.stopped) return;
        const snapshot = this.state.snapshot;
        if (snapshot?.screen.locked || snapshot?.screen.asleep || !snapshot?.targets.some(target => target.id === targetId)) {
          for (const notify of value.listeners) notify({ paused: true });
          return;
        }
        const active = snapshot.active.length > 0;
        if (active) value.idleSince = Date.now();
        if (!active && Date.now() - value.idleSince >= 30000) {
          for (const notify of value.listeners) notify({ paused: true });
          return;
        }
        try {
          const frame = await this.capture(targetId);
          if (!value.stopped) for (const notify of value.listeners) notify({ frame });
        } catch (cause) {
          if (!value.stopped) for (const notify of value.listeners) notify({ error: hostErrorMessage(cause, "自动观察已暂停 / Automatic observation paused"), paused: true });
          return;
        }
        if (!value.stopped) value.timer = setTimeout(() => void tick(), active ? 2000 : 5000);
      };
      // Defer until the first consumer has joined, and coalesce same-turn surfaces.
      value.timer = setTimeout(() => void tick(), 0);
    }
    observer.listeners.add(listener);
    const value = observer;
    return () => {
      value.listeners.delete(listener);
      if (!value.listeners.size) { value.stopped = true; clearTimeout(value.timer); this.observations.delete(targetId); }
      if (!this.observations.size) this.closeLease();
    };
  }
}
const sources = new WeakMap<StudioClient, Map<string, ComputerWorkspaceSource>>();
export function computerWorkspaceSource(client: StudioClient, sessionId: string, scopeKey: string) {
  let entries = sources.get(client);
  if (!entries) { entries = new Map(); sources.set(client, entries); }
  const key = JSON.stringify([scopeKey, sessionId]);
  let source = entries.get(key);
  if (!source) {
    source = new ComputerWorkspaceSource(client, sessionId, scopeKey); entries.set(key, source);
    // Scope switches must not retain unbounded historical metadata.
    if (entries.size > 12) entries.delete(entries.keys().next().value!);
  }
  return source;
}
