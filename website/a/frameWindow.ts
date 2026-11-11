export type FrameResource = { close(): void };

export type FrameWindow<T extends FrameResource> = {
  setTarget(index: number): void;
  setActive(active: boolean): void;
  nearest(index: number): { index: number; frame: T } | undefined;
  dispose(): void;
};

/** Keep decoded frames near the scrub position; release images that have left it. */
export function createFrameWindow<T extends FrameResource>({
  count,
  load,
  onReady,
  radius = 6,
  concurrency = 3,
}: {
  count: number;
  load: (index: number, signal: AbortSignal) => Promise<T>;
  onReady: () => void;
  radius?: number;
  concurrency?: number;
}): FrameWindow<T> {
  const frames = new Map<number, T>();
  const pending = new Map<number, AbortController>();
  const failed = new Set<number>();
  let target = 0;
  let active = false;
  let disposed = false;

  const wanted = (): number[] => {
    const indices = [target];
    for (let distance = 1; distance <= radius; distance += 1) {
      if (target + distance < count) indices.push(target + distance);
      if (target - distance >= 0) indices.push(target - distance);
    }
    return indices;
  };
  const pump = () => {
    if (!active || disposed) return;
    const indices = wanted();
    while (pending.size < concurrency) {
      const index = indices.find(id => !frames.has(id) && !pending.has(id) && !failed.has(id));
      if (index === undefined) return;
      const controller = new AbortController();
      pending.set(index, controller);
      void load(index, controller.signal).then(frame => {
        if (controller.signal.aborted || disposed || !active || Math.abs(index - target) > radius) {
          frame.close();
          return;
        }
        frames.set(index, frame);
        onReady();
      }, () => {
        if (!controller.signal.aborted) failed.add(index);
      }).finally(() => {
        pending.delete(index);
        pump();
      });
    }
  };

  return {
    setTarget(index) {
      if (disposed || target === index) return;
      target = index;
      for (const [id, frame] of frames) if (Math.abs(id - target) > radius) { frame.close(); frames.delete(id); }
      for (const [id, controller] of pending) if (Math.abs(id - target) > radius) controller.abort();
      for (const id of failed) if (Math.abs(id - target) > radius) failed.delete(id);
      pump();
    },
    setActive(next) {
      if (disposed || active === next) return;
      active = next;
      if (active) { pump(); return; }
      for (const frame of frames.values()) frame.close();
      frames.clear();
      failed.clear();
      for (const controller of pending.values()) controller.abort();
    },
    nearest(index) {
      let nearest: { index: number; frame: T } | undefined;
      for (const [id, frame] of frames) if (nearest === undefined || Math.abs(id - index) < Math.abs(nearest.index - index)) nearest = { index: id, frame };
      return nearest;
    },
    dispose() {
      if (disposed) return;
      for (const frame of frames.values()) frame.close();
      frames.clear();
      for (const controller of pending.values()) controller.abort();
      failed.clear();
      active = false;
      disposed = true;
    },
  };
}
