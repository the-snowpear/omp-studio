import { invokeUpgrade, useUpgradeAvailable } from "../runtimeUpgrade";
import { PREVIEW_BTW_TOPICS, PREVIEW_BTW_TURNS } from "../preview/btwPreview";
import type { BtwTopicSummary, BtwHistoryTurn } from "@omp-studio/client-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BtwAskOutcome,
  BtwBranchOutcome,
  BtwSnapshot,
  CommandName,
  StudioClient,
} from "@omp-studio/client-contract";
import { hostErrorMessage, waitReceipt } from "../hostError";

/** Matches the Runtime `StudioBtwService` question cap. */
export const BTW_QUESTION_MAX_CHARS = 64 * 1024;

export interface BtwSessionInput {
  /** Live snapshot from `clientState.entities.btw`; null before the first ask. */
  readonly snapshot: BtwSnapshot | null;
  readonly client: StudioClient | null;
  /** Preview mode drives fixtures and must never reach the Host. */
  readonly preview: boolean;
  readonly sessionId?: string;
  /** Fixture question shown while previewing; ignored outside preview mode. */
  readonly previewQuestion?: string;
  readonly canCommand: boolean;
  /** After a successful branch, switch the workbench to the new session. */
  readonly onBranched?: (sessionId: string) => void | Promise<void>;
}

export interface BtwSessionApi {
  readonly historyAvailable?: boolean;
  readonly topics?: readonly BtwTopicSummary[];
  readonly turns?: readonly BtwHistoryTurn[];
  readonly selectedTopicId?: string | null;
  selectTopic?(topicId: string): Promise<void>;
  newTopic?(): void;
  refreshHistory?(): Promise<void>;
  readonly snapshot: BtwSnapshot | null;
  /** Question text of the current round, kept locally: snapshots omit it. */
  readonly question: string;
  /** Compose field lives here so docking/undocking does not drop a half-typed ask. */
  readonly draft: string;
  setDraft(text: string): void;
  /** Wall clock of the first `running` sighting for this round; null when idle. */
  readonly startedAt: number | null;
  readonly canAbort: boolean;
  readonly canBranch: boolean;
  /** Why branching is unavailable, for the disabled button's tooltip. */
  readonly branchBlockedReason: string | undefined;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly notice: string | undefined;
  ask(question: string, newTopic?: boolean): Promise<boolean>;
  abort(): Promise<void>;
  branch(): Promise<void>;
  copy(): Promise<void>;
  dismissNotice(): void;
}

/**
 * Data and actions for the BTW side channel.
 *
 * `branchToken` only ever travels on the `btw.ask` receipt, so it has to be
 * cached here; a client that merely observed `btw.changed` cannot branch. The
 * cache is keyed by `ephemeralId` because the Runtime service holds a single
 * slot — a new ask silently replaces the previous answer, and a token minted
 * for the old round must not be reused against the new one.
 */
