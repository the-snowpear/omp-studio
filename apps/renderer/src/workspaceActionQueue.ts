/** Serialize workspace-bound commands so a project switch cannot race a
 * session mutation or creation against the active Runtime. */
export function createSerialTaskQueue() {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
