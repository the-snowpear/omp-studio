import { useEffect, useMemo, useState } from "react";
import { ChangesPanel, type ChangesDiffFile, type ChangesTurnOption } from "./ChangesPanel";
import { useI18n } from "../i18n";
import type { TimelineRow } from "./conversationViewModel";
import {
  listSessionChangeTurns,
  sessionChangeScope,
  sessionChangeTurnIdForPath,
  SESSION_CHANGE_LAST_ID,
  SESSION_CHANGE_SESSION_ID,
} from "./toolMeta";

function deltaOf(files: readonly { add: number; del: number }[]): { add: number; del: number } {
  return files.reduce((sum, file) => ({ add: sum.add + file.add, del: sum.del + file.del }), { add: 0, del: 0 });
}

function toTurnOption(turn: { id: string; label: string; files: readonly { add: number; del: number }[] }): ChangesTurnOption {
  const delta = deltaOf(turn.files);
  return { id: turn.id, label: turn.label, add: delta.add, del: delta.del };
}

// TODO: sessionFilePatches removed — needs reimplementation
function fileDiff(path: string, add: number, del: number): ChangesDiffFile {
  return {
    file: path,
    add,
    del,
    hunks: [],
  };
}

function pathMatches(path: string, focus: string): boolean {
  const value = path.replaceAll("\\", "/");
  const normalized = focus.replaceAll("\\", "/");
  return value === normalized || value.endsWith(`/${normalized}`) || normalized.endsWith(`/${value}`);
}

/** 右侧 Changes 页签：本轮对话（transcript 工具调用）产生的文件改动。
    不是 Git 工作区状态——那是「Git 管理」页的职责。 */
export function SessionChanges({
  rows,
  focusPath,
  focusTurnId,
  focusKey,
}: {
  rows: readonly TimelineRow[];
  focusPath?: string;
  /** 对话 TurnDiffCard「审核」传入的轮次 id（与 `listSessionChangeTurns` 一致）。 */
  focusTurnId?: string;
  /** 同一轮再次审核时递增，避免被轮次菜单改过之后无法跳回。 */
  focusKey?: number;
}) {
  const { t } = useI18n();
  const turns = useMemo(() => listSessionChangeTurns(rows).map(toTurnOption), [rows]);
  const [turnId, setTurnId] = useState(SESSION_CHANGE_LAST_ID);
  const [split, setSplit] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const known = turns.some((turn) => turn.id === turnId);
  const activeId = known ? turnId : SESSION_CHANGE_LAST_ID;
  const scope = useMemo(() => sessionChangeScope(rows, activeId), [rows, activeId]);
  // TODO: sessionFilePatches removed — needs reimplementation

  useEffect(() => {
    if (known) return;
    setTurnId(SESSION_CHANGE_LAST_ID);
  }, [known]);

  useEffect(() => {
    if (focusTurnId === undefined) return;
    setTurnId(focusTurnId);
    setExpanded(new Set());
  }, [focusTurnId, focusKey]);

  useEffect(() => {
    if (focusTurnId !== undefined) return;
    if (focusPath === undefined) return;
    const nextTurn = sessionChangeTurnIdForPath(rows, focusPath) ?? SESSION_CHANGE_LAST_ID;
    const hit = sessionChangeScope(rows, nextTurn).files.find((file) => pathMatches(file.path, focusPath));
    setTurnId(nextTurn);
    setExpanded(hit === undefined ? new Set() : new Set([hit.path]));
  }, [focusPath, focusTurnId, rows]);

  const files: readonly ChangesDiffFile[] = scope.files.map((file) => fileDiff(file.path, file.add, file.del));
  const sessionHasFiles = turns.some((turn) => turn.id === SESSION_CHANGE_SESSION_ID && (turn.add > 0 || turn.del > 0));

  return (
    <ChangesPanel
      turns={turns}
      turnId={activeId}
      onTurnChange={(id) => {
        setTurnId(id);
        setExpanded(new Set());
      }}
      files={files}
      expanded={expanded}
      onToggle={(file) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(file)) next.delete(file);
          else next.add(file);
          return next;
        });
      }}
      split={split}
      onSplit={setSplit}
      empty={(
        <div className="empty" style={{ padding: 18 }}>
          {sessionHasFiles ? (
            <p>{t("changes.emptyTurnTitle")}</p>
          ) : (
            <>
              <p>{t("changes.emptySessionTitle")}</p>
              <p>{t("changes.emptySessionDetail")}</p>
            </>
          )}
        </div>
      )}
    />
  );
}
