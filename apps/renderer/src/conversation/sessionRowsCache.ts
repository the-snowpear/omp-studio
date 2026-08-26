/** Compatibility facade; storage is owned by the bounded session conversation cache. */
import type { TimelineRow } from "./conversationViewModel";
import {
  clearSessionConversationCache,
  forgetSessionConversation,
  recallSessionConversation,
  rememberSessionConversation,
} from "./sessionConversationCache";

/** 记住某会话当前渲染的行；重复写入会刷新 LRU 顺序。 */
export function rememberSessionRows(sessionId: string, rows: readonly TimelineRow[]): void {
  rememberSessionConversation(sessionId, rows);
}

/** 取回某会话上次渲染的行；命中同样刷新 LRU 顺序。 */
export function recallSessionRows(sessionId: string | undefined): readonly TimelineRow[] | undefined {
  return recallSessionConversation(sessionId)?.rows;
}

/** 会话被删除 / 归档 / 分支改写后丢弃缓存，避免画出已经不存在的历史。 */
export function forgetSessionRows(sessionId: string): void {
  forgetSessionConversation(sessionId);
}

/** 测试用：清空整个缓存。 */
export function clearSessionRowsCache(): void {
  clearSessionConversationCache();
}
