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
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
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
  useEffect(() => {
    epoch.current++;
    locked.current = false;
    setBusy(false);
    setError("");
    setEditing(undefined);
    setResult(
      preview && showDemo
        ? runtimeQueuePreview()
        : { entries: [], total: 0, truncated: false },
    );
    return () => {
      epoch.current++;
    };
  }, [client, sessionId, preview, showDemo]);
  useEffect(() => {
    if (preview || !supported) return;
    let active = true;
    let reading = false;
    async function refresh() {
      if (document.hidden || reading || locked.current) return;
      reading = true;
      const current = epoch.current;
      try {
        const next = await invoke("session.queue.get", {
          sessionId: sessionId!,
        });
        if (active && current === epoch.current && !locked.current)
          setResult(next);
      } catch (cause) {
        if (active && current === epoch.current)
          setError(
            hostErrorMessage(
              cause,
              zh ? "无法读取已提交队列" : "Cannot read submitted messages",
            ),
          );
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer =
      running || pending > 0
        ? setInterval(() => void refresh(), 1500)
        : undefined;
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, sessionId, preview, supported, running, pending]);
  async function act(
    kind:
      | "session.queue.edit"
      | "session.queue.remove"
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
            : kind === "session.queue.remove"
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
        next = { entries, total: entries.length, truncated: false };
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
        if (kind !== "session.queue.remove") setFocusEntry(entry.id);
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
      }
    }
  }
  if (!supported || (!result.entries.length && !error && !editing)) return null;
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
          <span className="qs-title">
            {zh ? "已提交" : "Submitted"} ×{result.total}
          </span>
          <span className="qs-note">
            {zh ? "由 Runtime 排队和执行" : "Queued and executed by Runtime"}
          </span>
          {preview ? (
            <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
          ) : null}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
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
                    {entry.state === "held"
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
                        disabled={busy || !can("session.queue.restore")}
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
                        entry.state === "inFlight" ||
                        !can("session.queue.remove")
                      }
                      onClick={() => void act("session.queue.remove", entry)}
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
          {editing &&
          !result.entries.some((entry) => entry.id === editing.entry.id) ? (
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
                className="btn small"
                onClick={() => setEditing(undefined)}
              >
                {zh ? "关闭" : "Close"}
              </button>
            </div>
          ) : null}
        </div>
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
