import type {
  NativeArchiveSession,
  NativeArchiveText,
  NativeArchiveDetail,
} from "@omp-studio/studio-protocol";
export function previewArchiveSessions(): NativeArchiveSession[] {
  return [
    {
      id: "demo-archive-queue",
      title: "完善消息队列的图片恢复",
      project: "omp-studio",
      created: "2026-10-07T08:30:00.000Z",
      modified: "2026-10-08T00:40:00.000Z",
      messages: 36,
      status: "complete",
      recap: "已完成排队与纠偏回归。下一步检查窗口切换后的附件保留。",
      truncated: false,
    },
    {
      id: "demo-archive-browser",
      title: "检查浏览器观察与人工接管",
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
): NativeArchiveText[] {
  const rows: NativeArchiveText[] = [
    {
      text:
        view === "recaps"
          ? "队列恢复和图片附件已验证。仍需检查断连期间的实际状态。"
          : "请检查消息队列恢复后是否保留图片。",
      at: "2026-10-08T00:40:00.000Z",
      sessionId: "demo-archive-queue",
      project: "omp-studio",
      ...(view === "prompts" ? { uses: 2 } : {}),
      truncated: false,
    },
    {
      text:
        view === "recaps"
          ? "浏览器观察已接入同一原生目标，等待多会话验收。"
          : "检查浏览器人工接管和租约释放。",
      at: "2026-10-07T12:00:00.000Z",
      sessionId: "demo-archive-browser",
      project: "omp-studio",
      truncated: false,
    },
  ];
  return rows.filter(
    (row) => !query || row.text.toLowerCase().includes(query.toLowerCase()),
  );
}
export function previewArchiveDetail(id: string): NativeArchiveDetail {
  return {
    session:
      previewArchiveSessions().find((row) => row.id === id) ??
      previewArchiveSessions()[0]!,
    recaps: previewArchiveTexts("recaps").filter((row) => row.sessionId === id),
    prompts: previewArchiveTexts("prompts").filter(
      (row) => row.sessionId === id,
    ),
    truncated: false,
  };
}
