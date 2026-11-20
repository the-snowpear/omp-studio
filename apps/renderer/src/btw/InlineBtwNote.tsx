import { createContext, useContext, useState } from "react";
import type { BtwSessionApi } from "./useBtwSession";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { MarkdownText } from "../conversation/markdown";
import "./inlineBtw.css";

export type BtwAnchor = { topicId: string; question: string; anchorItemId: string; scope: string };
export const InlineBtwContext = createContext<{ anchors: BtwAnchor[]; session: BtwSessionApi; openPanel: () => void } | null>(null);

export function InlineBtwNotes({ itemIds }: { itemIds: string[] }) {
  const context = useContext(InlineBtwContext);
  return context?.anchors.filter(anchor => itemIds.includes(anchor.anchorItemId)).map(anchor =>
    <InlineNote key={anchor.topicId} anchor={anchor} session={context.session} openPanel={context.openPanel} />) ?? null;
}

/** A margin note anchored in the main timeline: one line while folded, the BTW thread when opened. */
function InlineNote({ anchor, session, openPanel }: { anchor: BtwAnchor; session: BtwSessionApi; openPanel: () => void }) {
  const zh = useI18n().resolvedLanguage === "zh";
  const [expanded, setExpanded] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const selected = (session.selectedTopicId ?? session.snapshot?.topicId) === anchor.topicId;
  const live = selected ? session.snapshot : null;
  const status = live?.status ?? "idle";
  const running = status === "running";
  const earlier = selected ? session.turns?.filter((_, i) => i < (live?.turnIndex ?? 0)) ?? [] : [];
  const snippet = live?.text.replace(/\s+/g, " ").trim();
  const stateLabel = running ? (zh ? "生成中" : "Writing") : status === "failed" ? (zh ? "失败" : "Failed") : status === "aborted" ? (zh ? "已停止" : "Stopped") : null;
  const injectReady = live?.injection?.state === "ready";
  return <aside className="btw-inline" data-status={status} data-open={expanded || undefined} aria-label={zh ? "BTW 旁路提问" : "BTW side question"}>
    <button type="button" className="btw-inline-summary" aria-expanded={expanded} onClick={() => {
      if (!expanded && !selected) void session.selectTopic?.(anchor.topicId);
      setExpanded(!expanded);
    }}>
      <span className="btw-inline-glyph" aria-hidden><Icon name="sparkles" extra="sm" /></span>
      <span className="btw-inline-copy">
        <span className="btw-inline-line">
          <span className="btw-inline-eyebrow">BTW</span>
          <span className="btw-inline-question">{anchor.question}</span>
        </span>
        {!expanded && snippet ? <span className="btw-inline-snippet">{snippet}</span> : null}
      </span>
      {stateLabel ? <span className="btw-inline-state">{stateLabel}</span> : null}
      <Icon name="chevron-r" extra="sm btw-inline-chevron" />
    </button>
    {expanded ? <div className="btw-inline-body">
      {selected ? <>
        {earlier.map((turn, i) => <div className="btw-inline-turn" key={i}>
          <p className="btw-inline-ask">{turn.question}</p>
          <div className="btw-inline-answer"><MarkdownText text={turn.answer} /></div>
        </div>)}
        {earlier.length ? <p className="btw-inline-ask">{live?.question ?? anchor.question}</p> : null}
        {live?.text ? <div className="btw-inline-answer"><MarkdownText text={live.text} streaming={running} /></div>
          : running ? <div className="btw-thinking" aria-label={zh ? "生成中" : "Writing"}><span /><span /><span /></div> : null}
        <form className="btw-inline-follow" onSubmit={event => { event.preventDefault(); void session.ask(followUp).then(ok => { if (ok) setFollowUp(""); }); }}>
          <input aria-label={zh ? "追问" : "Follow-up"} placeholder={zh ? "继续追问，不打断主对话…" : "Ask a follow-up without interrupting…"} value={followUp} onChange={event => setFollowUp(event.target.value)} />
          <button type="submit" className="btw-inline-send" aria-label={zh ? "追问" : "Follow-up"} data-tip={zh ? "追问" : "Follow-up"} disabled={!followUp.trim() || !session.canAsk}><Icon name="arrow-u" extra="sm" /></button>
        </form>
        <div className="btw-inline-actions">
          <button type="button" disabled={!session.canCopy} onClick={() => void session.copy()}><Icon name="copy" extra="sm" />{zh ? "复制" : "Copy"}</button>
          <button type="button" disabled={!session.canBranch} data-tip={session.canBranch ? undefined : session.branchBlockedReason} onClick={() => void session.branch()}><Icon name="branch" extra="sm" />{zh ? "分支为新会话" : "Branch"}</button>
          <button type="button" disabled={!injectReady} onClick={() => void session.inject?.(live?.injection?.id)}><Icon name="message" extra="sm" />{zh ? "注入主对话" : "Inject into chat"}</button>
          {session.canAbort ? <button type="button" className="is-danger" onClick={() => void session.abort()}><Icon name="stop" extra="sm" />{zh ? "停止生成" : "Stop"}</button> : null}
          <button type="button" className="is-link" onClick={() => { if (!selected) void session.selectTopic?.(anchor.topicId); openPanel(); }}>{zh ? "在 BTW 面板中打开" : "Open in BTW panel"}<Icon name="panel" extra="sm" /></button>
        </div>
      </> : <div className="btw-inline-actions">
        <button type="button" onClick={() => void session.selectTopic?.(anchor.topicId)}><Icon name="eye" extra="sm" />{zh ? "查看回答" : "View answer"}</button>
        <button type="button" className="is-link" onClick={() => { void session.selectTopic?.(anchor.topicId); openPanel(); }}>{zh ? "在 BTW 面板中打开" : "Open in BTW panel"}<Icon name="panel" extra="sm" /></button>
      </div>}
    </div> : null}
  </aside>;
}
