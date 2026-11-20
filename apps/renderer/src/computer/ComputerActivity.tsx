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
        <span><strong>{actionName(action, zh)}</strong><span>{action.targetName ?? action.targetId ?? (zh ? "目标未记录" : "Target not recorded")}</span><small>{action.agentName ?? action.agentId ?? (zh ? "主会话" : "Main session")} · {actionStatus(action, zh)}{action.unconfirmed ? <em className="cw-action-flag">{zh ? "未确认送达" : "Delivery unconfirmed"}</em> : null}{action.focusReturn && !action.focusReturn.handedBack ? <em className="cw-action-flag">{zh ? "焦点未交还" : "Focus not returned"}</em> : null}</small></span>
        <time dateTime={new Date(action.startedAt).toISOString()}>{frameTime(action.startedAt, zh)}</time>
      </button>
      {selected === action.id ? <div className="cw-action-detail">{action.error ? <p role="alert">{action.error}</p> : null}
        {action.unconfirmed ? <p className="cw-action-warn">{zh ? "输入已发送，但无法确认目标应用收到：" : "Input was sent, but delivery to the target could not be confirmed: "}{action.unconfirmed}</p> : null}
        {!!action.nativeWindowIds?.length && <p>{zh ? "原生窗口" : "Native windows"} · {action.nativeWindowIds.map(id => <code key={id}>computer.window({id}) </code>)}</p>}
        {action.focusReturn?.keyboard && <p>{zh ? "键盘焦点" : "Keyboard focus"} · {{handedBack: zh ? "已交还" : "Handed back", leftAsChosen: zh ? "保留用户选择" : "Left as chosen", kept: zh ? "已保持" : "Kept", frontOnly: zh ? "仅将应用置前" : "Brought to front only", notSent: zh ? "未发送" : "Not sent"}[action.focusReturn.keyboard]}</p>}
        {action.focusReturn ? <p className={action.focusReturn.handedBack ? undefined : "cw-action-warn"}>{action.focusReturn.handedBack
          ? zh ? `操作结束后已把焦点交还${action.focusReturn.previousPid !== undefined ? `给原应用（PID ${action.focusReturn.previousPid}）` : "给原应用"}。` : `Focus was handed back${action.focusReturn.previousPid !== undefined ? ` to the previous app (PID ${action.focusReturn.previousPid})` : " to the previous app"}.`
          : zh ? `焦点没有交还${action.focusReturn.frontPid !== undefined ? `：当前前台是 PID ${action.focusReturn.frontPid}` : ""}${action.focusReturn.previousPid !== undefined ? `，原应用 PID ${action.focusReturn.previousPid}` : ""}。请自行切回需要的窗口。` : `Focus was not handed back${action.focusReturn.frontPid !== undefined ? `; PID ${action.focusReturn.frontPid} is in front` : ""}${action.focusReturn.previousPid !== undefined ? ` (previous app PID ${action.focusReturn.previousPid})` : ""}. Switch back to the window you need yourself.`}</p> : null}<p>{action.frameIds.length ? zh ? `${action.frameIds.length} 张关联画面` : `${action.frameIds.length} linked frames` : zh ? "此步骤没有截图" : "This step has no screenshot"}</p>{action.frameIds.length > 1 ? <div>{action.frameIds.map((id, index) => <button className="cw-button" key={id} onClick={() => onSelect(action, id)}>{zh ? `画面 ${index + 1}` : `Frame ${index + 1}`}</button>)}</div> : null}<button className="cw-button" disabled={!action.toolCallId} onClick={() => onReveal(action)}><Icon name="message" />{zh ? "在对话中查看" : "View in conversation"}</button></div> : null}
    </li>)}</ol> : <p className="cw-subtle">{zh ? "尚无已记录的电脑动作" : "No computer actions recorded"}</p>}
    {more ? <button className="cw-button cw-more" disabled={busy} onClick={onMore}>{busy ? zh ? "正在读取…" : "Loading…" : zh ? "加载更早动作" : "Load earlier actions"}</button> : null}
  </div>;
}
