import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import type { TimelineRow } from "./conversationViewModel";
import { sessionFileChanges, sessionFilePatches, type SessionPatchBlock, type TurnFileChange } from "./toolMeta";

const BLOCK_LABEL: Record<SessionPatchBlock["kind"], string> = {
  edit: "Edit",
  write: "Write",
  ast_edit: "AST Edit",
};

/** 右侧 Changes 页签：本轮对话（transcript 工具调用）产生的文件改动。
    不是 Git 工作区状态——那是「Git 管理」页的职责。 */
export function SessionChanges({ rows, focusPath }: { rows: readonly TimelineRow[]; focusPath?: string }) {
  const changes = useMemo(() => sessionFileChanges(rows), [rows]);
  const patches = useMemo(
    () => sessionFilePatches(rows.flatMap((row) => (row.type === "assistant" ? row.segments : []))),
    [rows],
  );
  const [selected, setSelected] = useState<string | null>(null);

  // TaskProgressDock / 顶栏带路径打开时，按归一化后缀匹配选中对应文件。
  useEffect(() => {
    if (focusPath === undefined) return;
    const normalized = focusPath.replaceAll("\\", "/");
    const matches = (path: string) => {
      const value = path.replaceAll("\\", "/");
      return value === normalized || value.endsWith(`/${normalized}`) || normalized.endsWith(`/${value}`);
    };
    const hit = changes.session.find((file) => matches(file.path));
    if (hit !== undefined) setSelected(hit.path);
  }, [focusPath, changes.session]);

  // 选中文件被后续回合移除、或尚未点选时，回退到第一个文件，面板不空转。
  const activePath = useMemo(() => {
    if (selected !== null && changes.session.some((file) => file.path === selected)) return selected;
    return changes.session[0]?.path ?? null;
  }, [selected, changes.session]);
  const activeBlocks = activePath === null ? [] : patches.get(activePath) ?? [];

  const sessionAdd = changes.session.reduce((sum, file) => sum + file.add, 0);
  const sessionDel = changes.session.reduce((sum, file) => sum + file.del, 0);

  const group = (title: string, files: readonly TurnFileChange[]) => (
    <div className="ch-group">
      <div className="ch-group-title">{title}<span className="ch-count">{files.length}</span></div>
      {files.map((file) => (
        <div className={`git-change-line${activePath === file.path ? " selected" : ""}`} key={file.path}>
          <button type="button" className="ch-row" aria-label={`查看 ${file.path} 的会话改动`} onClick={() => setSelected(file.path)}>
            <span className="ch-file ellipsis" title={file.path}>{file.path}</span>
            <span className="ch-delta">
              {file.add ? <span className="ch-add">+{file.add}</span> : null}
              {file.del ? <span className="ch-del">−{file.del}</span> : null}
            </span>
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <div className="git-notice" role="status">
        来自本轮对话的工具调用（Edit / Write / AST Edit），非 Git 工作区状态。
        {changes.session.length ? ` 会话累计 +${sessionAdd} / −${sessionDel}。` : ""}
      </div>
      <div className="ch-list">
        {changes.session.length === 0 ? (
          <div className="empty" style={{ padding: 18 }}>
            <p>本会话还没有文件改动。</p>
            <p>Agent 修改文件后，这里按对话记录汇总每个文件的增删。</p>
          </div>
        ) : (
          <>
            {changes.turn.length > 0 ? group("当前 Turn", changes.turn) : null}
            {group("本会话累积", changes.session)}
          </>
        )}
      </div>
      {activePath !== null ? (
        <div className="ch-diff-slot">
          <div className="diff-toolbar">
            <Icon name="file-code" extra="sm" />
            <span className="mono small ellipsis">{activePath}</span>
            {activeBlocks.some((block) => block.truncated) ? <span className="chip gray xs">部分截断</span> : null}
          </div>
          <div className="diff-scroll">
            {activeBlocks.map((block, index) => (
              <div key={`${block.kind}-${index}`}>
                <div className="diff-head-row">@@ {BLOCK_LABEL[block.kind]} · 第 {index + 1}/{activeBlocks.length} 段 @@</div>
                {block.lines.map((line, lineIndex) => {
                  const tone = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
                  const mark = tone === "add" ? "+" : tone === "del" ? "−" : " ";
                  return (
                    <div key={lineIndex} className={`dl ${tone}`}>
                      <span className="dm" aria-hidden="true">{mark}</span>
                      <span className="lc">{line.slice(1)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
