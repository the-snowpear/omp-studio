import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { Generation } from "@omp-studio/studio-protocol";
import {
  canFlushQueuedMessage,
  composerFollowUpEnabled,
  composerPromptEnabled,
  composerQueueEnabled,
} from "../composer/dispatch";
import {
  beginQueueEdit,
  cancelQueueEdit,
  commitQueueEdit,
  snapshotOfQueued,
  switchQueueEdit,
  type QueueEditState,
} from "../composer/queueEdit";
import { snapshotIsEmpty } from "../composer/serialize";
import { emptySnapshot, type ComposerSnapshot, type PromptImage } from "../composer/types";
import type { ChipComposerHandle } from "../composer/ChipComposer";
import type { QueuedMessage } from "../MessageQueueBar";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { subagentComposerText, type SubagentComposerAgent } from "./subagentComposerGate";
import { createSubagentViewState, useSubagentViewField, type SubagentViewState } from "./subagentViewState";

export type SubagentComposerClient = Pick<StudioClient, "command" | "subscribe">;

function queueEntryOf(payload: ComposerSnapshot, id: number, sessionId: string): QueuedMessage {
  return {
    id,
    text: payload.text,
    doc: payload.doc,
    sessionId,
    ...(payload.images.length > 0 ? { images: payload.images } : {}),
  };
}

