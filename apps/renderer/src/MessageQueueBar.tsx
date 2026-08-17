import { useState } from "react";
import { Icon } from "./icons";
import type { ComposerDoc } from "./composer/types";
import type { PromptImage } from "./composer/types";

/** 流式期间按 Enter 入队的本地消息；run 结束后按序经 core.prompt 发送。
 *  条目上「插入纠偏」由调用方走 core.steer，打断当前回合。 */
export interface QueuedMessage {
  id: number;
  text: string;
  images?: ReadonlyArray<PromptImage>;
  doc?: ComposerDoc;
  /** Session that owned the draft. Flush must not send this into another thread. */
  sessionId?: string;
}

export function MessageQueueBar({ messages, running, sendEnabled, demo, onEdit, onSendNow, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  sendEnabled: boolean;
  /** 预览模式：数据来自 fixture，操作只改本地 UI，不调 Host。 */
  demo?: boolean;
  onEdit: (entry: QueuedMessage) => void;
  onSendNow: (entry: QueuedMessage) => void;
  onRemove: (entry: QueuedMessage) => void;
}) {
  const [open, setOpen] = useState(true);
  if (messages.length === 0) return null;
  return (
    <div className={`queue-strip${open ? "" : " collapsed"}`} role="group" aria-label="排队消息">
      <div className="qs-head">
        <Icon name="queue" extra="sm" />
        <span className="qs-title">排队消息 ×{messages.length}</span>
        <span className="qs-note">{running ? "本轮结束后自动按序发送" : "空闲后自动发送"}</span>
        {demo === true ? <span className="chip gray xs">演示</span> : null}
        <button
          type="button"
          className="icon-btn small qs-toggle"
          aria-expanded={open}
          aria-label={open ? "收起排队消息" : "展开排队消息"}
          data-tip={open ? "收起" : "展开"}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "chevron-d" : "chevron-u"} extra="sm" />
        </button>
      </div>
      <div className="qs-collapse" aria-hidden={!open} inert={open ? undefined : true}>
        <div className="qs-collapse-inner">
          <div className="qs-list" role="list">
            {messages.map((entry, index) => (
              <div className="qs-item" role="listitem" key={entry.id}>
                <span className="qs-text">{entry.text}</span>
                <span className="qs-actions">
                  <button
                    type="button"
                    className="icon-btn small"
                    data-tip="编辑：放回输入框"
                    aria-label={`编辑第 ${index + 1} 条排队消息`}
                    onClick={() => onEdit(entry)}
                  >
                    <Icon name="pencil" extra="sm" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small"
                    disabled={!sendEnabled}
                    data-tip={
                      demo === true
                        ? (running ? "插入纠偏（演示，不调用 Host）" : "立刻发送（演示，不调用 Host）")
                        : running
                          ? "插入纠偏：打断当前回合，跳过尚未开始的工具后立刻处理"
                          : "立刻发送"
                    }
                    aria-label={running ? `插入纠偏第 ${index + 1} 条排队消息` : `立刻发送第 ${index + 1} 条排队消息`}
                    onClick={() => onSendNow(entry)}
                  >
                    <Icon name={running ? "steering" : "send"} extra="sm" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small"
                    data-tip="删除"
                    aria-label={`删除第 ${index + 1} 条排队消息`}
                    onClick={() => onRemove(entry)}
                  >
                    <Icon name="trash" extra="sm" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
