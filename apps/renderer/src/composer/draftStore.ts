/**
 * Per-session composer drafts, deliberately kept OUT of React state.
 *
 * A keystroke used to publish the whole draft snapshot through AppShell state
 * (`setComposerDraftsBySession`), which re-rendered the ~7k-line shell on every
 * character. The draft record is only ever *read* at a restore boundary — mount,
 * conversation switch, target switch — so it does not need to be reactive at all:
 * writing into this book is a plain Map write with no render.
 *
 * Snapshot objects are immutable, so the stored identity is the draft identity.
 * `snapshotIsEmpty` drafts are dropped instead of stored: the restore path treats
 * "missing" and "empty" the same, and dropping keeps the book from growing with
 * one entry per session the operator ever visited.
 */

import { snapshotIsEmpty } from "./serialize";
import type { ComposerSnapshot } from "./types";

export type ComposerDraftBook = {
  /** Latest draft for a composer owner, or `undefined` when there is none. */
  get(owner: string | undefined): ComposerSnapshot | undefined;
  set(owner: string, snapshot: ComposerSnapshot): void;
  /** Number of non-empty drafts kept; for tests and diagnostics. */
  readonly size: number;
};

export function createComposerDraftBook(): ComposerDraftBook {
  const drafts = new Map<string, ComposerSnapshot>();
  return {
    get(owner) {
      return owner === undefined ? undefined : drafts.get(owner);
    },
    set(owner, snapshot) {
      if (snapshotIsEmpty(snapshot)) drafts.delete(owner);
      else drafts.set(owner, snapshot);
    },
    get size() {
      return drafts.size;
    },
  };
}
