import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "../icons";
import { MarkdownText } from "../conversation/markdown";
import type { BtwSessionApi } from "./useBtwSession";

/** Distance from the bottom within which the answer keeps auto-following. */
const FOLLOW_SLACK_PX = 48;

/**
 * BTW body, shared by the floating window and the docked side-panel tab.
 *
 * The Runtime holds a single slot: a new question replaces the previous round
 * (it is not a multi-turn side chat). `/btw` in the main composer still works;
 * the field here is the same ask, so the operator does not have to leave the
 * window to ask again.
 */
export function BtwPanel({
  session,
  demo,
  onDemoNext,
}: {
  session: BtwSessionApi;
  demo?: boolean;
  /** Preview only: walk the fixture rounds. Local UI, never a Host call. */
  onDemoNext?: () => void;
}) {
  const snapshot = session.snapshot;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const roundId = snapshot?.ephemeralId ?? null;

  const text = snapshot?.text ?? "";
  useEffect(() => {
    followRef.current = true;
  }, [roundId]);

  useEffect(() => {
    const node = bodyRef.current;
    if (node === null || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [text]);

  const onScroll = () => {
    const node = bodyRef.current;
    if (node === null) return;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  };

  return (
    <div className="btw-panel">
      {session.question === "" ? null : (
        <div className="btw-question" data-tip={session.question}>
          <Icon name="asterisk" extra="sm" />
          <span className="btw-question-text">{session.question}</span>
        </div>
      )}
      <div className="btw-body" ref={bodyRef} onScroll={onScroll}>
        {snapshot === null ? (
          <div className="empty">
            <Icon name="sparkles" extra="lg" />
            <p>还没有 BTW 问答</p>
            <p className="muted small">
              在下面问一句，或在主输入框用 <code>/btw &lt;question&gt;</code>。旁路提问不进主对话，也不打断当前回合。再问会覆盖这一轮。
            </p>
          </div>
        ) : text === "" && snapshot.status === "running" ? (
          <p className="muted small">等待 Runtime 回答…</p>
        ) : (
          <MarkdownText text={text} {...(snapshot.status === "running" ? { streaming: true } : {})} />
        )}
        {snapshot?.error === undefined ? null : (
          <p className="btw-error small">{snapshot.error.message}</p>
        )}
      </div>
      {session.error === undefined ? null : <p className="btw-error small">{session.error}</p>}
      {session.notice === undefined ? null : (
        <button type="button" className="btw-notice small" onClick={session.dismissNotice}>
          {session.notice}
        </button>
      )}
      <div className="btw-acts">
        <button
          type="button"
          className="btn ghost small"
          disabled={!session.canAbort}
          data-tip={session.canAbort ? "中止" : "无回答"}
          onClick={() => void session.abort()}
        >
          <Icon name="stop" extra="sm" />中止
        </button>
        <button
          type="button"
          className="btn ghost small"
          disabled={text === ""}
          data-tip={text === "" ? "无内容" : "复制"}
          onClick={() => void session.copy()}
        >
          <Icon name="copy" extra="sm" />复制
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn small"
          disabled={!session.canBranch || session.pending}
          {...(session.branchBlockedReason === undefined ? {} : { "data-tip": session.branchBlockedReason })}
          onClick={() => void session.branch()}
        >
          <Icon name="branch" extra="sm" />分支为新会话
        </button>
        {demo !== true ? null : onDemoNext === undefined ? (
          <span className="chip gray xs">演示</span>
        ) : (
          <button type="button" className="chip gray xs btw-demo-next" data-tip="演示" onClick={onDemoNext}>
            演示
          </button>
        )}
      </div>
      <BtwComposer session={session} />
    </div>
  );
}

function BtwComposer({ session }: { session: BtwSessionApi }) {
  const inputId = useId();
  const sending = session.pending;
  const draft = session.draft;
  const ready = draft.trim().length > 0 && !sending;
  const running = session.snapshot?.status === "running";

  const submit = async (): Promise<void> => {
    if (!ready) return;
    const ok = await session.ask(draft);
    if (ok) session.setDraft("");
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form className="btw-compose" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={inputId}>BTW 问题</label>
      <textarea
        id={inputId}
        className="btw-compose-input"
        rows={2}
        placeholder={running ? "再问一句会覆盖正在回答的这一轮" : "旁路问一句，不进主对话…"}
        value={draft}
        disabled={sending}
        onChange={(event) => session.setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="icon-btn small btw-compose-send"
        disabled={!ready}
        data-tip={running ? "覆盖" : "发送"}
        aria-label={running ? "覆盖本轮并提问" : "发送"}
      >
        <Icon name="send" extra="sm" />
      </button>
    </form>
  );
}
