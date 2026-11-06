import { invokeUpgrade, useUpgradeAvailable } from "../runtimeUpgrade";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_BTW_TOPICS, PREVIEW_BTW_TURNS, createBtwPreviewHistory } from "../preview/btwPreview";
import type { BtwTopicSummary, BtwHistoryTurn } from "@omp-studio/client-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BtwAskOutcome,
  BtwBranchOutcome,
  BtwSnapshot,
  PromptImageInput,
  CommandName,
  StudioClient,
} from "@omp-studio/client-contract";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { emptySnapshot, type ComposerSnapshot } from "../composer/types";
import { snapshotFromText } from "../composer/serialize";

export interface BtwSessionInput {
  /** Live snapshot from `clientState.entities.btw`; null before the first ask. */
  readonly snapshot: BtwSnapshot | null;
  readonly client: StudioClient | null;
  /** Preview mode drives fixtures and must never reach the Host. */
  readonly preview: boolean;
  readonly sessionId?: string;
  readonly targetActive?: boolean;
  readonly prepareTarget?: () => Promise<void>;
  /** Fixture question shown while previewing; ignored outside preview mode. */
  readonly previewQuestion?: string;
  readonly canCommand: boolean;
  readonly mainStreaming?: boolean;
  /** After a successful branch, switch the workbench to the new session. */
  readonly onBranched?: (sessionId: string) => void | Promise<void>;
}

export interface BtwSessionApi {
  readonly draftScope?: string;
  readonly running?: boolean;
  readonly canAsk?: boolean;
  readonly canCopy?: boolean;
  readonly branchAvailable?: boolean;
  readonly activeTopicId?: string;
  readonly historyLoading?: boolean;
  readonly questionImages?: readonly PromptImageInput[];
  readonly historyStatus?: BtwHistoryTurn["status"];
  resolveImagePaste?(text: string): Promise<readonly PromptImageInput[] | undefined>;
  readonly dictation?: { client: StudioClient; sessionId: string; available: boolean };
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
  readonly composerDraft?: ComposerSnapshot;
  setComposerDraft?(snapshot: ComposerSnapshot): void;
  /** Wall clock of the first `running` sighting for this round; null when idle. */
  readonly startedAt: number | null;
  readonly canAbort: boolean;
  readonly canBranch: boolean;
  /** Why branching is unavailable, for the disabled button's tooltip. */
  readonly branchBlockedReason: string | undefined;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly notice: string | undefined;
  ask(question: string, newTopic?: boolean, images?: import("@omp-studio/client-contract").PromptImageInput[], command?: { name: string; arguments: string }): Promise<boolean>;
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
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const [question, setQuestion] = useState("");
  const [composerDraft, setComposerDraft] = useState<ComposerSnapshot>(emptySnapshot);
  const draft = composerDraft.text;
  const setDraft = useCallback((text: string) => setComposerDraft(snapshotFromText(text)), []);
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
  const tRef = useRef(t);
  tRef.current = t;
  const pendingRef = useRef(false);

