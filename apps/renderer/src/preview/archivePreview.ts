import type {
  NativeArchiveSession,
  NativeArchiveText,
  NativeArchiveDetail,
} from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function previewArchiveSessions(zh = isZh()): NativeArchiveSession[] {
  return [
    {
      id: "sess-7c2e91",
      title: zh ? "完善消息队列的图片恢复" : "Fix image recovery in message queue",
      project: "omp-studio",
      created: "2026-10-07T08:30:00.000Z",
      modified: "2026-10-08T00:40:00.000Z",
      messages: 36,
      status: "complete",
      recap: zh ? "已完成排队与纠偏回归。下一步检查窗口切换后的附件保留。" : "Completed queue & steering regression checks. Next: verify attachment retention after switching panes.",
      truncated: false,
    },
    {
      id: "sess-4a8f20",
      title: zh ? "检查浏览器观察与人工接管" : "Verify browser observation & manual handoff",
      project: "omp-studio",
      created: "2026-10-07T09:00:00.000Z",
      modified: "2026-10-07T12:00:00.000Z",
      messages: 18,
      status: "interrupted",
      truncated: false,
    },
  ];
}
export function previewArchiveTexts(
  view: string,
  query = "",
  zh = isZh(),
): NativeArchiveText[] {
  const rows: NativeArchiveText[] = [
    {
      text:
        view === "recaps"
          ? zh ? "队列恢复和图片附件已验证。仍需检查断连期间的实际状态。" : "Queue recovery and image attachments verified. Still need to check state during disconnects."
          : zh ? "请检查消息队列恢复后是否保留图片。" : "Verify whether images are preserved after queue recovery.",
      at: "2026-10-08T00:40:00.000Z",
      sessionId: "sess-7c2e91",
      project: "omp-studio",
      ...(view === "prompts" ? { uses: 2 } : {}),
      truncated: false,
    },
    {
      text:
        view === "recaps"
          ? zh ? "浏览器观察已接入同一原生目标，等待多会话验收。" : "Browser observation wired to the same native target; awaiting multi-session verification."
          : zh ? "检查浏览器人工接管和租约释放。" : "Check browser manual handoff and lease release.",
      at: "2026-10-07T12:00:00.000Z",
      sessionId: "sess-4a8f20",
      project: "omp-studio",
      truncated: false,
    },
  ];
  return rows.filter(
    (row) => !query || row.text.toLowerCase().includes(query.toLowerCase()),
  );
}
export function previewArchiveDetail(id: string, zh = isZh()): NativeArchiveDetail {
  const sessions = previewArchiveSessions(zh);
  return {
    session:
      sessions.find((row) => row.id === id) ??
      sessions[0]!,
    recaps: previewArchiveTexts("recaps", "", zh).filter((row) => row.sessionId === id),
    prompts: previewArchiveTexts("prompts", "", zh).filter(
      (row) => row.sessionId === id,
    ),
    truncated: false,
  };
}
