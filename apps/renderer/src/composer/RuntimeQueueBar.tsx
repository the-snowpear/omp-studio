import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  CommandInput,
  StudioClient,
} from "@omp-studio/client-contract";
import type {
  RuntimeQueueEntry,
  RuntimeQueueResult,
  RuntimeQueueResultMap,
} from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { runtimeQueuePreview } from "../preview/runtimeQueuePreview";
import "./runtimeQueue.css";
export function RuntimeQueueBar({
  client,
  sessionId,
  capabilities,
  available,
  pending,
  running,
  showDemo = true,
}: {
  client: StudioClient;
  sessionId?: string | undefined;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  available: boolean;
  pending: number;
  running: boolean;
  showDemo?: boolean;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const prevZhRef = useRef(zh);
  const [result, setResult] = useState<RuntimeQueueResult>({
    entries: [],
    total: 0,
    truncated: false,
  });
  const [editing, setEditing] = useState<{
    entry: RuntimeQueueEntry;
    text: string;
  }>();
  const [error, setError] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const [focusEntry, setFocusEntry] = useState<string>();
  useEffect(() => {
    if (!focusEntry) return;
    const row = [
      ...(host.current?.querySelectorAll<HTMLElement>("[data-queue-id]") ?? []),
    ].find((node) => node.dataset.queueId === focusEntry);
    row?.scrollIntoView?.({ block: "nearest" });
    setFocusEntry(undefined);
  }, [result, focusEntry]);
  const epoch = useRef(0);
  const locked = useRef(false);
  const dirtyRef = useRef(false);
  const refreshRef = useRef<(() => void) | undefined>(undefined);
  const can = (kind: string) =>
    preview ||
    !!(
      available &&
      sessionId &&
      capabilities?.capabilities.some(
        (row) => row.id === kind && row.grade !== "unavailable",
      )
    );
  const supported = can("session.queue.get");
  const hasCompaction = !!result.compactionMode || result.entries.some(entry => entry.kind === "compaction");
  async function invoke<K extends keyof RuntimeQueueResultMap>(
    kind: K,
    input: CommandInput<K>,
  ): Promise<RuntimeQueueResult> {
    const handle = await client.command(kind, input);
    return (
      await waitReceipt<{ result: RuntimeQueueResult }>(
        client,
        handle.requestId,
      )
    ).result;
  }
  const showRefreshIssue = refreshFailed && (pending > 0 || result.entries.length > 0);
  useEffect(() => {
    epoch.current++;
    locked.current = false;
    dirtyRef.current = false;
    setBusy(false);
    setError("");
    setRefreshFailed(false);
    setEditing(undefined);
    setResult(
      preview && showDemo
        ? runtimeQueuePreview(zhRef.current)
        : { entries: [], total: 0, truncated: false },
    );
    return () => {
      epoch.current++;
    };
  }, [client, sessionId, preview, showDemo]);
  useEffect(() => {
    if (prevZhRef.current === zh) return;
    const oldZh = prevZhRef.current;
    prevZhRef.current = zh;
    if (!preview || !showDemo) return;
    const prevDefaults = new Map(runtimeQueuePreview(oldZh).entries.map((entry) => [entry.id, entry.text]));
    const nextDefaults = new Map(runtimeQueuePreview(zh).entries.map((entry) => [entry.id, entry.text]));
    setResult((current) => ({
      ...current,
      entries: current.entries.map((entry) => {
        const prevText = prevDefaults.get(entry.id);
        const nextText = nextDefaults.get(entry.id);
        return nextText !== undefined && entry.text === prevText
          ? { ...entry, text: nextText }
          : entry;
      }),
    }));
    setEditing((current) => {
      if (!current) return current;
      const prevText = prevDefaults.get(current.entry.id);
      const nextText = nextDefaults.get(current.entry.id);
      if (nextText === undefined || current.entry.text !== prevText) return current;
      return {
        entry: { ...current.entry, text: nextText },
        text: current.text,
      };
    });
  }, [preview, showDemo, zh]);
  useEffect(() => {
    if (preview || !supported) {
      refreshRef.current = undefined;
      return;
    }
    let active = true;
    let reading = false;
    async function refresh() {
      if (document.hidden || reading) return;
      if (locked.current) {
        dirtyRef.current = true;
        return;
      }
      reading = true;
      dirtyRef.current = false;
      const current = epoch.current;
      try {
        const next = await invoke("session.queue.get", {
          sessionId: sessionId!,
        });
        if (active && current === epoch.current && !locked.current) {
          setRefreshFailed(false);
          setResult(next);
        }
      } catch {
        if (active && current === epoch.current && !locked.current)
          setRefreshFailed(true);
      } finally {
        reading = false;
        if (active && dirtyRef.current && !locked.current && !document.hidden) {
          void refresh();
        }
      }
    }
    refreshRef.current = () => { void refresh(); };
    void refresh();
    const timer =
      running || pending > 0 || hasCompaction
        ? setInterval(() => void refresh(), 1500)
        : undefined;
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      if (refreshRef.current) refreshRef.current = undefined;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, sessionId, preview, supported, running, pending, hasCompaction]);
  useEffect(() => {
    if (preview || !supported || !showRefreshIssue || running || pending > 0 || hasCompaction) return;
    const retry = setInterval(() => refreshRef.current?.(), 1500);
    return () => clearInterval(retry);
  }, [preview, supported, showRefreshIssue, running, pending, hasCompaction]);
  async function act(
    kind:
      | "session.queue.edit"
      | "session.queue.entry.remove"
      | "session.queue.promote"
      | "session.queue.restore",
    entry: RuntimeQueueEntry,
  ) {
    if (locked.current || !can(kind)) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const current = ++epoch.current;
    try {
      let next: RuntimeQueueResult;
      if (preview) {
        const entries = result.entries.flatMap((row) =>
          row.id !== entry.id
            ? [row]
            : kind === "session.queue.entry.remove"
              ? []
              : [
                  {
                    ...row,
                    ...(kind === "session.queue.edit"
                      ? { text: editing!.text }
                      : kind === "session.queue.restore"
                        ? { state: "queued" as const }
                        : { queue: "steering" as const }),
                  },
                ],
        );
        const restored = entry.kind === "compaction" && kind === "session.queue.entry.remove" ? entries.map(row => { const { heldFor, ...rest } = row; return heldFor === "compaction" ? { ...rest, state: "queued" as const } : row; }) : entries;
        next = { entries: restored, total: restored.length, truncated: false };
      } else {
        const common = {
          sessionId: sessionId!,
          id: entry.id,
          queue: entry.queue,
        };
        next =
          kind === "session.queue.edit"
            ? await invoke(kind, {
                ...common,
                expectedText: entry.text,
                text: editing!.text,
              })
            : await invoke(kind, common);
      }
      if (current === epoch.current) {
        setResult(next);
        if (kind !== "session.queue.entry.remove") setFocusEntry(entry.id);
        setEditing(undefined);
      }
    } catch (cause) {
      if (current === epoch.current)
        setError(
          hostErrorMessage(
            cause,
            zh
              ? "操作未确认，请刷新队列后检查。不会自动重发消息。"
              : "Outcome unconfirmed. Refresh the queue; messages will not be resent.",
          ),
        );
    } finally {
      if (current === epoch.current) {
        locked.current = false;
        setBusy(false);
        if (!preview && dirtyRef.current) {
          dirtyRef.current = false;
          refreshRef.current?.();
        }
      }
    }
  }
  const orphanedDraft =
    editing && !result.entries.some((entry) => entry.id === editing.entry.id) ? (
      <div className="runtime-queue-editor">
        <p role="status">
          {zh
            ? "消息已离开队列，未发送此草稿。"
            : "The message left the queue. This draft has not been sent."}
        </p>
        <textarea
          className="input"
          readOnly
          aria-label={zh ? "未发送的编辑草稿" : "Unsent edit draft"}
          value={editing.text}
        />
        <button
          type="button"
          className="btn small"
          onClick={() => setEditing(undefined)}
        >
          {zh ? "关闭" : "Close"}
        </button>
      </div>
    ) : null;
  if (!supported || (!result.entries.length && !result.compactionMode && !error && !result.compactionError && !showRefreshIssue && !editing)) return null;
  return (
    <div
      ref={host}
      className="queue-strip runtime-queue"
      role="group"
      aria-label={zh ? "已提交 Runtime 的消息" : "Submitted Runtime messages"}
    >
      <div className="qs-head-row">
        <button
          className="qs-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name="queue" extra="sm" />
          <span className="qs-title">{zh ? "已提交" : "Submitted"}</span>
          <span className="qs-count">{result.total}</span>
          <span className="qs-note">
            {zh ? "由 Runtime 排队和执行" : "Queued and executed by Runtime"}
          </span>
          {preview && marks ? (
            <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
          ) : null}
          <span className="qs-toggle" aria-hidden="true">
            <Icon name={open ? "chevron-d" : "chevron-u"} extra="sm" />
          </span>
        </button>
      </div>
      {result.compactionMode === "handoff" && <div className="runtime-handoff" role="status">
        <span className="runtime-handoff-glyph" aria-hidden><Icon name="handoff" extra="sm" /></span>
        <span className="runtime-handoff-copy">
          <span className="runtime-handoff-title">{zh ? "正在后台生成交接摘要…" : "Preparing handoff in the background…"}</span>
          <span className="runtime-handoff-note">{zh ? "可继续阅读和发送消息，完成后切换到交接后的上下文" : "Keep reading and sending. The handed-off context takes over when it is ready."}</span>
        </span>
        <button className="btn small ghost runtime-handoff-cancel" disabled={busy || !can("session.compaction.cancel")} onClick={async () => {
          const generation = ++epoch.current;
          setBusy(true);
          try {
            const next = preview ? { entries: result.entries.filter(row => row.kind !== "compaction").map(({ heldFor, ...row }) => heldFor ? { ...row, state: "queued" as const } : row), total: result.total - 1, truncated: false } : await invoke("session.compaction.cancel", { sessionId: sessionId! });
            if (generation === epoch.current) setResult(next);
          } catch (cause) {
            if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "无法取消交接" : "Could not cancel handoff"));
          } finally { if (generation === epoch.current) setBusy(false); }
        }}>{zh ? "取消交接" : "Cancel handoff"}</button>
      </div>}
      {error || result.compactionError ? <p role="alert">{error || result.compactionError}</p> : showRefreshIssue ? (
        <p role="status">{zh ? "暂时无法刷新已提交队列" : "Could not refresh submitted messages"}</p>
      ) : null}
      {open ? (
        <div className="qs-list">
          {result.entries.map((entry) => (
            <div
              className="runtime-queue-row"
              key={entry.id}
              data-queue-id={entry.id}
            >
              <div className="qs-item">
                <span className="qs-text">{entry.text}</span>
                <span className="qs-status">
                  {entry.imageCount ? (
                    <span>
                      {entry.imageCount} {zh ? "张图片" : "images"}
                    </span>
                  ) : null}
                  <span>
                    {entry.kind === "compaction" ? zh ? "压缩任务" : "Compaction" : entry.heldFor === "compaction" ? zh ? "等待压缩" : "Waiting for compaction" : entry.state === "held"
                      ? zh
                        ? "中止后保留"
                        : "Held after stop"
                      : entry.state === "inFlight"
                        ? zh
                          ? "交付中"
                          : "Delivering"
                        : entry.queue === "steering"
                          ? zh
                            ? "纠偏"
                            : "Steering"
                          : zh
                            ? "下一轮"
                            : "Next turn"}
                  </span>
                  <span className="qs-actions">
                    {entry.state === "held" ? (
                      <button
                        className="btn small outline"
                        disabled={busy || hasCompaction || !can("session.queue.restore")}
                        onClick={() => void act("session.queue.restore", entry)}
                      >
                        {zh ? "恢复排队" : "Restore to queue"}
                      </button>
                    ) : null}
                    <button
                      className="icon-btn small"
                      aria-label={
                        zh ? "编辑已提交消息" : "Edit submitted message"
                      }
                      disabled={
                        busy || !entry.editable || !can("session.queue.edit")
                      }
                      onClick={() => setEditing({ entry, text: entry.text })}
                    >
                      <Icon name="pencil" extra="sm" />
                    </button>
                    <button
                      className="icon-btn small"
                      aria-label={zh ? "提升为纠偏" : "Promote to steering"}
                      disabled={
                        busy ||
                        entry.kind === "compaction" ||
                        entry.state !== "queued" ||
                        entry.queue !== "followUp" ||
                        !can("session.queue.promote")
                      }
                      onClick={() => void act("session.queue.promote", entry)}
                    >
                      <Icon name="arrow-u" extra="sm" />
                    </button>
                    <button
                      className="icon-btn small"
                      aria-label={
                        zh ? "删除已提交消息" : "Remove submitted message"
                      }
                      disabled={
                        busy ||
                        (entry.state === "inFlight" && entry.kind !== "compaction") ||
                        !can("session.queue.entry.remove")
                      }
                      onClick={() => void act("session.queue.entry.remove", entry)}
                    >
                      <Icon name="trash" extra="sm" />
                    </button>
                  </span>
                </span>
              </div>
              {editing?.entry.id === entry.id ? (
                <form
                  className="runtime-queue-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act("session.queue.edit", editing.entry);
                  }}
                >
                  <textarea
                    className="input"
                    maxLength={32768}
                    aria-label={zh ? "消息内容" : "Message text"}
                    value={editing.text}
                    onChange={(event) =>
                      setEditing({ ...editing, text: event.target.value })
                    }
                  />
                  <p className="small muted">
                    {zh
                      ? "修改已准备的正文，保留图片与附件上下文；不重新执行模板或命令。交付后编辑会被拒绝。"
                      : "Edit prepared text while preserving images and attachment context. Templates and commands are not rerun. Delivered messages cannot be edited."}
                  </p>
                  <button
                    className="btn small primary"
                    disabled={busy || !editing.text.trim()}
                  >
                    {zh ? "保存编辑" : "Save edit"}
                  </button>
                  <button
                    className="btn small outline"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(undefined)}
                  >
                    {zh ? "取消" : "Cancel"}
                  </button>
                </form>
              ) : null}
            </div>
          ))}
          {orphanedDraft}
        </div>
      ) : orphanedDraft ? (
        <div className="qs-list">{orphanedDraft}</div>
      ) : null}
      {result.truncated ? (
        <p className="small muted">
          {zh
            ? "队列较长，仅显示有界摘要。"
            : "A bounded summary is shown for this long queue."}
        </p>
      ) : null}
    </div>
  );
}
