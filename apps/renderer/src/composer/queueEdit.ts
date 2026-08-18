import { snapshotFromText, snapshotIsEmpty } from "./serialize";
import type { ComposerDoc, ComposerSnapshot, PromptImage } from "./types";

/** Local queue row that can round-trip through Composer. */
export type EditableQueued = {
  readonly id: number;
  readonly text: string;
  readonly images?: ReadonlyArray<PromptImage>;
  readonly doc?: ComposerDoc;
  readonly sessionId?: string;
};

export type QueueEditState = {
  readonly entryId: number;
  readonly stashed: ComposerSnapshot;
};

export type QueueEditResult<T extends EditableQueued> = {
  readonly queue: readonly T[];
  readonly editing: QueueEditState | undefined;
  readonly composer: ComposerSnapshot;
};

export function snapshotOfQueued(entry: EditableQueued): ComposerSnapshot {
  return entry.doc
    ? { text: entry.text, images: entry.images ?? [], doc: entry.doc }
    : snapshotFromText(entry.text);
}

function patchQueuedEntry<T extends EditableQueued>(entry: T, snapshot: ComposerSnapshot): T {
  const next: EditableQueued = {
    id: entry.id,
    text: snapshot.text,
    doc: snapshot.doc,
    ...(snapshot.images.length > 0 ? { images: snapshot.images } : {}),
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
  };
  return next as T;
}

function replaceQueuedAtId<T extends EditableQueued>(
  queue: readonly T[],
  id: number,
  snapshot: ComposerSnapshot,
): T[] {
  return queue.map((entry) => (entry.id === id ? patchQueuedEntry(entry, snapshot) : entry));
}

export function beginQueueEdit<T extends EditableQueued>(input: {
  readonly queue: readonly T[];
  readonly composer: ComposerSnapshot;
  readonly entry: T;
}): QueueEditResult<T> {
  return {
    queue: input.queue,
    editing: { entryId: input.entry.id, stashed: input.composer },
    composer: snapshotOfQueued(input.entry),
  };
}

/** Write the in-progress composer into the previous row; keep the same stash. */
export function switchQueueEdit<T extends EditableQueued>(input: {
  readonly queue: readonly T[];
  readonly editing: QueueEditState;
  readonly composer: ComposerSnapshot;
  readonly entry: T;
}): QueueEditResult<T> {
  const queue = snapshotIsEmpty(input.composer)
    ? input.queue.filter((item) => item.id !== input.editing.entryId)
    : replaceQueuedAtId(input.queue, input.editing.entryId, input.composer);
  return {
    queue,
    editing: { entryId: input.entry.id, stashed: input.editing.stashed },
    composer: snapshotOfQueued(input.entry),
  };
}

export function commitQueueEdit<T extends EditableQueued>(input: {
  readonly queue: readonly T[];
  readonly editing: QueueEditState;
  readonly composer: ComposerSnapshot;
}): QueueEditResult<T> {
  const queue = snapshotIsEmpty(input.composer)
    ? input.queue.filter((item) => item.id !== input.editing.entryId)
    : replaceQueuedAtId(input.queue, input.editing.entryId, input.composer);
  return {
    queue,
    editing: undefined,
    composer: input.editing.stashed,
  };
}

export function cancelQueueEdit<T extends EditableQueued>(input: {
  readonly queue: readonly T[];
  readonly editing: QueueEditState;
}): QueueEditResult<T> {
  return {
    queue: input.queue,
    editing: undefined,
    composer: input.editing.stashed,
  };
}

/**
 * Session or preview switch: write a non-empty in-progress snapshot back
 * (never delete the row) and restore the stashed composer draft.
 */
export function parkQueueEdit<T extends EditableQueued>(input: {
  readonly queue: readonly T[];
  readonly editing: QueueEditState;
  readonly composer: ComposerSnapshot;
}): QueueEditResult<T> {
  const queue = snapshotIsEmpty(input.composer)
    ? input.queue
    : replaceQueuedAtId(input.queue, input.editing.entryId, input.composer);
  return {
    queue,
    editing: undefined,
    composer: input.editing.stashed,
  };
}