  const historyAvailable = useUpgradeAvailable(input.client, input.preview, "btw.history.list");
  const imagePathsAvailable = useUpgradeAvailable(input.client, input.preview, "btw.images.resolve");
  const [topics, setTopics] = useState<readonly BtwTopicSummary[]>([]);
  const [turns, setTurns] = useState<readonly BtwHistoryTurn[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [historySnapshot, setHistorySnapshot] = useState<BtwSnapshot | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [questionImages, setQuestionImages] = useState<readonly PromptImageInput[]>([]);
  const [demoSnapshot, setDemoSnapshot] = useState<BtwSnapshot>();
  const demoHistory = useRef(createBtwPreviewHistory());
  const demoSequence = useRef(0);
  const [newTopicDraft, setNewTopicDraft] = useState(false);
  const selectionGeneration = useRef(0);
  const seenRoundRef = useRef<string | null>(null);
  const expectedRoundRef = useRef<string | null>(null);
  const refreshHistory = useCallback(async (activate = true) => {
    if (input.preview) { setTopics(rows => rows.length ? rows : PREVIEW_BTW_TOPICS); return; }
    if (!input.client || !historyAvailable) return;
    if (!activate && input.targetActive === false) return;
    const generation = selectionGeneration.current;
    try {
      if (activate) await input.prepareTarget?.();
      if (generation !== selectionGeneration.current) return;
      const result = await invokeUpgrade(input.client, "btw.history.list", {});
      if (generation === selectionGeneration.current && (!input.sessionId || result.sessionId === input.sessionId)) setTopics(result.topics);
    } catch (cause) { if (generation === selectionGeneration.current) setError(hostErrorMessage(cause, tRef.current("runtimeUpgrade.btwHistoryUnavailable"))); }
  }, [input.client, input.preview, input.sessionId, input.targetActive, input.prepareTarget, historyAvailable]);
  const selectTopic = useCallback(async (topicId: string) => {
    const generation = ++selectionGeneration.current;
    setSelectedTopicId(topicId); setNewTopicDraft(false); setDraft(""); setTurns([]); setHistorySnapshot(null); setHistoryLoading(true); setQuestionImages([]); setError(undefined);
    try {
      if (!input.preview) await input.prepareTarget?.();
      if (generation !== selectionGeneration.current) return;
      const result = input.preview ? { turns: demoHistory.current.get(topicId) ?? [] } : input.client ? await invokeUpgrade(input.client, "btw.history.read", { topicId }) : null;
      if (generation !== selectionGeneration.current || !result) return;
      setTurns(result.turns);
      const last = result.turns[result.turns.length - 1];
      if (last) {
        setQuestion(last.question);
        setQuestionImages(last.images ?? []);
        setHistorySnapshot({ ephemeralId: "history:" + topicId, topicId, question: last.question, text: last.answer, turnIndex: result.turns.length - 1,
          status: last.status === "complete" ? "completed" : last.status === "running" ? "running" : last.status === "error" ? "failed" : "aborted", ...(last.error ? { error: { code: "INTERNAL_ERROR", message: last.error } } : {}) });
      }
    } catch (cause) { if (generation === selectionGeneration.current) setError(hostErrorMessage(cause, tRef.current("runtimeUpgrade.btwHistoryUnavailable"))); }
    finally { if (generation === selectionGeneration.current) setHistoryLoading(false); }
  }, [input.client, input.preview, input.prepareTarget]);
  const newTopic = useCallback(() => {
    selectionGeneration.current++;
    expectedRoundRef.current = null;
    seenRoundRef.current = null;
    setSelectedTopicId(null); setHistorySnapshot(null); setTurns([]); setNewTopicDraft(true);
    setQuestion(""); setDraft(""); setQuestionImages([]); setHistoryLoading(false);
    setStartedAt(null); setBranchedId(null); setError(undefined); setNotice(undefined);
  }, []);
  useEffect(() => {
    newTopic(); setTopics([]); setBranchToken(null); setTokenEphemeralId(null); setDemoSnapshot(undefined); demoHistory.current = createBtwPreviewHistory(); setNewTopicDraft(false); void refreshHistory(false);
    return () => { selectionGeneration.current++; };
  }, [input.client, input.sessionId, input.preview]);
  useEffect(() => { void refreshHistory(false); }, [refreshHistory, input.snapshot?.status]);
  useEffect(() => {
    setDemoSnapshot(undefined);
    if (input.preview && input.snapshot?.topicId) {
      const current = input.snapshot;
      demoHistory.current.set(current.topicId!, [{ question: current.question ?? input.previewQuestion ?? "", answer: current.text, status: current.status === "completed" ? "complete" : current.status === "running" ? "running" : current.status === "failed" ? "error" : "cancelled", createdAt: Date.now(), updatedAt: Date.now(), ...(current.error ? { error: current.error.message } : {}) }]);
    }
  }, [input.snapshot?.ephemeralId]);
  const source = input.preview ? demoSnapshot ?? input.snapshot : input.snapshot;
  const live = input.targetActive !== false && source && (!input.sessionId || !source.sessionId || source.sessionId === input.sessionId) ? source : null;
  const matchingLive = expectedRoundRef.current && live?.ephemeralId !== expectedRoundRef.current ? null : live;
  const snapshot = newTopicDraft ? null : historyAvailable && selectedTopicId && matchingLive?.topicId !== selectedTopicId ? historySnapshot : matchingLive ?? historySnapshot;
  const roundId = snapshot?.ephemeralId ?? null;
  useEffect(() => {
    if (!newTopicDraft && !pending && !selectedTopicId && live?.topicId) setSelectedTopicId(live.topicId);
  }, [live?.topicId, newTopicDraft, pending, selectedTopicId]);
  useEffect(() => {
    if (input.preview || !input.client || !historyAvailable || !selectedTopicId || live?.topicId !== selectedTopicId || live.status === "running") return;
    const generation = selectionGeneration.current;
    void invokeUpgrade(input.client, "btw.history.read", { topicId: selectedTopicId }).then(result => {
      if (generation !== selectionGeneration.current) return;
      setTurns(result.turns);
      setQuestionImages(result.turns.at(-1)?.images ?? []);
    }).catch(cause => { if (generation === selectionGeneration.current) setError(hostErrorMessage(cause, tRef.current("runtimeUpgrade.btwHistoryUnavailable"))); });
  }, [input.client, input.preview, historyAvailable, selectedTopicId, live?.ephemeralId, live?.status]);

  // A new ephemeralId is a new round: drop the previous token, restart the
  // clock, and clear the stale branch/error banners from the old answer.
  // The ask receipt can land before the first `btw.changed`; do not let that
  // lagging snapshot rewind the clock or drop the freshly minted token.
  useEffect(() => {
    if (expectedRoundRef.current === live?.ephemeralId) expectedRoundRef.current = null;
    if (expectedRoundRef.current !== null && roundId !== expectedRoundRef.current) {
      return;
    }
    if (seenRoundRef.current === roundId) return;
    seenRoundRef.current = roundId;
    if (roundId === null) {
      expectedRoundRef.current = null;
      setQuestion("");
      setStartedAt(null);
    } else if (expectedRoundRef.current !== roundId) {
      setStartedAt(snapshot?.status === "running" && !roundId.startsWith("history:") ? Date.now() : null);
    }
    setNotice(undefined);
    setError(undefined);
  }, [roundId, live?.ephemeralId]);

  // The token belongs to the round it was minted for.
  const activeToken = tokenEphemeralId !== null && tokenEphemeralId === roundId ? branchToken : null;

  const running = live?.status === "running" || (expectedRoundRef.current !== null && live?.ephemeralId !== expectedRoundRef.current);
  const canAbort = running && !pending;
  const canBranch = snapshot !== null && snapshot.status === "completed" && activeToken !== null && branchedId === null && !input.mainStreaming;
  const branchBlockedReason = useMemo(() => {
    if (canBranch) return undefined;
    if (input.mainStreaming) return t("btw.branchMainBusy");
    if (snapshot === null) return "还没有 BTW 答案";
    if (branchedId !== null) return "本轮已分支";
    if (snapshot.status === "running") return "等答案写完再分支";
    if (snapshot.status !== "completed") return "只有已完成的答案可以分支";
    if (turns.length > 1) return t("runtimeUpgrade.btwBranchBlockedHistory");
    return "分支凭据已失效，重新问一次";
  }, [branchedId, canBranch, snapshot, turns.length, input.mainStreaming, t]);

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
    async (text: string, forceNewTopic = false, images?: import("@omp-studio/client-contract").PromptImageInput[], command?: { name: string; arguments: string }): Promise<boolean> => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        setError("先写下要问的问题");
        return false;
      }
      setQuestion(trimmed);
      if (input.preview) {
        setError(undefined);
        if (marks) setNotice("演示：未发往 Host");
        const topicId = !forceNewTopic && selectedTopicId ? selectedTopicId : `demo-topic-${++demoSequence.current}`;
        const rows = [...(demoHistory.current.get(topicId) ?? []), { question: trimmed, ...(images?.length ? { images } : {}), answer: PREVIEW_BTW_TURNS[1]!.answer, status: "complete" as const, createdAt: Date.now(), updatedAt: Date.now() }];
        demoHistory.current.set(topicId, rows);
        setNewTopicDraft(false); setSelectedTopicId(topicId); setQuestionImages(images ?? []);
        setDemoSnapshot({ ephemeralId: `demo-round-${++demoSequence.current}`, topicId, question: trimmed, status: "completed", turnIndex: rows.length - 1, text: PREVIEW_BTW_TURNS[1]!.answer });
        setTurns(rows);
        setTopics(previous => [{ topicId, question: rows[0]!.question, status: "complete", updatedAt: Date.now(), turnCount: rows.length }, ...previous.filter(row => row.topicId !== topicId)]);
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
        await input.prepareTarget?.();
        if (generation !== selectionGeneration.current) return false;
        if (input.targetActive !== false && snapshotRef.current?.status === "running") throw new Error(tRef.current("runtimeUpgrade.btwWait"));
        setNewTopicDraft(false);
        if (!forceNewTopic && selectedTopicId && historyAvailable && input.client) {
          const previous = snapshot;
          if (!previous || previous.status === "running") throw new Error(tRef.current("runtimeUpgrade.btwWait"));
          const outcome = await invokeUpgrade(input.client, "btw.followUp", { topicId: selectedTopicId, question: trimmed, ...(images?.length ? { images } : {}) });
          if (generation !== selectionGeneration.current) return false;
          const previousIndex = previous.turnIndex ?? Math.max(0, turns.length - (turns.at(-1)?.answer === previous.text ? 1 : 0));
          const previousTurns = [...turns.slice(0, previousIndex), { question: previous.question ?? question, images: questionImages, answer: previous.text, status: (previous.ephemeralId.startsWith("history:") ? turns[previousIndex]?.status : undefined) ?? (previous.status === "completed" ? "complete" as const : previous.status === "failed" ? "error" as const : "cancelled" as const), createdAt: turns[previousIndex]?.createdAt ?? startedAt ?? Date.now(), updatedAt: turns[previousIndex]?.updatedAt ?? Date.now(), ...(previous.error ? { error: previous.error.message } : {}) }];
          setTurns(previousTurns); setQuestionImages(images ?? []);
          setBranchToken(null); expectedRoundRef.current = outcome.ephemeralId; setStartedAt(Date.now());
          setHistorySnapshot({ ephemeralId: outcome.ephemeralId, topicId: selectedTopicId, question: trimmed, status: "running", text: "", turnIndex: previousTurns.length });
          return true;
        }
        const outcome = await dispatch<BtwAskOutcome>("btw.ask", { question: trimmed, ...(images?.length ? { images } : {}), ...(command ? { command } : {}) });
        if (generation !== selectionGeneration.current) return false;
        setTurns([]); setQuestionImages(images ?? []);
        setSelectedTopicId(historyAvailable ? outcome.ephemeralId : null);
        setHistorySnapshot({ ephemeralId: outcome.ephemeralId, topicId: outcome.ephemeralId, question: trimmed, status: "running", text: "", turnIndex: 0 });
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
    [dispatch, input.canCommand, input.preview, input.client, input.prepareTarget, input.sessionId, input.targetActive, selectedTopicId, historyAvailable, snapshot, turns, question, questionImages, startedAt, marks],
  );

