import type { ComputerAction } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { actionName, actionStatus, frameTime } from "./presentation";
export function ComputerActivity({ actions, selected, onSelect, onReveal, more, busy, onMore, zh }: {
  actions: readonly ComputerAction[]; selected?: string | undefined; onSelect: (action: ComputerAction, frameId?: string) => void;
  onReveal: (action: ComputerAction) => void; more: boolean; busy: boolean; onMore: () => void; zh: boolean;
}) {
  const rows = [...actions].sort((a, b) => b.startedAt - a.startedAt);
  return <div className="cw-activity"><header><h3>{zh ? "近期动作" : "Recent actions"}</h3><span>{rows.length}</span></header>
    {rows.length ? <ol>{rows.map(action => <li key={action.id} data-status={action.status} data-selected={selected === action.id || undefined}>
      <button className="cw-action" aria-pressed={selected === action.id} onClick={() => onSelect(action, action.frameIds.at(-1))}>
        <Icon name={action.status === "completed" ? "check" : action.status === "failed" ? "alert-c" : action.status === "cancelled" ? "stop" : "clock"} />
        <span><strong>{actionName(action, zh)}</strong><span>{action.targetName ?? action.targetId ?? (zh ? "目标未记录" : "Target not recorded")}</span><small>{action.agentName ?? action.agentId ?? (zh ? "主会话" : "Main session")} · {actionStatus(action, zh)}</small></span>
        <time dateTime={new Date(action.startedAt).toISOString()}>{frameTime(action.startedAt, zh)}</time>
      </button>
      {selected === action.id ? <div className="cw-action-detail">{action.error ? <p role="alert">{action.error}</p> : null}<p>{action.frameIds.length ? zh ? `${action.frameIds.length} 张关联画面` : `${action.frameIds.length} linked frames` : zh ? "此步骤没有截图" : "This step has no screenshot"}</p>{action.frameIds.length > 1 ? <div>{action.frameIds.map((id, index) => <button className="cw-button" key={id} onClick={() => onSelect(action, id)}>{zh ? `画面 ${index + 1}` : `Frame ${index + 1}`}</button>)}</div> : null}<button className="cw-button" disabled={!action.toolCallId} onClick={() => onReveal(action)}><Icon name="message" />{zh ? "在对话中查看" : "View in conversation"}</button></div> : null}
    </li>)}</ol> : <p className="cw-subtle">{zh ? "尚无已记录的电脑动作" : "No computer actions recorded"}</p>}
    {more ? <button className="cw-button cw-more" disabled={busy} onClick={onMore}>{busy ? zh ? "正在读取…" : "Loading…" : zh ? "加载更早动作" : "Load earlier actions"}</button> : null}
  </div>;
}