export function useSubagentComposer(input: {
  readonly enabled: boolean;
  readonly preview?: boolean;
  readonly running: boolean;
  readonly pendingInteraction?: boolean;
  readonly client: SubagentComposerClient | null;
  readonly agent: SubagentComposerAgent | undefined;
  readonly sessionId: string | undefined;
  readonly viewState?: SubagentViewState;
}) {
  const composerRef = useRef<ChipComposerHandle | null>(null);
  const [localState] = useState(createSubagentViewState);
  const viewState = input.viewState ?? localState;
  const [draft, setDraft] = useSubagentViewField(viewState, "draft");
  const [queued, setQueued] = useSubagentViewField(viewState, "queued");
  const [queueEdit, setQueueEdit] = useSubagentViewField(viewState, "queueEdit");
  const [sending, setSending] = useState(false);
  const [error, setError] = useSubagentViewField(viewState, "error");
  const flushBusyRef = useRef(false);
  const [flushTick, setFlushTick] = useState(0);

  const queueKey = input.sessionId;
  const preview = input.preview === true;
  const pendingInteraction = input.pendingInteraction === true;
  const channelReady = input.enabled && input.agent !== undefined && !sending && (preview || input.client !== null);
  const textReady = !snapshotIsEmpty(draft);
  const promptEnabled = composerPromptEnabled({
    textReady,
    running: input.running,
    pendingInteraction,
    promptChannelReady: channelReady,
  });
  const queueEnabled = composerQueueEnabled({
    textReady,
    running: input.running,
    promptChannelReady: channelReady,
  });
  const followUpEnabled = composerFollowUpEnabled({
    textReady,
    running: input.running,
    pendingInteraction,
    followUpChannelReady: channelReady,
  });
  const steerEnabled = channelReady;

  const takeSnapshot = () => composerRef.current?.getSnapshot() ?? draft;

  const deliver = useCallback(async (
    mode: "prompt" | "steer" | "followUp",
    text: string,
    images?: readonly PromptImage[],
  ): Promise<boolean> => {
    if (!input.enabled) return false;
    if (input.preview === true) return true;
    const client = input.client;
    const agent = input.agent;
    if (client === null || agent === undefined || agent.generation === undefined) return false;
    setSending(true);
    setError(undefined);
    try {
      const handle = await client.command("agent.send", {
        agentId: agent.agentId,
        expectedGeneration: agent.generation as Generation,
        text,
        mode,
        ...(images !== undefined && images.length > 0 ? { images: [...images] } : {}),
      });
      await waitReceipt(client as StudioClient, handle.requestId);
      return true;
    } catch (cause) {
      setError(hostErrorMessage(cause, "发送给子 Agent 失败"));
      return false;
    } finally {
      setSending(false);
    }
  }, [input.agent, input.client, input.preview, input.enabled, setError]);

  const sendSnapshot = useCallback(async (payload: ComposerSnapshot, mode: "prompt" | "steer" | "followUp"): Promise<boolean> => {
    const parsed = subagentComposerText(payload);
    if (parsed.kind === "empty") return false;
    return deliver(mode, parsed.text, parsed.images);
  }, [deliver]);

  const clearDraft = () => {
    composerRef.current?.clear();
    setDraft(emptySnapshot());
  };

  const submitPrompt = () => {
    if (queueEdit !== undefined) {
      const result = commitQueueEdit({ queue: queued, editing: queueEdit, composer: takeSnapshot() });
      setQueued([...result.queue]);
      setQueueEdit(undefined);
      composerRef.current?.setSnapshot(result.composer);
      setDraft(result.composer);
      return;
    }
    if (!promptEnabled) return;
    const payload = takeSnapshot();
    void sendSnapshot(payload, "prompt").then((ok) => {
      if (ok) clearDraft();
    });
  };

  const submitFollowUp = () => {
    if (queueEdit !== undefined) {
      const result = commitQueueEdit({ queue: queued, editing: queueEdit, composer: takeSnapshot() });
      setQueued([...result.queue]);
      setQueueEdit(undefined);
      composerRef.current?.setSnapshot(result.composer);
      setDraft(result.composer);
      return;
    }
    if (!followUpEnabled) return;
    const payload = takeSnapshot();
    void sendSnapshot(payload, "followUp").then((ok) => {
      if (ok) clearDraft();
    });
  };

  const enqueueDraft = () => {
    if (queueEdit !== undefined) {
      const result = commitQueueEdit({ queue: queued, editing: queueEdit, composer: takeSnapshot() });
      setQueued([...result.queue]);
      setQueueEdit(undefined);
      composerRef.current?.setSnapshot(result.composer);
      setDraft(result.composer);
      return;
    }
    const payload = takeSnapshot();
    if (snapshotIsEmpty(payload) || subagentComposerText(payload).kind === "empty") return;
    if (!channelReady || !input.running || queueKey === undefined) return;
    viewState.nextQueueId += 1;
    setQueued((queue) => [...queue, { ...queueEntryOf(payload, viewState.nextQueueId, queueKey),
      ...(input.agent?.generation === undefined ? {} : { agentGeneration: input.agent.generation }) }]);
    clearDraft();
    setError(undefined);
  };

  const applyQueueEdit = (result: { queue: readonly QueuedMessage[]; editing: QueueEditState | undefined; composer: ComposerSnapshot }) => {
    setQueued([...result.queue]);
    setQueueEdit(result.editing);
    composerRef.current?.setSnapshot(result.composer);
    setDraft(result.composer);
  };

  const editQueued = (entry: QueuedMessage) => {
    const composer = takeSnapshot();
    if (queueEdit?.entryId === entry.id) {
      composerRef.current?.focus();
      return;
    }
    applyQueueEdit(
      queueEdit === undefined
        ? beginQueueEdit({ queue: queued, composer, entry })
        : switchQueueEdit({ queue: queued, editing: queueEdit, composer, entry }),
    );
    composerRef.current?.focus();
  };

  const cancelEdit = () => {
    if (queueEdit === undefined) return;
    applyQueueEdit(cancelQueueEdit({ queue: queued, editing: queueEdit }));
    composerRef.current?.focus();
  };

  const removeQueued = (entry: QueuedMessage) => {
    if (queueEdit?.entryId === entry.id) {
      applyQueueEdit(cancelQueueEdit({ queue: queued, editing: queueEdit }));
    }
    setQueued((queue) => queue.filter((item) => item.id !== entry.id));
  };

  const sendQueuedNow = (entry: QueuedMessage) => {
    let target = entry;
    if (queueEdit?.entryId === entry.id) {
      const result = commitQueueEdit({ queue: queued, editing: queueEdit, composer: takeSnapshot() });
      applyQueueEdit(result);
      const updated = result.queue.find((item) => item.id === entry.id);
      if (updated === undefined) return;
      target = updated;
    }
    if (sending) return;
    const mode = input.running ? "steer" : "prompt";
    if (input.running && !steerEnabled) return;
    if (!input.running && !channelReady) return;
    setQueued((queue) => queue.filter((item) => item.id !== target.id));
    void sendSnapshot(snapshotOfQueued(target), mode).then((ok) => {
      if (!ok) setQueued((queue) => [{ ...target }, ...queue]);
    });
  };

  // Restore only when the editor is mounted, never overwrite typing on status updates.
  useLayoutEffect(() => {
    const editor = composerRef.current;
    editor?.setSnapshot(viewState.draft, { preserveFocus: true });
    return () => { if (editor) viewState.draft = editor.getSnapshot(); };
  }, [viewState, input.enabled]);

  useEffect(() => {
    if (queueKey === undefined || flushBusyRef.current || sending) return;
    const head = queued[0];
    if (head === undefined) return;
    // A revived/replaced instance must not inherit automatic sends from its predecessor.
    if (head.sessionId !== queueKey || head.agentGeneration !== input.agent?.generation) return;
    if (
      !canFlushQueuedMessage({
        running: input.running,
        pendingInteraction,
        promptChannelReady: channelReady,
        entryId: head.id,
        ...(queueEdit === undefined ? {} : { pausedEntryId: queueEdit.entryId }),
        selectedSessionId: queueKey,
        liveSessionId: queueKey,
        ...(head.sessionId === undefined ? {} : { entrySessionId: head.sessionId }),
      })
    ) {
      return;
    }
    flushBusyRef.current = true;
    setQueued((queue) => queue.filter((item) => item.id !== head.id));
    void sendSnapshot(snapshotOfQueued(head), "prompt").then((ok) => {
      if (!ok) setQueued((queue) => [{ ...head }, ...queue]);
      flushBusyRef.current = false;
      setFlushTick((tick) => tick + 1);
    });
  }, [channelReady, input.running, input.agent?.generation, pendingInteraction, queueEdit, queueKey, queued, sendSnapshot, sending, flushTick, setQueued]);

  const rejectSlash = useCallback(() => {
    setError("子 Agent 不支持斜杠指令");
  }, []);

  return {
    composerRef,
    draft,
    setDraft,
    queued,
    staleQueue: queued.some(entry => entry.sessionId !== queueKey || entry.agentGeneration !== input.agent?.generation),
    queueEdit,
    error,
    running: input.running,
    promptEnabled,
    queueEnabled,
    followUpEnabled,
    steerEnabled,
    submitPrompt,
    submitFollowUp,
    enqueueDraft,
    editQueued,
    cancelEdit,
    removeQueued,
    sendQueuedNow,
    rejectSlash,
    setError,
  };
}
