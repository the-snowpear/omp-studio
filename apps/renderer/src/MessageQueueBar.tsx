import { useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { usePreviewMode } from "./preview/PreviewContext";
import { useI18n } from "./i18n";
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

export function MessageQueueBar({ messages, running, sendEnabled, demo, editingId, headerSlot, onEdit, onSendNow, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  sendEnabled: boolean;
  /** 预览模式：数据来自 fixture，操作只改本地 UI，不调 Host。 */
  demo?: boolean;
  /** Row currently loaded into Composer; stays in the list with an 编辑中 mark. */
  editingId?: number;
  /** 头行右侧的动作位（宿主放「回到最新」等悬浮按钮，避免压在栏身上）。 */
  headerSlot?: ReactNode;
  onEdit: (entry: QueuedMessage) => void;
  onSendNow: (entry: QueuedMessage) => void;
  onRemove: (entry: QueuedMessage) => void;
}) {
  const [open, setOpen] = useState(true);
  const { marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  if (messages.length === 0) return null;
  return (
    <div className={`queue-strip${open ? "" : " collapsed"}`} role="group" aria-label={zh ? "排队消息" : "Queued messages"}>
      <div className="qs-head-row">
        <button
          type="button"
          className="qs-head"
          aria-expanded={open}
          aria-label={open ? (zh ? "收起排队消息" : "Collapse queued messages") : (zh ? "展开排队消息" : "Expand queued messages")}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="queue" extra="sm" />
          <span className="qs-title">{zh ? "本地草稿" : "Local drafts"}</span>
          <span className="qs-count">{messages.length}</span>
          <span className="qs-note">{running ? (zh ? "本轮结束后自动按序发送" : "Sent in order after this turn") : (zh ? "空闲后自动发送" : "Sent automatically when idle")}</span>
          {demo === true && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
          <span className="qs-toggle" aria-hidden="true">
            <Icon name={open ? "chevron-d" : "chevron-u"} extra="sm" />
          </span>
        </button>
        {headerSlot !== undefined && headerSlot !== null ? <div className="qs-head-slot">{headerSlot}</div> : null}
      </div>
      <div className="qs-collapse" aria-hidden={!open} inert={open ? undefined : true}>
        <div className="qs-collapse-inner">
          <div className="qs-list" role="list">
            {messages.map((entry, index) => {
              const editing = editingId === entry.id;
              return (
                <div className={`qs-item${editing ? " editing" : ""}`} role="listitem" key={entry.id}>
                  <span className="qs-text">{entry.text}</span>
                  <span className="qs-status">
                    {editing ? <span className="qs-editing">{zh ? "编辑中" : "Editing"}</span> : null}
                    <span className="qs-actions">
                      <button
                        type="button"
                        className="icon-btn small"
                        data-tip={zh ? "编辑" : "Edit"}
                        aria-label={zh ? `编辑第 ${index + 1} 条排队消息` : `Edit queued message ${index + 1}`}
                        onClick={() => onEdit(entry)}
                      >
                        <Icon name="pencil" extra="sm" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn small"
                        disabled={!sendEnabled}
                        data-send-icon="arrow-u"
                        data-tip={running ? (zh ? "纠偏" : "Steer") : (zh ? "发送" : "Send")}
                        aria-label={running ? (zh ? `插入纠偏第 ${index + 1} 条排队消息` : `Steer queued message ${index + 1}`) : (zh ? `立刻发送第 ${index + 1} 条排队消息` : `Send queued message ${index + 1} now`)}
                        onClick={() => onSendNow(entry)}
                      >
                        <Icon name="arrow-u" extra="sm" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn small"
                        data-tip={zh ? "删除" : "Delete"}
                        aria-label={zh ? `删除第 ${index + 1} 条排队消息` : `Delete queued message ${index + 1}`}
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
