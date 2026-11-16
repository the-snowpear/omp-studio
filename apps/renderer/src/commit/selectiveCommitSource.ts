import type { StudioClient } from "@omp-studio/client-contract";
import type {
  SelectiveCommitBodyTarget,
  SelectiveCommitDraft,
  SelectiveCommitMessage,
  SelectiveCommitOptions,
  SelectiveCommitOutcome,
  SelectiveCommitPreview,
  SelectiveCommitRead,
  SelectiveCommitSelection,
} from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";
import {
  createPreviewCommitDraft,
  previewCommitOutcome,
  previewCommitPreview,
  previewCommitRead,
  selectPreviewCommitDraft,
} from "../preview/selectiveCommitPreview";

/** The panel's only door to selective commit; the real one never reshapes Runtime results. */
export interface SelectiveCommitSource {
  prepare(scope?: string | readonly string[]): Promise<SelectiveCommitDraft>;
  read(draft: SelectiveCommitDraft, body?: SelectiveCommitBodyTarget): Promise<SelectiveCommitRead>;
  open(draftId: string, revision: number): Promise<SelectiveCommitDraft>;
  select(draft: SelectiveCommitDraft, selection: SelectiveCommitSelection): Promise<SelectiveCommitDraft>;
  preview(draft: SelectiveCommitDraft): Promise<SelectiveCommitPreview>;
  execute(draft: SelectiveCommitDraft, preview: SelectiveCommitPreview, message: SelectiveCommitMessage, options?: SelectiveCommitOptions): Promise<SelectiveCommitOutcome>;
  release(draftId: string): void;
}

/** Hooks can run for a while; the native side owns the real deadline. */
const EXECUTE_TIMEOUT_MS = 10 * 60_000;

export function realCommitSource(client: StudioClient, sessionId: string): SelectiveCommitSource {
  return {
    prepare: scope => client.query("commit.draft.prepare", { sessionId, ...(scope?.length ? { scope: typeof scope === "string" ? scope : [...scope] } : {}) }),
    read: (draft, body) => client.query("commit.draft.read", { sessionId, draftId: draft.view.id, revision: draft.view.revision, ...(body ? { body } : {}) }),
    open: async (draftId, revision) => (await client.query("commit.draft.read", { sessionId, draftId, revision })).draft,
    async select(draft, selection) {
      const handle = await client.command("commit.draft.select", { sessionId, draftId: draft.view.id, revision: draft.view.revision, selection });
      return (await waitReceipt<{ result: SelectiveCommitDraft }>(client, handle.requestId)).result;
    },
    preview: draft => client.query("commit.draft.preview", { sessionId, draftId: draft.view.id, revision: draft.view.revision }),
    async execute(draft, preview, message, options) {
      const handle = await client.command("commit.draft.execute", {
        sessionId, draftId: draft.view.id, revision: draft.view.revision, previewId: preview.previewId, message,
        ...(options && (options.amend || options.noVerify) ? { options } : {}),
      });
      return (await waitReceipt<{ result: SelectiveCommitOutcome }>(client, handle.requestId, EXECUTE_TIMEOUT_MS)).result;
    },
    release(draftId) { void client.query("commit.draft.release", { sessionId, draftId }).catch(() => undefined); },
  };
}

/** Demo source: local fixture moves only, no Host call. */
export function previewCommitSource(): SelectiveCommitSource {
  let current = createPreviewCommitDraft();
  const settle = <T,>(value: T) => new Promise<T>(resolve => window.setTimeout(() => resolve(value), 160));
  return {
    prepare: () => { current = createPreviewCommitDraft(); return settle(current); },
    read: (draft, body) => settle(body ? previewCommitRead(draft, body) : { draft }),
    open: () => settle(current),
    select: (draft, selection) => { current = selectPreviewCommitDraft(draft, selection); return settle(current); },
    preview: draft => settle(previewCommitPreview(draft)),
    execute: (draft, preview, message) => {
      current = { ...draft, view: { ...draft.view, state: "consumed" } };
      return settle(previewCommitOutcome(preview, message.subject));
    },
    release: () => undefined,
  };
}
