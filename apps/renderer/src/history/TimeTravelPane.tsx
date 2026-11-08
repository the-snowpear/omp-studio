import { useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionHistoryEntry,
  StudioClient,
  TimeTravelPoint,
  TimeTravelRestorePreview,
  TimeTravelRestoreResult,
  TimeTravelTimeline,
} from "@omp-studio/client-contract";
import { AppSelect } from "../AppSelect";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { TimeTravelDialog } from "./TimeTravelDialog";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { usePreviewMode } from "../preview/PreviewContext";
import { timeTravelPreview } from "../preview/timeTravelPreview";

type RestoreKind = "code" | "conversation" | "both";
type PendingRestore = {
  mode: RestoreKind;
  leafId: string | null;
  point?: TimeTravelPoint;
  preview?: TimeTravelRestorePreview;
};

export function TimeTravelPane({
  client,
  entry,
  onOpen,
}: {
  client?: StudioClient | undefined;
  entry?: SessionHistoryEntry | undefined;
  onOpen: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const target = useExecutionTarget();
  const syncState = target.inventory.statuses.find(
    (status) => status.id === target.id,
  )?.timeTravelSync;
  const [branch, setBranch] = useState<string>();
  const [timeline, setTimeline] = useState<TimeTravelTimeline>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<PendingRestore>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [feedback, setFeedback] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (preview) {
      setTimeline(timeTravelPreview.timeline);
      return;
    }
    if (!client || !entry?.sessionId) return;
    let live = true;
    setTimeline(undefined);
    setError(undefined);
    void client
      .query("timeTravel.timeline.read", {
        sessionId: entry.sessionId,
        ...(branch ? { branchLeafId: branch } : {}),
      })
      .then(
        (value) => {
          if (live) setTimeline(value);
        },
        (cause) => {
          if (live)
            setError(
              hostErrorMessage(
                cause,
                zh ? "无法读取时间线" : "Unable to read timeline",
              ),
            );
        },
      );
    return () => {
      live = false;
    };
  }, [client, entry?.sessionId, branch, revision, zh, syncState, preview]);

  const rows = useMemo(() => {
    const events = (timeline?.events ?? []).map((event) => ({
      type: "event" as const,
      time: event.createdAt,
      event,
    }));
    const points = (timeline?.points ?? []).map((point) => ({
      type: "point" as const,
      time: point.createdAt,
      point,
    }));
    return [...events, ...points].sort((a, b) => a.time.localeCompare(b.time));
  }, [timeline]);

  const requestRestore = async (
    mode: RestoreKind,
    leafId: string | null,
    point?: TimeTravelPoint,
  ) => {
    if ((!client && !preview) || !entry?.sessionId || busy) return;
    setError(undefined);
    if (mode === "conversation") {
      setPending({ mode, leafId });
      return;
    }
    if (!point) return;
    setBusy(true);
    try {
      const changes = preview
        ? timeTravelPreview.restorePreview(point.id)
        : await client!.query("timeTravel.restore.preview", {
            sessionId: entry.sessionId,
            snapshotId: point.id,
          });
      if (mounted.current)
        setPending({ mode, leafId, point, preview: changes });
    } catch (cause) {
      if (mounted.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "无法预览恢复" : "Unable to preview restore",
          ),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const restore = async () => {
    if (preview && pending) {
      setFeedback(
        marks
          ? zh
            ? "演示恢复完成，真实文件与对话未改变。"
            : "Demo restore complete. Real files and conversation are unchanged."
          : zh
            ? "恢复完成"
            : "Restored",
      );
      setPending(undefined);
      return;
    }
    if (!client || !entry?.sessionId || !pending || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const handle = await client.command("timeTravel.restore", {
        sessionId: entry.sessionId,
        leafId: pending.leafId,
        mode: pending.mode,
        ...(pending.point ? { snapshotId: pending.point.id } : {}),
        ...(pending.preview
          ? { expectedRevision: pending.preview.revision }
          : {}),
      });
      const result = await waitReceipt<TimeTravelRestoreResult>(
        client,
        handle.requestId,
        null,
      );
      if (!mounted.current) return;
      setPending(undefined);
      setRevision((value) => value + 1);
      if (result.error) {
        setError(result.error);
      } else if (pending.mode === "both" && !result.conversationRestored) {
        setError(
          zh
            ? "代码已恢复，但对话未恢复。恢复前备份已保留，可刷新时间线后重试。"
            : "Code was restored, but conversation was not. A backup is retained. Refresh the timeline to try again.",
        );
      } else if (result.conversationRestored) {
        window.dispatchEvent(
          new CustomEvent("omp-time-travel-restored", {
            detail: { sessionId: entry.sessionId },
          }),
        );
        onOpen();
      }
    } catch (cause) {
      if (mounted.current)
        setError(hostErrorMessage(cause, zh ? "恢复失败" : "Restore failed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const older = async () => {
    if (!client || !entry?.sessionId || !timeline?.olderCursor || busy) return;
    setBusy(true);
    try {
      const page = await client.query("timeTravel.timeline.read", {
        sessionId: entry.sessionId,
        ...(branch ? { branchLeafId: branch } : {}),
        cursor: timeline.olderCursor,
      });
      if (mounted.current)
        setTimeline({ ...page, events: [...page.events, ...timeline.events] });
    } catch (cause) {
      if (mounted.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "无法加载更早记录" : "Unable to load older events",
          ),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const archived = entry?.status === "archived";
  const formatTime = (time: string) =>
    new Date(time).toLocaleString(zh ? "zh-CN" : "en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const modeLabel = (mode: RestoreKind) =>
    mode === "code"
      ? zh
        ? "恢复代码"
        : "Restore code"
      : mode === "conversation"
        ? zh
          ? "恢复对话"
          : "Restore conversation"
        : zh
          ? "恢复代码与对话"
          : "Restore both";
  return (
    <section className="tt-pane" aria-labelledby="ttHeading" aria-busy={busy}>
      <header className="tt-pane-head">
        <div>
          <h2 id="ttHeading">Time Travel</h2>
          <p>
            {entry?.title ??
              (zh
                ? "选择会话，查看它的时间线"
                : "Select a session to view its timeline")}
          </p>
        </div>
        <button
          type="button"
          className="icon-btn small"
          aria-label={zh ? "刷新时间线" : "Refresh timeline"}
          disabled={busy || !entry?.sessionId}
          onClick={() => setRevision((value) => value + 1)}
        >
          <Icon name="refresh" extra="sm" />
        </button>
      </header>
      {preview && marks ? (
        <span className="chip purple xs">{zh ? "演示" : "Demo"}</span>
      ) : null}
      {feedback ? (
        <p className="tt-muted" role="status">
          {feedback}
        </p>
      ) : null}
      {error && !pending ? (
        <p className="tt-error" role="alert">
          {error}
        </p>
      ) : null}
      {!entry?.sessionId ? (
        <div className="tt-state">
          {zh
            ? "选择左侧会话的时间线按钮开始查看。"
            : "Choose a session's timeline button to get started."}
        </div>
      ) : !client && !preview ? (
        <div className="tt-state">
          {zh
            ? "连接执行环境后即可查看。"
            : "Connect to the execution host to view the timeline."}
        </div>
      ) : !timeline && !error ? (
        <div className="tt-state" role="status">
          {zh
            ? "正在读取会话记录与检查点…"
            : "Loading conversation and checkpoints…"}
        </div>
      ) : null}
      {timeline ? (
        <>
          {timeline.branches.length > 1 ? (
            <AppSelect
              className="select tt-branches"
              disabled={busy}
              aria-label={zh ? "会话分支" : "Session branch"}
              value={branch ?? timeline.activeLeafId ?? ""}
              onChange={(event) => setBranch(event.target.value)}
            >
              {timeline.branches.map((item) => (
                <option key={item.leafId} value={item.leafId}>
                  {item.current
                    ? zh
                      ? "当前分支 · "
                      : "Current branch · "
                    : zh
                      ? "历史分支 · "
                      : "Earlier branch · "}
                  {formatTime(item.createdAt)}
                </option>
              ))}
            </AppSelect>
          ) : null}
          {archived ? (
            <p className="tt-muted">
              {zh
                ? "此会话已归档。恢复对话前请先取消归档。"
                : "Unarchive this session before restoring its conversation."}
            </p>
          ) : null}
          {!timeline.points.length ? (
            <p className="tt-muted">
              {zh
                ? "此分支还没有代码检查点。开启后的新回合会自动记录；此前的代码无法补录。"
                : "No code checkpoints on this branch yet. Future turns will record them; earlier code cannot be recovered retroactively."}
            </p>
          ) : null}
          {timeline.olderCursor ? (
            <button
              type="button"
              className="btn small outline"
              disabled={busy}
              onClick={() => void older()}
            >
              {zh ? "加载更早记录" : "Load earlier"}
            </button>
          ) : null}
          {rows.length === 0 ? (
            <div className="tt-state">
              {zh ? "还没有可显示的记录" : "No events yet"}
            </div>
          ) : (
            <div className="tt-rail">
              {rows.map((row) =>
                row.type === "event" ? (
                  <div
                    className={`tt-node ${row.event.kind}`}
                    key={`event:${row.event.id}`}
                  >
                    <div className="tt-card">
                      <div className="tt-card-head">
                        <b>
                          {row.event.kind === "user"
                            ? zh
                              ? "用户请求"
                              : "User request"
                            : row.event.kind === "assistant" &&
                                row.event.title === "Assistant"
                              ? zh
                                ? "助手回复"
                                : "Assistant"
                              : row.event.title}
                        </b>
                        <time className="tiny mono" dateTime={row.time}>
                          {formatTime(row.time)}
                        </time>
                      </div>
                      {row.event.detail ? (
                        <div className="small muted tt-card-body tt-event-detail">
                          {row.event.detail}
                        </div>
                      ) : null}
                      {row.event.kind === "user" ||
                      (row.event.kind === "assistant" &&
                        row.event.title === "Assistant") ? (
                        <button
                          type="button"
                          className="btn small outline tt-event-restore"
                          disabled={busy || archived}
                          onClick={() =>
                            void requestRestore("conversation", row.event.id)
                          }
                        >
                          <Icon name="rewind" extra="sm" />
                          {zh ? "从这里恢复对话" : "Restore conversation here"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div
                    className="tt-node checkpoint"
                    key={`point:${row.point.id}`}
                  >
                    <div className="tt-card">
                      <div className="tt-card-head">
                        <b>
                          {row.point.phase === "before"
                            ? zh
                              ? "请求前检查点"
                              : "Before request"
                            : row.point.phase === "after"
                              ? zh
                                ? "回合结束检查点"
                                : "Turn completed"
                              : zh
                                ? "恢复前备份"
                                : "Before restore"}
                        </b>
                        <time className="tiny mono" dateTime={row.time}>
                          {formatTime(row.time)}
                        </time>
                      </div>
                      <div className="small muted tt-card-body">
                        {row.point.fileCount}{" "}
                        {zh ? "个文件已保存" : "files captured"} ·{" "}
                        <span>{zh ? "可恢复" : "Restorable"}</span>
                      </div>
                      {row.point.changes ? (
                        <div className="tt-muted">
                          {zh ? "较上一检查点" : "Since previous checkpoint"} ·
                          +{row.point.changes.added} / ~
                          {row.point.changes.modified} / −
                          {row.point.changes.deleted}
                        </div>
                      ) : null}
                      <div className="tt-actions">
                        <button
                          type="button"
                          className="btn small outline"
                          disabled={busy}
                          onClick={() =>
                            void requestRestore(
                              "code",
                              row.point.leafId,
                              row.point,
                            )
                          }
                        >
                          {modeLabel("code")}
                        </button>
                        <button
                          type="button"
                          className="btn small outline"
                          disabled={busy || archived}
                          onClick={() =>
                            void requestRestore(
                              "conversation",
                              row.point.leafId,
                              row.point,
                            )
                          }
                        >
                          {modeLabel("conversation")}
                        </button>
                        <button
                          type="button"
                          className="btn small primary"
                          disabled={busy || archived}
                          onClick={() =>
                            void requestRestore(
                              "both",
                              row.point.leafId,
                              row.point,
                            )
                          }
                        >
                          {zh ? "恢复两者" : "Restore both"}
                        </button>
                      </div>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      ) : null}
      {pending ? (
        <TimeTravelDialog
          title={modeLabel(pending.mode)}
          busy={busy}
          onClose={() => {
            setPending(undefined);
            setError(undefined);
          }}
          description={
            pending.mode === "conversation"
              ? zh
                ? "对话将切换到所选位置，后续内容仍保留在原分支中。"
                : "Move the conversation to this position. Later messages remain on their original branch."
              : zh
                ? "请核对将要更改的工作区文件。恢复前会自动保存一份备份。"
                : "Review the workspace changes below. Current files will be backed up before restoring."
          }
          actions={
            <>
              <button
                type="button"
                className="btn outline"
                disabled={busy}
                onClick={() => {
                  setPending(undefined);
                  setError(undefined);
                }}
              >
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void restore()}
              >
                {busy
                  ? zh
                    ? "正在恢复…"
                    : "Restoring…"
                  : modeLabel(pending.mode)}
              </button>
            </>
          }
        >
          {pending.preview ? (
            <>
              <div className="tt-change-summary">
                {(["add", "modify", "delete"] as const).map((kind) => (
                  <span key={kind}>
                    <b>
                      {
                        pending.preview!.changes.filter(
                          (change) => change.kind === kind,
                        ).length
                      }
                    </b>{" "}
                    {kind === "add"
                      ? zh
                        ? "新增"
                        : "added"
                      : kind === "delete"
                        ? zh
                          ? "删除"
                          : "deleted"
                        : zh
                          ? "覆盖"
                          : "overwritten"}
                  </span>
                ))}
              </div>
              {pending.preview.changes.length ? (
                <div className="tt-file-list">
                  {pending.preview.changes.map((change) => (
                    <div
                      className={`tt-file-row ${change.kind}`}
                      key={change.path}
                    >
                      <code>{change.path}</code>
                      <span>
                        {change.kind === "add"
                          ? zh
                            ? "新增"
                            : "Add"
                          : change.kind === "delete"
                            ? zh
                              ? "删除"
                              : "Delete"
                            : zh
                              ? "覆盖"
                              : "Overwrite"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="tt-muted">
                  {zh
                    ? "文件与检查点一致，无需修改。"
                    : "Files already match this checkpoint."}
                </p>
              )}
            </>
          ) : null}
          <div className="tt-note">
            <Icon
              name={pending.mode === "conversation" ? "branch" : "alert"}
              extra="sm"
            />
            <p>
              {pending.mode === "code"
                ? zh
                  ? "仅恢复代码，对话保持在当前位置。整个工作区都会受影响，请暂停其他会话与外部编辑。"
                  : "Only code is restored. Conversation stays at its current position. Pause other sessions and external edits in this workspace."
                : pending.mode === "both"
                  ? zh
                    ? "代码和对话都会恢复。整个工作区都会受影响，请暂停其他会话与外部编辑。"
                    : "Code and conversation will both be restored. Pause other sessions and external edits in this workspace."
                  : zh
                    ? "仅恢复对话，代码和外部操作保持现状，可能与历史消息中的状态不同。"
                    : "Only the conversation is restored. Files and external actions stay as they are and may differ from the historical messages."}
            </p>
          </div>
          {error ? (
            <p className="tt-error" role="alert">
              {error}
            </p>
          ) : null}
        </TimeTravelDialog>
      ) : null}
    </section>
  );
}
