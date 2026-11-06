import { useEffect, useRef, useState } from "react";
import type { BtwSnapshot, PromptImageInput, StudioClient } from "@omp-studio/client-contract";
import type { AgentBtwOperation, AgentBtwState } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { agentBtwPreview, PREVIEW_CHILD_BTW_TURNS } from "../preview/agentBtwPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { emptySnapshot, type ComposerSnapshot } from "../composer/types";
import { snapshotFromText } from "../composer/serialize";
import { BtwPanel } from "./BtwPanel";
import type { BtwSessionApi } from "./useBtwSession";
import { invokeUpgrade } from "../runtimeUpgrade";
import type { SubagentBtwViewState } from "../conversation/subagentViewState";

export function AgentBtwPane({ client, sessionId, agentId, available, viewState }: {
  client: StudioClient | undefined; sessionId: string | undefined; agentId: string; available: boolean; viewState?: SubagentBtwViewState;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [state, setState] = useState<AgentBtwState | undefined>(() => preview ? viewState?.previewState : undefined);
  const [draft, setDraftValue] = useState<ComposerSnapshot>(() => viewState?.draft ?? emptySnapshot());
  const [topic, setTopicValue] = useState(() => viewState?.topic ?? "");
  const setDraft = (next: ComposerSnapshot) => { if (viewState) viewState.draft = next; setDraftValue(next); };
  const setTopic = (next: string) => { if (viewState) viewState.topic = next; setTopicValue(next); };
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const demoHistory = useRef<Record<string, AgentBtwState["turns"]>>({ "demo-child-topic": [...PREVIEW_CHILD_BTW_TURNS] });
  const epoch = useRef(0);
  const binding = useRef<string | undefined>(undefined);
  const stopped = useRef(false);
  const action = useRef(false);
  const topicRef = useRef(topic); topicRef.current = topic;
  const availableRef = useRef(available); availableRef.current = available;
  const stateRef = useRef(state); stateRef.current = state;
  const historyTopic = useRef("");
  const historyVersion = useRef("");
  const execute = async (operation: AgentBtwOperation) => {
    if (!client) throw Error("Host unavailable");
    const { kind, ...input } = operation;
    const handle = await client.command(kind, input as never);
    return (await waitReceipt<{ result: AgentBtwState }>(client, handle.requestId)).result;
  };
  useEffect(() => {
    const generation = ++epoch.current;
    binding.current = undefined; stopped.current = false; action.current = false;
    historyTopic.current = ""; historyVersion.current = "";
    setState(preview ? viewState?.previewState ?? agentBtwPreview(agentId) : undefined);
    setTopic(viewState?.topic ?? ""); setDraft(viewState?.draft ?? emptySnapshot()); setError(undefined); setNotice(undefined); setBusy(false);
    demoHistory.current = viewState?.previewHistory ?? { "demo-child-topic": [...PREVIEW_CHILD_BTW_TURNS] };
    if (preview && viewState) viewState.previewHistory = demoHistory.current;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (!preview && client && sessionId && availableRef.current && !stopped.current && !action.current) {
        const requestedTopic = topicRef.current;
        const current = stateRef.current?.snapshot;
        const version = current ? current.ephemeralId + ":" + current.status : "idle";
        const includeHistory = !!requestedTopic && (historyTopic.current !== requestedTopic || historyVersion.current !== version);
        try {
          const result = await execute({ kind: "agent.btw.read", sessionId, agentId, ...(binding.current ? { binding: binding.current } : {}), ...(includeHistory ? { topicId: requestedTopic } : {}) });
          if (generation === epoch.current) {
            binding.current = result.binding;
            if (requestedTopic === topicRef.current) {
              if (includeHistory) { historyTopic.current = requestedTopic; historyVersion.current = result.snapshot ? result.snapshot.ephemeralId + ":" + result.snapshot.status : "idle"; }
              setState(previous => ({ ...result, turns: includeHistory ? result.turns : previous?.turns ?? [] })); setLoading(false);
            }
          }
        } catch (cause) {
          if (generation === epoch.current) { stopped.current = true; setLoading(false); setError(hostErrorMessage(cause, zh ? "子代理 BTW 不可用；请重新打开此目标" : "Child BTW unavailable; reopen this target")); }
        }
      }
      if (generation === epoch.current) timer = setTimeout(() => void read(), 500);
    };
    if (!preview) void read();
    return () => { epoch.current++; clearTimeout(timer); };
  }, [client, sessionId, agentId, preview]);
  useEffect(() => { if (preview && viewState && state) viewState.previewState = state; }, [preview, viewState, state]);

  const choose = (next: string) => {
    topicRef.current = next; setTopic(next); setDraft(emptySnapshot()); setNotice(undefined);
    setLoading(!!next && !preview);
    setState(current => current ? { ...current, turns: preview ? demoHistory.current[next] ?? [] : [] } : current);
  };
  const running = state?.snapshot?.status === "running";
  const refreshHistory = async () => {
    if (preview || !available || !sessionId || !binding.current || stopped.current) return;
    const generation = epoch.current, requestedTopic = topicRef.current;
    try {
      const result = await execute({ kind: "agent.btw.read", sessionId, agentId, binding: binding.current, ...(requestedTopic ? { topicId: requestedTopic } : {}) });
      if (generation === epoch.current && requestedTopic === topicRef.current) setState(result);
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "无法刷新 BTW 历史" : "Could not refresh BTW history")); }
  };
  const ask = async (question: string, _newTopic = false, images?: PromptImageInput[]) => {
    if (action.current || running || !question.trim()) return false;
    if (preview) {
      const now = Date.now(), topicId = topic || "demo-topic-" + now;
      const answer = marks ? (zh ? "演示：本话题只使用所选子代理的上下文，不会发往 Host。" : "Demo: using only this child's context; no Host call.") : PREVIEW_CHILD_BTW_TURNS[0]!.answer;
      const turns = [...(demoHistory.current[topicId] ?? []), { question, ...(images?.length ? { images } : {}), answer, status: "complete" as const, createdAt: now, updatedAt: now }];
      demoHistory.current[topicId] = turns;
      setState(current => ({ ...current!, snapshot: { ephemeralId: "demo-child-" + now, topicId, question, text: answer, status: "completed", turnIndex: turns.length - 1 }, topics: [{ topicId, question: turns[0]!.question, status: "complete", updatedAt: now, turnCount: turns.length }, ...current!.topics.filter(item => item.topicId !== topicId)], turns }));
      setTopic(topicId); return true;
    }
    if (!available || !sessionId || !binding.current || stopped.current) return false;
    const generation = epoch.current;
    action.current = true; setBusy(true); setError(undefined);
    try {
      const result = await execute({ kind: "agent.btw.ask", sessionId, agentId, binding: binding.current, question: question.trim(), ...(topic ? { topicId: topic } : {}), ...(images?.length ? { images } : {}) });
      if (generation !== epoch.current) return false;
      setState(result); setTopic(result.snapshot?.topicId ?? topic); setLoading(false);
      return true;
    } catch (cause) {
      if (generation === epoch.current) { stopped.current = true; setError(hostErrorMessage(cause, zh ? "目标失效或回执不确定，请检查后重新打开" : "Target invalid or outcome uncertain; reopen it")); }
      return false;
    } finally { if (generation === epoch.current) { action.current = false; setBusy(false); } }
  };
  const abort = async () => {
    if (!running || action.current) return;
    if (preview) { setState(current => ({ ...current!, snapshot: { ...current!.snapshot!, status: "aborted" } })); return; }
    if (!available || !sessionId || !binding.current || stopped.current) return;
    const generation = epoch.current;
    action.current = true; setBusy(true);
    try {
      const result = await execute({ kind: "agent.btw.abort", sessionId, agentId, binding: binding.current, ephemeralId: state!.snapshot!.ephemeralId });
      if (generation === epoch.current) setState(current => ({ ...result, turns: current?.turns ?? [] }));
    } catch (cause) {
      if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "中止失败" : "Could not stop the answer"));
    } finally { if (generation === epoch.current) { action.current = false; setBusy(false); } }
  };
  const turns = topic ? state?.turns ?? [] : [];
  const last = turns.at(-1);
  const snapshot: BtwSnapshot | null = state?.snapshot?.topicId === topic ? state.snapshot : last ? {
    ephemeralId: "history:" + topic, topicId: topic, question: last.question, text: last.answer, turnIndex: turns.length - 1,
    status: last.status === "complete" ? "completed" : last.status === "running" ? "running" : last.status === "error" ? "failed" : "aborted",
    ...(last.error ? { error: { code: "INTERNAL_ERROR", message: last.error } } : {}),
  } : null;
  const copyText = snapshot?.text.trim() ? snapshot.text : [...turns].reverse().find(turn => turn.answer.trim())?.answer ?? "";
  const session: BtwSessionApi = {
    historyAvailable: preview || available, topics: state?.topics ?? [], turns, selectedTopicId: topic || null,
    historyLoading: loading, selectTopic: async id => choose(id), newTopic: () => choose(""),
    refreshHistory,
    ...(snapshot?.ephemeralId.startsWith("history:") && last ? { historyStatus: last.status } : {}),
    snapshot, question: snapshot?.question ?? "", questionImages: turns[snapshot?.turnIndex ?? turns.length - 1]?.images ?? [],
    draft: draft.text, composerDraft: draft, setComposerDraft: setDraft, setDraft: text => setDraft(snapshotFromText(text)),
    running, canAsk: !busy && !running && !loading && (preview || (available && !!state && !stopped.current)),
    ...(state?.snapshot?.topicId ? { activeTopicId: state.snapshot.topicId } : {}),
    startedAt: null, canAbort: !!running && !busy && (preview || available), canBranch: false, branchAvailable: false,
    branchBlockedReason: undefined, pending: busy, error, notice, ask, abort,
    canCopy: !!copyText, copy: async () => { try { await navigator.clipboard.writeText(copyText); setNotice(zh ? "已复制答案" : "Answer copied"); } catch { setError(zh ? "剪贴板不可用" : "Clipboard unavailable"); } },
    branch: async () => {}, dismissNotice: () => setNotice(undefined),
    draftScope: "agent-btw:" + agentId,
    ...(!preview && client && available ? { resolveImagePaste: async (text: string) => (await invokeUpgrade(client, "btw.images.resolve", { text })).images } : {}),
    ...(client && sessionId ? { dictation: { client, sessionId, available } } : {}),
  };
  return <section className="btw-child-pane" aria-label={zh ? "子代理 BTW" : "Child agent BTW"}>
    <p className="btw-child-context">{agentId} · {preview && marks ? (zh ? "演示" : "Demo") : state?.targetSessionId ?? "—"}</p>
    {!preview && !available ? <p role="status" className="btw-child-context">{zh ? "当前 Runtime 或目标不支持子代理 BTW" : "This Runtime or target does not support child BTW"}</p> : null}
    <BtwPanel session={session} demo={preview} />
  </section>;
}