export function useBtwSession(input: BtwSessionInput): BtwSessionApi {
  const [question, setQuestion] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [branchToken, setBranchToken] = useState<string | null>(null);
  const [tokenEphemeralId, setTokenEphemeralId] = useState<string | null>(null);
  const [branchedId, setBranchedId] = useState<string | null>(null);

  const clientRef = useRef(input.client);
  clientRef.current = input.client;
  const snapshotRef = useRef(input.snapshot);
  snapshotRef.current = input.snapshot;
  const onBranchedRef = useRef(input.onBranched);
  onBranchedRef.current = input.onBranched;
  const pendingRef = useRef(false);

  const historyAvailable = useUpgradeAvailable(input.client, input.preview, "btw.history.list");
  const [topics, setTopics] = useState<readonly BtwTopicSummary[]>([]);
  const [turns, setTurns] = useState<readonly BtwHistoryTurn[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [historySnapshot, setHistorySnapshot] = useState<BtwSnapshot | null>(null);
  const [newTopicDraft, setNewTopicDraft] = useState(false);
  const selectionGeneration = useRef(0);
  const seenRoundRef = useRef<string | null>(null);
  const expectedRoundRef = useRef<string | null>(null);
  const refreshHistory = useCallback(async () => {
    if (input.preview) { setTopics(PREVIEW_BTW_TOPICS); return; }
    if (!input.client || !historyAvailable) return;
    const generation = selectionGeneration.current;
    try {
      const result = await invokeUpgrade(input.client, "btw.history.list", {});
      if (generation === selectionGeneration.current && (!input.sessionId || result.sessionId === input.sessionId)) setTopics(result.topics);
    } catch (cause) { if (generation === selectionGeneration.current) setError(hostErrorMessage(cause, "BTW history unavailable")); }
  }, [input.client, input.preview, input.sessionId, historyAvailable]);
  const selectTopic = useCallback(async (topicId: string) => {
    const generation = ++selectionGeneration.current;
    expectedRoundRef.current = null;
    setSelectedTopicId(topicId); setNewTopicDraft(false); setDraft(""); setBranchToken(null); setTurns([]); setHistorySnapshot(null);
    try {
      const result = input.preview ? { turns: PREVIEW_BTW_TURNS } : input.client ? await invokeUpgrade(input.client, "btw.history.read", { topicId }) : null;
      if (generation !== selectionGeneration.current || !result) return;
      setTurns(result.turns);
      const last = result.turns[result.turns.length - 1];
      if (last) {
        setQuestion(last.question);
        setHistorySnapshot({ ephemeralId: "history:" + topicId, topicId, question: last.question, text: last.answer,
          status: last.status === "complete" ? "completed" : last.status === "running" ? "running" : last.status === "error" ? "failed" : "aborted" });
      }
    } catch (cause) { if (generation === selectionGeneration.current) setError(hostErrorMessage(cause, "BTW history unavailable")); }
  }, [input.client, input.preview]);
  const newTopic = useCallback(() => {
    selectionGeneration.current++;
    expectedRoundRef.current = null;
    seenRoundRef.current = null;
    setSelectedTopicId(null); setHistorySnapshot(null); setTurns([]); setNewTopicDraft(true);
    setQuestion(""); setDraft(""); setBranchToken(null); setTokenEphemeralId(null);
    setStartedAt(null); setBranchedId(null); setError(undefined); setNotice(undefined);
  }, []);
  useEffect(() => {
    newTopic(); setTopics([]); setNewTopicDraft(false); void refreshHistory();
    return () => { selectionGeneration.current++; };
  }, [input.client, input.sessionId, input.preview]);
  useEffect(() => { void refreshHistory(); }, [refreshHistory, input.snapshot?.status]);
  const live = input.snapshot && (!input.sessionId || !input.snapshot.sessionId || input.snapshot.sessionId === input.sessionId) ? input.snapshot : null;
  const snapshot = newTopicDraft ? null : historyAvailable && selectedTopicId && live?.topicId !== selectedTopicId ? historySnapshot : live ?? historySnapshot;
  const roundId = snapshot?.ephemeralId ?? null;

  // A new ephemeralId is a new round: drop the previous token, restart the
  // clock, and clear the stale branch/error banners from the old answer.
  // The ask receipt can land before the first `btw.changed`; do not let that
  // lagging snapshot rewind the clock or drop the freshly minted token.
  useEffect(() => {
    if (expectedRoundRef.current !== null && roundId !== expectedRoundRef.current) {
      return;
    }
    if (seenRoundRef.current === roundId) return;
    seenRoundRef.current = roundId;
    if (roundId === null) {
      expectedRoundRef.current = null;
      setQuestion("");
      setBranchToken(null);
      setTokenEphemeralId(null);
      setStartedAt(null);
    } else if (expectedRoundRef.current !== roundId) {
      setStartedAt(Date.now());
    }
    setBranchedId(null);
    setNotice(undefined);
    setError(undefined);
  }, [roundId]);

  // The token belongs to the round it was minted for.
  const activeToken = tokenEphemeralId !== null && tokenEphemeralId === roundId ? branchToken : null;

  const canAbort = snapshot !== null && snapshot.ephemeralId === live?.ephemeralId && snapshot.status === "running" && !pending;
  const canBranch = snapshot !== null && snapshot.status === "completed" && activeToken !== null && branchedId === null;
  const branchBlockedReason = useMemo(() => {
    if (canBranch) return undefined;
    if (snapshot === null) return "还没有 BTW 答案";
    if (branchedId !== null) return "本轮已分支";
    if (snapshot.status === "running") return "等答案写完再分支";
    if (snapshot.status !== "completed") return "只有已完成的答案可以分支";
    if (turns.length > 1) return "多轮话题保留在 BTW 历史中";
    return "分支凭据已失效，重新问一次";
  }, [branchedId, canBranch, snapshot, turns.length]);

  const dispatch = useCallback(
    async <TResult>(name: CommandName, payload: unknown): Promise<TResult> => {
      const client = clientRef.current;
      if (client === null) throw new Error("Host 未就绪");
      const handle = await client.command(name, payload as never);
      return await waitReceipt<TResult>(client, handle.requestId);
    },
    [],
  );

  const ask = useCallback(
    async (text: string, forceNewTopic = false): Promise<boolean> => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        setError("先写下要问的问题");
        return false;
      }
      if (trimmed.length > BTW_QUESTION_MAX_CHARS) {
        setError("问题过长");
        return false;
      }
      setQuestion(trimmed);
      if (input.preview) {
        setError(undefined);
        setNotice("演示：未发往 Host");
        setNewTopicDraft(false);
        setHistorySnapshot({ ephemeralId: "demo-local", status: "completed", text: PREVIEW_BTW_TURNS[1]!.answer });
        setTurns(rows => [...rows, { question: trimmed, answer: PREVIEW_BTW_TURNS[1]!.answer, status: "complete", createdAt: Date.now(), updatedAt: Date.now() }]);
        return true;
      }
      if (!input.canCommand) {
        setError("当前会话不支持 BTW");
        return false;
      }
      if (pendingRef.current) return false;
      const generation = selectionGeneration.current;
      pendingRef.current = true;
      setPending(true);
      setError(undefined);
      setNotice(undefined);
      try {
        if (snapshotRef.current?.status === "running") throw new Error("请先等待当前答案完成，或中止回答");
        setNewTopicDraft(false);
        if (!forceNewTopic && selectedTopicId && historyAvailable && input.client) {
          const previous = snapshot;
          if (previous?.status !== "completed") throw new Error("只有已完成的话题可以追问");
          const outcome = await invokeUpgrade(input.client, "btw.followUp", { topicId: selectedTopicId, question: trimmed });
          if (generation !== selectionGeneration.current) return false;
          if (previous && turns[turns.length - 1]?.answer !== previous.text) setTurns(rows => [...rows, { question: previous.question ?? question, answer: previous.text, status: "complete", createdAt: Date.now(), updatedAt: Date.now() }]);
          setBranchToken(null); setHistorySnapshot(null); expectedRoundRef.current = outcome.ephemeralId; setStartedAt(Date.now());
          return true;
        }
        const outcome = await dispatch<BtwAskOutcome>("btw.ask", { question: trimmed });
        if (generation !== selectionGeneration.current) return false;
        if (forceNewTopic) setTurns([]);
        setSelectedTopicId(historyAvailable ? outcome.ephemeralId : null);
        setHistorySnapshot(null);
        setBranchToken(outcome.branchToken);
        setTokenEphemeralId(outcome.ephemeralId);
        // The receipt can land before the first btw.changed; start the clock
        // here so the status line does not sit at 0s waiting for the event.
        expectedRoundRef.current = outcome.ephemeralId;
        seenRoundRef.current = outcome.ephemeralId;
        setStartedAt(Date.now());
        setBranchedId(null);
        return true;
      } catch (cause) {
        if (generation === selectionGeneration.current) setError(hostErrorMessage(cause, "BTW 提问失败"));
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [dispatch, input.canCommand, input.preview, input.client, selectedTopicId, historyAvailable, snapshot, turns, question],
  );

  const abort = useCallback(async () => {
    if (input.preview) {
      setNotice("演示：未发往 Host");
      return;
    }
    if (pendingRef.current) return;
    const id = snapshot?.ephemeralId;
    if (id === undefined) return;
    try {
      await dispatch("btw.abort", { ephemeralId: id });
      setError(undefined);
    } catch (cause) {
      setError(hostErrorMessage(cause, "中止失败"));
    }
  }, [dispatch, input.preview, snapshot?.ephemeralId]);

  const branch = useCallback(async () => {
    if (input.preview) {
      setNotice("演示：未发往 Host");
      return;
    }
    if (activeToken === null || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const outcome = await dispatch<BtwBranchOutcome>("btw.branch", { branchToken: activeToken });
      if (!outcome.branched) {
        setError(outcome.reason ?? "Runtime 拒绝了分支");
        return;
      }
      // One token, one branch. Keep it from being spent twice.
      setBranchedId(roundId);
      setError(undefined);
      setNotice("已分支为新会话");
      if (outcome.newSessionId !== undefined) {
        try {
          await onBranchedRef.current?.(outcome.newSessionId);
        } catch {
          // Selection is best-effort; the Runtime already created the session.
        }
      }
    } catch (cause) {
      setError(hostErrorMessage(cause, "分支失败"));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [activeToken, dispatch, input.preview, roundId]);

  const copy = useCallback(async () => {
    const text = snapshot?.copy ?? snapshot?.text ?? "";
    if (text.length === 0) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制答案");
    } catch {
      setError("剪贴板不可用");
    }
  }, [snapshot?.copy, snapshot?.text]);

  const dismissNotice = useCallback(() => setNotice(undefined), []);

  return {
    historyAvailable, topics, turns, selectedTopicId, selectTopic, newTopic, refreshHistory,
    snapshot,
    question: snapshot?.question ?? (question !== "" ? question : (input.preview ? (input.previewQuestion ?? "") : "")),
    draft,
    setDraft,
    startedAt,
    canAbort,
    canBranch,
    branchBlockedReason,
    pending,
    error,
    notice,
    ask,
    abort,
    branch,
    copy,
    dismissNotice,
  };
}
