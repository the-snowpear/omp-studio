import { createContext, useContext, useState } from "react";
import type { BtwSessionApi } from "./useBtwSession";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import "./inlineBtw.css";

export type BtwAnchor = { topicId: string; question: string; anchorItemId: string; scope: string };
export const InlineBtwContext = createContext<{ anchors: BtwAnchor[]; session: BtwSessionApi; openPanel: () => void } | null>(null);

export function InlineBtwNotes({ itemIds }: { itemIds: string[] }) {
  const context = useContext(InlineBtwContext);
  return context?.anchors.filter(anchor => itemIds.includes(anchor.anchorItemId)).map(anchor =>
    <InlineNote key={anchor.topicId} anchor={anchor} session={context.session} openPanel={context.openPanel} />) ?? null;
}

function InlineNote({ anchor, session, openPanel }: { anchor: BtwAnchor; session: BtwSessionApi; openPanel: () => void }) {
  const zh = useI18n().resolvedLanguage === "zh";
  const [expanded, setExpanded] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const selected = (session.selectedTopicId ?? session.snapshot?.topicId) === anchor.topicId;
  const live = selected ? session.snapshot : null;
  return <aside className="btw-inline">
    <button type="button" className="btw-inline-summary" aria-expanded={expanded} onClick={() => {
      if (!expanded && !selected) void session.selectTopic?.(anchor.topicId);
      setExpanded(!expanded);
    }}><b>?</b><span>{anchor.question}</span>{live?.status === "running" && <small>{zh ? "生成中" : "Writing"}</small>}<Icon name={expanded ? "chevron-d" : "chevron-r"} /></button>
    {expanded && <div className="btw-inline-body">{selected ? <>
      {session.turns?.filter((_, i) => i < (live?.turnIndex ?? 0)).map((turn, i) => <div key={i}><strong>{turn.question}</strong><p>{turn.answer}</p></div>)}
      {live?.text && <p>{live.text}</p>}
      <form onSubmit={event => { event.preventDefault(); void session.ask(followUp).then(ok => { if (ok) setFollowUp(""); }); }}>
        <input className="input" aria-label={zh ? "追问" : "Follow-up"} placeholder={zh ? "继续追问…" : "Ask a follow-up…"} value={followUp} onChange={event => setFollowUp(event.target.value)} />
        <button className="btn small outline" disabled={!followUp.trim() || !session.canAsk}>{zh ? "追问" : "Follow-up"}</button>
      </form>
      <div className="btw-inline-actions">
        <button disabled={!session.canCopy} onClick={() => void session.copy()}>{zh ? "复制" : "Copy"}</button>
        <button disabled={!session.canBranch} onClick={() => void session.branch()}>{zh ? "分支" : "Branch"}</button>
        <button disabled={live?.injection?.state !== "ready"} onClick={() => void session.inject?.(live?.injection?.id)}>{zh ? "注入主对话" : "Inject into chat"}</button>
        {session.canAbort && <button onClick={() => void session.abort()}>{zh ? "停止生成" : "Stop"}</button>}
      </div></> : <button className="btn small ghost" onClick={() => void session.selectTopic?.(anchor.topicId)}>{zh ? "查看回答" : "View answer"}</button>}
      <button className="btn small ghost" onClick={() => { if (!selected) void session.selectTopic?.(anchor.topicId); openPanel(); }}>{zh ? "在 BTW 面板中打开" : "Open in BTW panel"}</button>
    </div>}
  </aside>;
}