  const abort = useCallback(async () => {
    if (input.preview) {
      if (live) {
        setDemoSnapshot({ ...live, status: "aborted" });
        if (live.topicId) {
          const rows = [...(demoHistory.current.get(live.topicId) ?? []).slice(0, live.turnIndex ?? 0), { question: live.question ?? question, images: questionImages, answer: live.text, status: "cancelled" as const, createdAt: Date.now(), updatedAt: Date.now() }];
          demoHistory.current.set(live.topicId, rows);
          if (selectedTopicId === live.topicId) setTurns(rows);
          setTopics(topics => topics.map(topic => topic.topicId === live.topicId ? { ...topic, status: "cancelled", updatedAt: Date.now() } : topic));
        }
      }
      if (marks) setNotice("演示：未发往 Host");
      return;
    }
    if (pendingRef.current) return;
    const id = expectedRoundRef.current ?? live?.ephemeralId;
    if (id === undefined) return;
    pendingRef.current = true; setPending(true);
    try {
      await dispatch("btw.abort", { ephemeralId: id });
      setError(undefined);
    } catch (cause) {
      setError(hostErrorMessage(cause, "中止失败"));
    } finally { pendingRef.current = false; setPending(false); }
  }, [dispatch, input.preview, live, question, questionImages, selectedTopicId, marks]);

