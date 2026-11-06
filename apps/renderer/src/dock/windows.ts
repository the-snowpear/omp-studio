import type { DockPinMode, DockRect } from "./types";
import { WindowFocusStore } from "./windowOrder";
import { snapCells, snapCellCount, snapSurfaceSize, snapTree, WINDOW_MINIMUM, type WindowSnapLayout, type WindowSnapTarget, type SnapNode, type WindowMinimums } from "./snap";

export type WindowContent = { kind: "conversation"; documentId: string } | { kind: "tools"; documentId: string; groupId: string };
export type WorkbenchWindow = {
  id: string; content: WindowContent; placement: "main" | "float" | "native" | "docked";
  rect: DockRect; nativeRect?: DockRect; minimized: boolean; maximized: boolean; pin: DockPinMode;
  minimum: { width: number; height: number }; title: string;
  restoreSnap?: { template: WindowSnapLayout["template"]; cell: number } | undefined;
};
export type WindowLayout = { records: WorkbenchWindow[]; snap: WindowSnapLayout | null; assist: number | null };
export const toolWindowId = (owner: string, group: string) => `tool:${owner}:${group}`;
export const focusWindowId = (record: WorkbenchWindow) => record.content.kind === "conversation" ? `conversation:${record.id}` : record.id;

export class WorkbenchWindows {
  readonly focus = new WindowFocusStore();
  private state: WindowLayout = { records: [], snap: null, assist: null };
  private listeners = new Set<() => void>();
  private depth = 0;
  private pending = false;
  geometry = { workbench: { x: 0, y: 0, width: 1280, height: 900 }, canvas: { x: 0, y: 0, width: 1280, height: 900 } };
  visible: (record: WorkbenchWindow) => boolean = record => !record.minimized;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get(id: string) { return this.state.records.find(record => record.id === id); }
  mainConversation(exceptId: string) { return this.state.records.find(record => record.placement === "main" && record.id !== exceptId && this.visible(record)); }
  private publish(state: WindowLayout) { this.state = state; this.pending = true; if (!this.depth) this.notify(); }
  private notify() { if (!this.pending) return; this.pending = false; for (const listener of this.listeners) listener(); }
  transaction(action: () => void) { this.depth++; try { action(); } finally { if (!--this.depth) this.notify(); } }
  restore(state: WindowLayout) { this.publish(state); }
  register(record: WorkbenchWindow) {
    if (this.get(record.id)) return;
    this.publish({ ...this.state, records: [...this.state.records, record] });
  }
  patch(id: string, patch: Partial<WorkbenchWindow>) {
    const record = this.get(id);
    if (!record || Object.entries(patch).every(([key, value]) => JSON.stringify(record[key as keyof WorkbenchWindow]) === JSON.stringify(value))) return;
    this.publish({ ...this.state, records: this.state.records.map(value => value.id === id ? { ...value, ...patch } : value) });
  }
  remove(id: string) {
    const record = this.get(id);
    if (!record) return;
    this.publish({ ...this.state, records: this.state.records.filter(value => value.id !== id), snap: this.withoutMember(id), assist: null });
    this.focus.forget(focusWindowId(record));
  }
  cell(id: string) { const entry = Object.entries(this.state.snap?.members ?? {}).find(([, member]) => member === id); return entry ? Number(entry[0]) : undefined; }
  private withoutMember(id: string) { return this.state.snap ? { ...this.state.snap, members: Object.fromEntries(Object.entries(this.state.snap.members).filter(([, member]) => member !== id)) } : null; }
  activate(id: string) {
    const record = this.get(id);
    if (!record) return;
    if (record.minimized) {
      const restore = record.restoreSnap, snap = this.state.snap;
      this.transaction(() => {
        if (restore && snap?.template === restore.template && !snap.members[restore.cell]) this.publish({ ...this.state, snap: { ...snap, members: { ...snap.members, [restore.cell]: id } } });
        this.patch(id, { minimized: false, restoreSnap: undefined });
      });
    }
    this.focus.activate(focusWindowId(record), record.content.documentId);
  }
  float(id: string, rect?: DockRect, native = false) {
    this.transaction(() => {
      this.publish({ ...this.state, snap: this.withoutMember(id), assist: null });
      this.patch(id, { placement: native ? "native" : "float", maximized: false, minimized: false, restoreSnap: undefined, ...(rect ? { rect } : {}) });
    });
  }
  dock(id: string) {
    if (this.get(id)?.placement === "docked") return;
    this.transaction(() => {
      this.publish({ ...this.state, snap: this.withoutMember(id), assist: null });
      this.patch(id, { placement: "docked", minimized: false, maximized: false, pin: "none", restoreSnap: undefined });
    });
  }
  setPin(id: string, pin: DockPinMode) {
    const record = this.get(id);
    if (!record || record.pin === pin) return;
    const native = pin === "window" || pin === "topmost";
    const wasNative = record.placement === "native";
    this.transaction(() => {
      if (native && !wasNative) {
        const cell = this.cell(id), snap = this.state.snap;
        this.patch(id, { placement: "native", ...(cell !== undefined && snap ? { restoreSnap: { template: snap.template, cell } } : {}) });
        this.publish({ ...this.state, snap: this.withoutMember(id), assist: null });
      } else if (wasNative && !native) {
        const restore = record.restoreSnap, snap = this.state.snap;
        this.patch(id, { placement: "float", ...(record.minimized ? {} : { restoreSnap: undefined }) });
        if (!record.minimized && restore && snap?.template === restore.template && !snap.members[restore.cell]) this.publish({ ...this.state, snap: { ...snap, members: { ...snap.members, [restore.cell]: id } } });
      }
      this.patch(id, { pin });
    });
  }
  minimize(id: string) {
    const record = this.get(id), cell = this.cell(id), snap = this.state.snap;
    if (!record) return;
    this.transaction(() => {
      this.patch(id, { minimized: true, ...(cell !== undefined && snap ? { restoreSnap: { template: snap.template, cell } } : {}) });
      this.publish({ ...this.state, snap: this.withoutMember(id), assist: null });
    });
    this.focus.forget(focusWindowId(record));
  }
  maximize(id: string) {
    const record = this.get(id);
    if (!record) return;
    const visible = this.state.records.filter(value => value.placement !== "native" && value.placement !== "docked" && this.visible(value));
    if (record.content.kind === "conversation" && record.placement !== "native" && visible.length === 1) {
      this.transaction(() => { this.publish({ ...this.state, snap: this.withoutMember(id), assist: null }); this.patch(id, { placement: "main", pin: "none", maximized: false, minimized: false, restoreSnap: undefined }); });
    } else this.patch(id, { maximized: !record.maximized });
    this.activate(id);
  }
  minimums(layout = this.state.snap): WindowMinimums {
    return Object.fromEntries(Object.entries(layout?.members ?? {}).map(([cell, id]) => [cell, this.get(id)?.minimum ?? WINDOW_MINIMUM]));
  }
  size(layout = this.state.snap) { return layout ? snapSurfaceSize(layout.template, layout.tree, this.geometry.canvas, this.minimums(layout)) : this.geometry.canvas; }
  project(id: string, target: Exclude<WindowSnapTarget, { maximize: true }>): WindowLayout {
    const previous = this.state.snap;
    const same = previous?.template === target.template;
    let tree = same ? previous.tree : snapTree(target.template);
    const members: Record<number, string> = same ? { ...previous.members } : {};
    for (const [cell, member] of Object.entries(members)) if (member === id) delete members[Number(cell)];
    if (!same && previous) {
      const changedSide = target.splitSide ?? target.fullHeightSide;
      if (changedSide && "children" in previous.tree && "children" in tree) {
        tree = { ...tree, ratio: previous.tree.ratio };
        const preservedSide = changedSide === "left" ? 1 : 0;
        const before = previous.tree.children[preservedSide]!, after = tree.children[preservedSide]!;
        if ("ratio" in before && "ratio" in after) tree.children = tree.children.map((child, index) => index === preservedSide ? { ...after, ratio: before.ratio } : child) as [SnapNode, SnapNode];
        const oldCells = snapCells(previous.template, previous.tree, { width: 1000, height: 1000 });
        const newCells = snapCells(target.template, tree, { width: 1000, height: 1000 });
        for (const [oldCell, member] of Object.entries(previous.members)) {
          if (member === id) continue;
          const area = oldCells[Number(oldCell)]!;
          const available = newCells.map((rect, cell) => ({ cell, overlap: Math.max(0, Math.min(area.x + area.width, rect.x + rect.width) - Math.max(area.x, rect.x)) * Math.max(0, Math.min(area.y + area.height, rect.y + rect.height) - Math.max(area.y, rect.y)) })).filter(value => value.overlap > 0 && value.cell !== target.cell && !members[value.cell]).sort((first, second) => second.overlap - first.overlap);
          if (available[0]) members[available[0].cell] = member;
        }
      } else {
        const available = Array.from({ length: snapCellCount(target.template) }, (_, cell) => cell).filter(cell => cell !== target.cell);
        Object.values(previous.members).filter(member => member !== id).forEach((member, index) => { if (available[index] !== undefined) members[available[index]!] = member; });
      }
    }
    members[target.cell] = id;
    const main = this.mainConversation(id);
    if (main && !Object.values(members).includes(main.id)) {
      const cells = snapCells(target.template, tree, this.geometry.canvas), source = cells[target.cell]!;
      const opposite = (rect: DockRect) => (rect.x + rect.width / 2 < this.geometry.canvas.width / 2) !== (source.x + source.width / 2 < this.geometry.canvas.width / 2) ? 1 : 0;
      const empty = cells.map((rect, cell) => ({ rect, cell })).filter(value => !members[value.cell]).sort((first, second) => second.rect.width * second.rect.height - first.rect.width * first.rect.height || opposite(second.rect) - opposite(first.rect) || first.rect.y - second.rect.y || first.rect.x - second.rect.x);
      if (empty[0]) members[empty[0].cell] = main.id;
    }
    const records = this.state.records.map(record => Object.values(members).includes(record.id) ? { ...record, placement: "float" as const, minimized: false, maximized: false, restoreSnap: undefined } : record);
    const empty = Array.from({ length: snapCellCount(target.template) }, (_, cell) => cell).find(cell => !members[cell]);
    const candidates = records.some(record => record.placement !== "native" && !Object.values(members).includes(record.id));
    return { records, snap: { template: target.template, tree, members }, assist: candidates && empty !== undefined ? empty : null };
  }
  snap(id: string, target: Exclude<WindowSnapTarget, { maximize: true }>) {
    if (!this.get(id) || this.get(id)?.placement === "native") return;
    this.publish(this.project(id, target));
    this.activate(id);
  }
  resize(tree: SnapNode) { if (this.state.snap) this.publish({ ...this.state, snap: { ...this.state.snap, tree } }); }
  dismissAssist() { if (this.state.assist !== null) this.publish({ ...this.state, assist: null }); }
}
