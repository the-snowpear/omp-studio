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

export function MessageQueueBar({ messages, running, sendEnabled, demo, editingId, onEdit, onSendNow, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  sendEnabled: boolean;
  /** 预览模式：数据来自 fixture，操作只改本地 UI，不调 Host。 */
  demo?: boolean;
  /** Row currently loaded into Composer; stays in the list with an 编辑中 mark. */
  editingId?: number;
  onEdit: (entry: QueuedMessage) => void;
  onSendNow: (entry: QueuedMessage) => void;
  onRemove: (entry: QueuedMessage) => void;
}) {
  const [open, setOpen] = useState(true);
  if (messages.length === 0) return null;
  return (
    <div className={`queue-strip${open ? "" : " collapsed"}`} role="group" aria-label="排队消息">
      <button
        type="button"
        className="qs-head"
        aria-expanded={open}
        aria-label={open ? "收起排队消息" : "展开排队消息"}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="queue" extra="sm" />
        <span className="qs-title">排队消息 ×{messages.length}</span>
        <span className="qs-note">{running ? "本轮结束后自动按序发送" : "空闲后自动发送"}</span>
        {demo === true ? <span className="chip gray xs">演示</span> : null}
        <span className="qs-toggle" aria-hidden="true">
          <Icon name={open ? "chevron-d" : "chevron-u"} extra="sm" />
        </span>
      </button>
      <div className="qs-collapse" aria-hidden={!open} inert={open ? undefined : true}>
        <div className="qs-collapse-inner">
          <div className="qs-list" role="list">
            {messages.map((entry, index) => {
              const editing = editingId === entry.id;
              return (
                <div className={`qs-item${editing ? " editing" : ""}`} role="listitem" key={entry.id}>
                  <span className="qs-text">{entry.text}</span>
                  <span className="qs-status">
                    {editing ? <span className="qs-editing">编辑中</span> : null}
                    <span className="qs-actions">
                      <button
                        type="button"
                        className="icon-btn small"
                        data-tip="编辑"
                        aria-label={`编辑第 ${index + 1} 条排队消息`}
                        onClick={() => onEdit(entry)}
                      >
                        <Icon name="pencil" extra="sm" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn small"
                        disabled={!sendEnabled}
                        data-send-icon="arrow-u"
                        data-tip={running ? "纠偏" : "发送"}
                        aria-label={running ? `插入纠偏第 ${index + 1} 条排队消息` : `立刻发送第 ${index + 1} 条排队消息`}
                        onClick={() => onSendNow(entry)}
                      >
                        <Icon name="arrow-u" extra="sm" />
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
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