  const branch = useCallback(async () => {
    if (input.preview) {
      if (marks) setNotice("演示：未发往 Host");
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
  }, [activeToken, dispatch, input.preview, roundId, marks]);

  const copy = useCallback(async () => {
    const text = snapshot?.text.trim() ? snapshot.copy ?? snapshot.text : [...turns].reverse().find(turn => turn.answer.trim())?.answer ?? "";
    if (text.length === 0) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制答案");
    } catch {
      setError("剪贴板不可用");
    }
  }, [snapshot?.copy, snapshot?.text, turns]);

  const dismissNotice = useCallback(() => setNotice(undefined), []);

  return {
    ...(!input.preview && input.client && imagePathsAvailable ? { resolveImagePaste: async (text: string) => (await invokeUpgrade(input.client!, "btw.images.resolve", { text })).images } : {}),
    draftScope: "btw:" + (input.sessionId ?? "new"),
    ...(snapshot?.ephemeralId.startsWith("history:") && turns.at(-1) ? { historyStatus: turns.at(-1)!.status } : {}),
    running, canAsk: (input.preview || input.canCommand) && !pending && !running && !historyLoading,
    canCopy: !!(snapshot?.text.trim() || turns.some(turn => turn.answer.trim())),
    ...(live?.topicId ? { activeTopicId: live.topicId } : {}), historyLoading, questionImages,
    ...(input.client && input.sessionId ? { dictation: { client: input.client, sessionId: input.sessionId, available: input.canCommand && input.targetActive !== false } } : {}),
    historyAvailable, topics, turns, selectedTopicId, selectTopic, newTopic, refreshHistory,
    snapshot,
    question: snapshot?.question ?? (question !== "" ? question : (input.preview ? (input.previewQuestion ?? "") : "")),
    draft,
    setDraft,
    composerDraft,
    setComposerDraft,
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
