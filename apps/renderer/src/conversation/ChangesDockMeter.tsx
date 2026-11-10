import { useMemo } from "react";
import { DockPanelMeter, type PanelStatusCount, type PanelStatusMeter } from "../dock/panelMeters";
import { useI18n } from "../i18n";
import { PREVIEW_CHANGES } from "../preview/fixtures";
import { usePreviewMode } from "../preview/PreviewContext";
import type { TimelineRow } from "./conversationViewModel";
import { listSessionChangeTurns, SESSION_CHANGE_LAST_ID, type TurnFileChange } from "./toolMeta";

type ChangeRow = Pick<TurnFileChange, "path" | "add" | "del">;

export type ChangesDockMeterInput = {
  /** 与面板默认口径一致：最近一轮的改动文件。 */
  files: readonly ChangeRow[];
  preview: boolean;
  marks: boolean;
  zh: boolean;
};

/** 折叠的 Changes 卡显示最近一轮的行数增减，展开后仍是逐文件 diff。 */
export function buildChangesDockMeter({ files, preview, marks, zh }: ChangesDockMeterInput): PanelStatusMeter {
  const add = files.reduce((sum, file) => sum + file.add, 0);
  const del = files.reduce((sum, file) => sum + file.del, 0);
  const demo = preview && marks ? (zh ? "演示" : "Demo") : "";
  const emptyLabel = zh ? "本轮无改动" : "No changes";
  const counts: PanelStatusCount[] = add > 0 || del > 0
    ? [
        ...(add > 0 ? [{ id: "add", count: add, color: "var(--green)", label: "", prefix: "+" }] : []),
        ...(del > 0 ? [{ id: "del", count: del, color: "var(--red)", label: "", prefix: "−" }] : []),
      ]
    : files.length > 0
      // 只有二进制/重命名这类没有行数的改动时，退回文件数，别显示成「无改动」。
      ? [{ id: "files", count: files.length, color: "var(--text-3)", label: zh ? "个文件" : "files" }]
      : [];
  const fileCount = files.length === 0 ? emptyLabel : zh ? `${files.length} 个文件` : `${files.length} ${files.length === 1 ? "file" : "files"}`;
  const delta = add > 0 || del > 0 ? `${add > 0 ? `+${add}` : ""}${add > 0 && del > 0 ? " " : ""}${del > 0 ? `−${del}` : ""}` : undefined;
  const label = [fileCount, delta, demo].filter(Boolean).join(" · ");
  const rows = files.slice(0, 8).map(file => `${file.path}${file.add > 0 ? ` +${file.add}` : ""}${file.del > 0 ? ` −${file.del}` : ""}`);
  return {
    kind: "status", total: add + del || files.length, counts, emptyLabel, stale: false,
    tone: "normal", label,
    badge: files.length,
    ...(delta === undefined ? {} : { note: fileCount }),
    detail: [
      `${zh ? "最近一轮" : "Latest turn"} · ${label}`,
      ...rows,
      files.length > rows.length ? "…" : undefined,
    ].filter(Boolean).join("\n"),
  };
}

/** 挂在对话区：折叠卡不挂载 Changes 正文，摘要直接读会话时间线。 */
export function ChangesDockMeter({ rows }: { rows: readonly TimelineRow[] }) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const files = useMemo<readonly ChangeRow[]>(() => preview
    ? PREVIEW_CHANGES.turn.map(row => ({ path: row.file, add: row.add, del: row.del }))
    : listSessionChangeTurns(rows).find(turn => turn.id === SESSION_CHANGE_LAST_ID)?.files ?? [],
  [preview, rows]);
  const meter = useMemo(() => buildChangesDockMeter({ files, preview, marks, zh }), [files, preview, marks, zh]);
  return <DockPanelMeter id="changes" value={meter} />;
}
