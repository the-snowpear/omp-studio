import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { StudioClientImpl } from "@omp-studio/client";
import type { CommandInput, CommandName, SessionHistoryEntry, SessionId } from "@omp-studio/client-contract";
import { BrowserWebClientTransport, type MobileBrowserSession, type WebSocketLike } from "@omp-studio/transport-web/browser";
import { I18nProvider, useI18n } from "../i18n";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { getPreviewMobileApproval, getPreviewMobileChats } from "../preview/fixtures";
import { approvalFromInteraction } from "../deck/approvalContent";
import { createConversationEngine } from "../conversation/conversationEngine";
import { previewConversationItems } from "../preview/conversationFixtures";
import { MarkdownText } from "../conversation/markdown";
import { timelineRowKey, type ToolView } from "../conversation/conversationViewModel";
import { waitReceipt } from "../hostError";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "./mobile.css";

type Thread = SessionHistoryEntry & { sessionId: SessionId };
type Status = "loading" | "pairing" | "offline" | "ready";
type SocketLost = { current: (() => void) | undefined };
/** What a list row needs; real rows carry their thread, preview rows do not. */
type ChatRow = { key: string; title?: string | undefined; summary?: string | undefined; lastActiveAt: string; messageCount: number; pinned?: boolean | undefined; thread?: Thread };

const DAY = 86_400_000;

/**
 * Keeps the shell the size of what is actually visible. iOS Safari ignores
 * `interactive-widget` and slides the page under the keyboard instead of
 * resizing it, so the shell follows `visualViewport` and the composer stays on
 * top of the keyboard. "Keyboard open" is the visible height dropping well
 * below the tallest height seen at this width.
 */
function useVisibleViewport(): boolean {
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let tallest = 0, width = 0;
    const update = () => {
      if (viewport.width !== width) { width = viewport.width; tallest = 0; }
      tallest = Math.max(tallest, viewport.height);
      root.style.setProperty("--mobile-vh", `${viewport.height}px`);
      root.style.setProperty("--mobile-top", `${viewport.offsetTop}px`);
      setKeyboard(tallest - viewport.height > 120);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return keyboard;
}

function MobileApp() {
  const { resolvedLanguage, setLanguage } = useI18n();
  const { preview, marks } = usePreviewMode();
  const zh = resolvedLanguage === "zh";
  const keyboard = useVisibleViewport();
  const [status, setStatus] = useState<Status>("loading");
  const [session, setSession] = useState<MobileBrowserSession>();
  const [rows, setRows] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread>();
  const [demoChat, setDemoChat] = useState<ChatRow>();
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const lost = useRef<(() => void) | undefined>(undefined);
  const drafts = useRef(new Map<string, string>());
  const [pairCode] = useState(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const code = params.get("pair");
    if (code !== null) history.replaceState(null, "", location.pathname + location.search);
    return code;
  });
  // The phone page has no settings of its own: it follows the system theme, live.
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", query.matches ? "dark" : "light");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  const transport = useMemo(() => new BrowserWebClientTransport({
    baseUrl: location.origin,
    webSocketFactory: url => new WebSocket(url) as unknown as WebSocketLike,
    mobile: { onDisconnect: () => lost.current?.() },
  }), []);

  useEffect(() => {
    if (preview) return;
    let current = true;
    async function load() {
      try {
        if (pairCode && attempt === 0) await transport.pair(pairCode);
        const authenticated = await transport.restoreSession();
        const result = await transport.query({ queryName: "history.list", input: {} });
        if (!result.ok) throw new Error("history_unavailable");
        if (!current) return;
        setSession(authenticated);
        setRows(result.result.entries.filter((entry): entry is Thread => entry.sessionId !== undefined));
        setStatus("ready");
      } catch (error) {
        if (!current) return;
        setStatus(error instanceof Error && /^(pair_failed|http_401|http_403)$/.test(error.message) ? "pairing" : "offline");
      } finally {
        if (current) setRefreshing(false);
      }
    }
    void load();
    return () => { current = false; };
  }, [attempt, pairCode, preview, transport]);

  const toggleLanguage = <button className="m-round" type="button" aria-label={zh ? "切换到英文" : "Switch to Chinese"} onClick={() => setLanguage(zh ? "en" : "zh")}>{zh ? "EN" : "中文"}</button>;
  const retry = () => { setStatus("loading"); setAttempt(count => count + 1); };
  const shellClass = `mobile-shell${keyboard ? " is-keyboard" : ""}`;

  if (preview) {
    return <div className={shellClass}>
      {demoChat
        ? <MobileThreadView key={demoChat.key} title={demoChat.title ?? (zh ? "未命名会话" : "Untitled chat")} keyboard={keyboard} onBack={() => setDemoChat(undefined)} demo marks={marks} drafts={drafts.current} draftKey={demoChat.key} />
        : <ChatList workspaceName="omp-studio" connection="connected" rows={getPreviewMobileChats(zh)} demo={marks} language={toggleLanguage} onOpen={setDemoChat} />}
    </div>;
  }

  return <div className={shellClass}>
    {selected && session ? <MobileThread key={selected.sessionId} transport={transport} lost={lost} session={session} thread={selected} keyboard={keyboard} drafts={drafts.current}
      onBack={() => setSelected(undefined)}
      onPairingRequired={() => { setSelected(undefined); setSession(undefined); setStatus("pairing"); }} />
      : status === "ready" && session ? <ChatList workspaceName={session.workspaceName} connection="connected" refreshing={refreshing}
        onRefresh={() => { setRefreshing(true); setAttempt(count => count + 1); }}
        rows={rows.map(row => ({ key: row.sessionId, title: row.title, summary: row.summary, lastActiveAt: row.lastActiveAt, messageCount: row.messageCount, pinned: row.pinned, thread: row }))}
        language={toggleLanguage} onOpen={row => row.thread && setSelected(row.thread)} />
        : <StatusScreen status={status} language={toggleLanguage} onRetry={retry} />}
  </div>;
}

/** Loading, waiting for pairing, or the computer out of reach: the page has nothing else to show. */
function StatusScreen({ status, language, onRetry }: { status: Status; language: ReactNode; onRetry: () => void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const pairing = status === "pairing";
  const loading = status === "loading";
  const steps = zh
    ? ["在电脑打开「设置 › 常规与通知 › 手机访问」", "开启后先信任证书，再生成配对码", "用手机相机扫描二维码，轻点链接"]
    : ["On your computer, open Settings › General & notifications › Mobile access", "Turn it on, trust the certificate, then create a pairing code", "Scan the code with your phone camera and tap the link"];
  return <main className="m-state">
    <div className="m-state-top"><span className="m-brand"><BrandMark />OMP Studio</span>{language}</div>
    <PairingArt offline={status === "offline"} />
    <h1>{loading ? (zh ? "正在连接电脑" : "Connecting to your computer") : pairing ? (zh ? "配对手机" : "Pair your phone") : (zh ? "连不上电脑" : "Can’t reach your computer")}</h1>
    <p className="m-state-sub" role="status">{loading ? (zh ? "正在确认授权并读取会话…" : "Checking access and loading chats…")
      : pairing ? (zh ? "这个浏览器还没有授权。请在电脑上生成配对码，然后用手机相机扫描。" : "This browser isn’t authorized yet. Create a pairing code on your computer, then scan it with your phone camera.")
        : (zh ? "确认电脑上的 OMP Studio 正在运行，并且手机和电脑连接同一个 Wi‑Fi。" : "Make sure OMP Studio is running on your computer and both devices are on the same Wi‑Fi.")}</p>
    {pairing ? <ol className="m-steps">{steps.map((step, index) => <li key={step}><b>{index + 1}</b><span>{step}</span></li>)}</ol> : null}
    <div className="m-state-foot">
      {loading ? <div className="m-wait"><span className="m-spin" aria-hidden="true" />{zh ? "正在连接…" : "Connecting…"}</div>
        : <button className="m-primary" type="button" onClick={onRetry}>{zh ? "重试连接" : "Retry connection"}</button>}
      {!loading ? <p className="m-help">{zh ? "打不开页面？检查两台设备是否在同一 Wi‑Fi、防火墙是否允许访问，以及手机是否信任了电脑导出的证书。" : "Page won’t open? Check that both devices share the same Wi‑Fi, the firewall allows access, and the phone trusts the certificate exported from your computer."}</p> : null}
    </div>
  </main>;
}

function ChatList({ workspaceName, connection, rows, refreshing, demo, language, onOpen, onRefresh }: {
  workspaceName: string;
  connection: "connected";
  rows: ChatRow[];
  refreshing?: boolean;
  demo?: boolean;
  language: ReactNode;
  onOpen: (row: ChatRow) => void;
  onRefresh?: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle ? rows.filter(row => `${row.title ?? ""}\n${row.summary ?? ""}`.toLocaleLowerCase().includes(needle)) : rows;
  const groups = groupRows(visible, zh);
  return <>
    <header className="m-head">
      <div className="m-ws">
        <span className="m-mark" aria-hidden="true"><BrandMark /></span>
        <span className="m-ws-text">
          <span className="m-ws-name">{workspaceName}</span>
          <span className="m-ws-sub" role="status"><i className={`m-dot ${connection}`} aria-hidden="true" />{zh ? "已连接电脑" : "Connected to your computer"}{demo ? <em>{zh ? "演示" : "Demo"}</em> : null}</span>
        </span>
      </div>
      {onRefresh ? <button className="m-round" type="button" aria-label={zh ? "刷新会话" : "Refresh chats"} disabled={refreshing} onClick={onRefresh}>
        <span className={refreshing ? "m-spinning" : undefined}><RefreshIcon /></span>
      </button> : null}
      {language}
    </header>
    <main className="m-list">
      <div className="m-titlerow"><h1>{zh ? "会话" : "Chats"}</h1><span className="m-count">{rows.length}</span></div>
      <label className="m-search">
        <SearchIcon />
        <input type="search" enterKeyHint="search" placeholder={zh ? "搜索会话" : "Search chats"} aria-label={zh ? "搜索会话" : "Search chats"} value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      {!rows.length ? <div className="m-empty">
        <span className="m-empty-ic" aria-hidden="true"><ChatIcon /></span>
        <strong>{zh ? "这个项目还没有会话" : "No chats in this project yet"}</strong>
        <span>{zh ? "在电脑上开始一段对话后，它会出现在这里，可以随时在手机上继续。" : "Start a conversation on your computer and it shows up here, ready to continue on your phone."}</span>
      </div> : !visible.length ? <div className="m-empty">
        <strong>{zh ? "没有匹配的会话" : "No matching chats"}</strong>
        <span>{zh ? "换个关键词试试。" : "Try another word."}</span>
      </div> : groups.map(group => <section className="m-sec" key={group.label}>
        <h2>{group.label}</h2>
        <ul className="m-group">
          {group.rows.map(row => <li key={row.key}>
            <button type="button" className="m-row" onClick={() => onOpen(row)}>
              <span className="m-row-top">
                <span className="m-row-title">{row.title ?? row.summary ?? (zh ? "未命名会话" : "Untitled chat")}</span>
                <time className="m-time" dateTime={row.lastActiveAt}>{relativeTime(row.lastActiveAt, zh)}</time>
              </span>
              {row.title && row.summary ? <span className="m-row-sub">{row.summary}</span> : null}
              <span className="m-row-meta">{zh ? `${row.messageCount} 条消息` : `${row.messageCount} ${row.messageCount === 1 ? "message" : "messages"}`}</span>
            </button>
          </li>)}
        </ul>
      </section>)}
      <p className="m-foot">{zh ? `只显示 ${workspaceName} 中的会话。新建会话请在电脑上操作。` : `Showing chats in ${workspaceName} only. Start new chats on your computer.`}</p>
    </main>
  </>;
}

function groupRows(rows: ChatRow[], zh: boolean): { label: string; rows: ChatRow[] }[] {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const buckets: { label: string; rows: ChatRow[] }[] = [
    { label: zh ? "置顶" : "Pinned", rows: [] },
    { label: zh ? "今天" : "Today", rows: [] },
    { label: zh ? "昨天" : "Yesterday", rows: [] },
    { label: zh ? "本周" : "This week", rows: [] },
    { label: zh ? "更早" : "Earlier", rows: [] },
  ];
  const sorted = [...rows].sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  for (const row of sorted) {
    const at = Date.parse(row.lastActiveAt);
    const index = row.pinned ? 0 : at >= today ? 1 : at >= today - DAY ? 2 : at >= today - 6 * DAY ? 3 : 4;
    buckets[index]!.rows.push(row);
  }
  return buckets.filter(bucket => bucket.rows.length);
}

function relativeTime(iso: string, zh: boolean): string {
  const at = new Date(iso);
  const elapsed = Date.now() - at.getTime();
  const locale = zh ? "zh-CN" : "en";
  if (elapsed < 60_000) return zh ? "刚刚" : "now";
  if (elapsed < 3_600_000) return zh ? `${Math.floor(elapsed / 60_000)} 分钟前` : `${Math.floor(elapsed / 60_000)}m ago`;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday) return at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (at.getTime() >= startOfToday.getTime() - DAY) return zh ? "昨天" : "Yesterday";
  if (at.getTime() >= startOfToday.getTime() - 6 * DAY) return at.toLocaleDateString(locale, { weekday: "short" });
  return at.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

type ConnectionState = "connecting" | "reconnecting" | "ready" | "unavailable";

function MobileThread({ transport, lost, session, thread, keyboard, drafts, onBack, onPairingRequired }: {
  transport: BrowserWebClientTransport;
  lost: SocketLost;
  session: MobileBrowserSession;
  thread: Thread;
  keyboard: boolean;
  drafts: Map<string, string>;
  onBack: () => void;
  onPairingRequired: () => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const onExpired = useRef(onPairingRequired);
  onExpired.current = onPairingRequired;
  const [client, setClient] = useState<StudioClientImpl>();
  const [, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [retryIn, setRetryIn] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<CommandName>>(new Set());
  const inFlight = useRef(new Set<CommandName>());
  const [error, setError] = useState(false);
  const sessionId = thread.sessionId;
  const threadId = thread.threadId;
  useEffect(() => {
    let current = true;
    let active: StudioClientImpl | undefined;
    let unsubscribe: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let countdown: ReturnType<typeof setInterval> | undefined;
    const disconnect = () => {
      if (!current || retry !== undefined) return;
      active?.transportLost("event_stream_closed");
      setStatus("reconnecting");
      const wait = Math.min(750 * 2 ** Math.min(attempt, 4), 10_000);
      const due = Date.now() + wait;
      setRetryIn(Math.ceil(wait / 1000));
      countdown = setInterval(() => setRetryIn(Math.max(0, Math.ceil((due - Date.now()) / 1000))), 500);
      retry = setTimeout(() => setAttempt(count => count + 1), wait);
    };
    lost.current = disconnect;
    async function connect() {
      try {
        await transport.restoreSession();
        const context = await transport.openContext({ workspaceId: session.workspaceId, sessionId });
        active = new StudioClientImpl(context);
        if (!current) { await active.close().catch(() => {}); return; }
        unsubscribe = active.onState(() => setVersion(previous => previous + 1));
        const bootstrap = await active.bootstrap();
        if (!current || retry !== undefined) return;
        setClient(active);
        setStatus("ready");
        if (!bootstrap.snapshot && attempt === 0) {
          const handle = await active.command("session.resume", { threadId });
          await waitReceipt(active, handle.requestId);
        }
      } catch (cause) {
        if (!current || retry !== undefined) return;
        if (cause instanceof Error && /^(http_401|http_403)$/.test(cause.message)) onExpired.current();
        else if (cause instanceof TypeError || (cause instanceof Error && cause.message === "event_stream_closed")) disconnect();
        else setStatus("unavailable");
      }
    }
    void connect();
    return () => {
      current = false;
      lost.current = undefined;
      clearTimeout(retry);
      clearInterval(countdown);
      unsubscribe?.();
      void active?.close().catch(() => {});
    };
  }, [attempt, lost, session.workspaceId, sessionId, threadId, transport]);

  const state = client?.getState();
  const runtime = state?.connection.runtime;
  const usable = status === "ready" && !state?.connection.resyncRequired && runtime?.status === "connected";
  const streaming = state?.entities.snapshot?.isStreaming ?? false;
  const interaction = state?.interaction.pending;
  const approval = interaction?.kind === "approval" && interaction.approvalType !== "configuration" ? approvalFromInteraction(interaction, zh) : undefined;

  async function send<TName extends CommandName>(name: TName, input: CommandInput<TName>): Promise<boolean> {
    if (!client || status !== "ready" || inFlight.current.has(name)) return false;
    inFlight.current.add(name);
    setPending(new Set(inFlight.current));
    setError(false);
    try {
      const handle = await client.command(name, input);
      await waitReceipt(client, handle.requestId, name === "core.prompt" ? null : undefined);
      return true;
    } catch { setError(true); return false; }
    finally {
      inFlight.current.delete(name);
      setPending(new Set(inFlight.current));
    }
  }

  const connection: ThreadConnection = status === "connecting" ? "connecting" : status === "reconnecting" ? "reconnecting" : usable ? "ready" : "unavailable";
  const reconnect = () => {
    if (client && status === "ready") void send("session.resume", { threadId });
    else { setStatus("connecting"); setAttempt(count => count + 1); }
  };

  return <MobileThreadView
    title={thread.title ?? (zh ? "未命名会话" : "Untitled chat")} keyboard={keyboard} onBack={onBack}
    connection={connection} retryIn={retryIn} reconnecting={pending.has("session.resume")} onReconnect={reconnect}
    streaming={streaming} error={error} drafts={drafts} draftKey={sessionId}
    transcript={client ? <Transcript client={client} sessionId={sessionId} runtimeEpoch={state?.connection.runtimeEpoch ?? undefined} connected={usable} keyboard={keyboard} /> : <main className="m-transcript" />}
    interaction={interaction ? {
      approval: approval ? { title: approval.title, toolLabel: approval.toolLabel, command: approval.command, path: approval.path, extra: approval.extra, reason: approval.reason } : undefined,
      busy: pending.has("interaction.respond"),
      deny: () => void send("interaction.respond", { interactionId: interaction.interactionId, leaseGeneration: interaction.leaseGeneration, decision: "cancel" }),
      allow: () => void send("interaction.respond", { interactionId: interaction.interactionId, leaseGeneration: interaction.leaseGeneration, decision: "submit", value: true }),
    } : undefined}
    stopping={pending.has("core.abort")} onStop={() => void send("core.abort", {})}
    sending={pending.has("core.prompt")} onSend={text => send("core.prompt", { text })}
  />;
}

type ThreadConnection = "connecting" | "reconnecting" | "ready" | "unavailable";
type ApprovalCard = { title: string; toolLabel: string; command?: string | undefined; path?: string | undefined; extra?: string | undefined; reason?: string | undefined };
type PendingInteraction = { approval: ApprovalCard | undefined; busy: boolean; deny: () => void; allow: () => void };

/**
 * The thread screen without the wiring: header, connection notice, transcript,
 * then either the approval sheet or the composer. Preview renders it with
 * fixtures and local-only buttons.
 */
function MobileThreadView({ title, keyboard, onBack, demo, marks, connection = "ready", retryIn = 0, reconnecting, onReconnect, streaming: liveStreaming, error, transcript, interaction: liveInteraction, stopping, onStop, sending, onSend, drafts, draftKey }: {
  title: string;
  keyboard: boolean;
  onBack: () => void;
  demo?: boolean;
  marks?: boolean;
  connection?: ThreadConnection;
  retryIn?: number;
  reconnecting?: boolean;
  onReconnect?: () => void;
  streaming?: boolean;
  error?: boolean;
  transcript?: ReactNode;
  interaction?: PendingInteraction | undefined;
  stopping?: boolean;
  onStop?: () => void;
  sending?: boolean;
  onSend?: (text: string) => Promise<boolean>;
  drafts: Map<string, string>;
  draftKey: string;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [draft, setDraft] = useState(drafts.get(draftKey) ?? "");
  // Preview: the demo approval and its answer only change this screen.
  const [demoApproval, setDemoApproval] = useState(true);
  const demoCard = getPreviewMobileApproval(zh);
  const interaction: PendingInteraction | undefined = demo
    ? (demoApproval ? { approval: demoCard, busy: false, deny: () => setDemoApproval(false), allow: () => setDemoApproval(false) } : undefined)
    : liveInteraction;
  const streaming = demo ? demoApproval : liveStreaming ?? false;
  const usable = connection === "ready";

  function changeDraft(text: string) {
    setDraft(text);
    drafts.set(draftKey, text);
  }
  async function submit() {
    const text = draft;
    if (!usable || streaming || interaction || !text.trim()) return;
    if (demo) { changeDraft(""); return; }
    if (await onSend?.(text) && drafts.get(draftKey) === text) changeDraft("");
  }
  const stop = () => { if (demo) setDemoApproval(false); else onStop?.(); };

  const sub = connection === "connecting" ? { tone: "wait", text: zh ? "正在连接…" : "Connecting…" }
    : connection === "reconnecting" ? { tone: "warn", text: zh ? "连接中断，正在重连" : "Connection lost. Reconnecting" }
      : connection === "unavailable" ? { tone: "off", text: zh ? "Runtime 未连接" : "Runtime not connected" }
        : interaction ? { tone: "warn", text: zh ? "等待你的批准" : "Waiting for your approval" }
          : streaming ? { tone: "live", text: zh ? "正在回复" : "Replying" }
            : { tone: "ok", text: zh ? "Runtime 已连接" : "Runtime connected" };

  return <section className={`m-chat${keyboard ? " is-keyboard" : ""}`}>
    <header className="m-chat-head">
      <button className="m-back" type="button" aria-label={zh ? "返回会话列表" : "Back to chats"} onClick={onBack}><BackIcon /></button>
      <div className="m-chat-titles">
        <h1>{title}</h1>
        <div className={`m-chat-sub ${sub.tone}`} role="status"><i className="m-dot" aria-hidden="true" />{sub.text}{demo && marks ? <em>{zh ? "演示" : "Demo"}</em> : null}</div>
      </div>
    </header>

    <div className={`m-notice-wrap${connection === "reconnecting" || connection === "unavailable" ? " show" : ""}`}><div>
      {connection === "reconnecting" ? <div className="m-notice warn" role="status">
        <span className="m-spin" aria-hidden="true" />
        <span className="m-notice-text"><strong>{zh ? "连接中断，正在重连" : "Connection lost. Reconnecting"}</strong>
          <span>{retryIn > 0 ? (zh ? `草稿已保留 · ${retryIn} 秒后重试` : `Draft kept · retrying in ${retryIn}s`) : (zh ? "草稿已保留 · 正在重试" : "Draft kept · retrying")}</span></span>
      </div> : connection === "unavailable" ? <div className="m-notice off" role="status">
        <PlugIcon />
        <span className="m-notice-text"><strong>{zh ? "Runtime 未连接" : "Runtime not connected"}</strong>
          <span>{zh ? "可以继续阅读。发送和审批要等电脑上的 Runtime 恢复。" : "Keep reading. Sending and approvals resume when the Runtime on your computer is back."}</span></span>
        <button type="button" className="m-notice-btn" disabled={reconnecting} onClick={onReconnect}>{zh ? "重新连接" : "Reconnect"}</button>
      </div> : null}
    </div></div>

    {demo ? <DemoTranscript keyboard={keyboard} /> : transcript}

    {error ? <p className="m-error" role="alert">{zh ? "未能确认操作结果。请查看对话状态后再试。" : "Could not confirm the result. Check the conversation before retrying."}</p> : null}

    {interaction ? <ApprovalSheet interaction={interaction} usable={usable} streaming={streaming} stopping={stopping ?? false} onStop={stop} />
      : <form className="m-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="m-field">
          <textarea rows={1} enterKeyHint="send" aria-label={zh ? "消息" : "Message"} disabled={!usable}
            placeholder={usable ? (zh ? "继续对话…" : "Continue the conversation…") : (zh ? "连接恢复后可以发送" : "You can send once reconnected")}
            value={draft} onChange={event => changeDraft(event.target.value)} />
          {streaming ? <button type="button" className="m-send stop" aria-label={zh ? "停止回合" : "Stop turn"} disabled={!usable || stopping} onClick={stop}><StopIcon /></button>
            : <button type="submit" className="m-send" aria-label={zh ? "发送" : "Send"} disabled={!usable || sending || !draft.trim()}><SendIcon /></button>}
        </div>
      </form>}
  </section>;
}

function ApprovalSheet({ interaction, usable, streaming, stopping, onStop }: { interaction: PendingInteraction; usable: boolean; streaming: boolean; stopping: boolean; onStop: () => void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const approval = interaction.approval;
  const target = approval?.command ?? approval?.path;
  const disabled = !usable || interaction.busy;
  return <section className="m-sheet" aria-label={zh ? "待处理的工具审批" : "Pending tool approval"}>
    <div className="m-sheet-head">
      <span className="m-sheet-ic" aria-hidden="true"><TerminalIcon /></span>
      <div className="m-sheet-titles">
        <strong>{approval ? (zh ? "需要你的批准" : "Approval needed") : (zh ? "请在电脑上处理" : "Answer on your computer")}</strong>
        <span>{approval ? approval.title :(zh ? "这类请求暂时只能在电脑端处理。" : "This kind of request can only be answered on the computer for now.")}</span>
      </div>
      {streaming || !approval ? <button type="button" className="m-stopturn" disabled={!usable || stopping} onClick={onStop}><i aria-hidden="true" />{zh ? "停止回合" : "Stop turn"}</button> : null}
    </div>
    {approval && (target || approval.extra) ? <div className="m-cmd">
      {target ? <div className="m-cmd-line">{approval.command ? <b aria-hidden="true">$</b> : null}<code>{target}</code></div> : null}
      {approval.extra ? <pre className="m-cmd-extra">{approval.extra}</pre> : null}
    </div> : null}
    {approval?.reason ? <p className="m-reason">{approval.reason}</p> : null}
    {approval ? <>
      <div className="m-sheet-actions">
        <button type="button" className="m-deny" disabled={disabled} onClick={interaction.deny}>{zh ? "拒绝" : "Deny"}</button>
        <button type="button" className="m-allow" disabled={disabled} onClick={interaction.allow}>{zh ? "允许一次" : "Allow once"}</button>
      </div>
      <p className="m-sheet-note">{usable ? (zh ? "只允许这一次，下次仍会询问。" : "Allows this run only. You’ll be asked again next time.") : (zh ? "连接恢复后才能处理审批。" : "Approvals resume once you’re reconnected.")}</p>
    </> : null}
  </section>;
}

function useFollowBottom(keyboard: boolean, rowsVersion: unknown) {
  const scroll = useRef<HTMLElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const element = scroll.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [rowsVersion, keyboard]);
  // The keyboard and the approval sheet shrink the transcript; a reader at the bottom stays there.
  useEffect(() => {
    const element = scroll.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (follow.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const onScroll = (element: HTMLElement) => {
    follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 64;
  };
  return { scroll, onScroll };
}

function Transcript({ client, sessionId, runtimeEpoch, connected, keyboard }: {
  client: StudioClientImpl | undefined;
  sessionId: SessionId | undefined;
  runtimeEpoch: NonNullable<ReturnType<StudioClientImpl["getState"]>["connection"]["runtimeEpoch"]> | undefined;
  connected: boolean;
  keyboard: boolean;
}) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const engine = useMemo(() => createConversationEngine({
    preview, client: client ?? null, identity: sessionId ? { sessionId, ...(runtimeEpoch ? { runtimeEpoch } : {}) } : null,
    canRead: !!client, runtimeConnected: connected, previewItems: preview ? previewConversationItems("t1", zh) : [],
  }), [client, connected, preview, runtimeEpoch, sessionId, zh]);
  useEffect(() => {
    engine.start();
    return () => engine.dispose();
  }, [engine]);
  const { rows, state, loadingOlder } = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const { scroll, onScroll } = useFollowBottom(keyboard, rows);
  return <main className="m-transcript" ref={scroll} aria-label={zh ? "对话正文" : "Conversation transcript"} onScroll={event => onScroll(event.currentTarget)}>
    <div className="m-thread">
      {state.hasMoreBefore ? <button type="button" className="m-older" disabled={loadingOlder} onClick={() => void engine.loadOlder()}>{loadingOlder ? (zh ? "正在加载…" : "Loading…") : (zh ? "加载较早消息" : "Load earlier messages")}</button> : null}
      {!rows.length && state.hydrateStatus === "error" ? <p className="m-thread-note">{zh ? "暂时无法读取对话。" : "This conversation could not be loaded."}</p> : null}
      {!rows.length && state.hydrateStatus === "loading" ? <p className="m-thread-note"><span className="m-spin" aria-hidden="true" />{zh ? "正在读取对话…" : "Loading conversation…"}</p> : null}
      {rows.map(row => row.type === "user" || row.type === "extension" ? <div key={timelineRowKey(row)} className="m-user">{row.text}</div>
        : row.type === "assistant" ? <article key={timelineRowKey(row)} className="m-ai">
          {row.segments.map(segment => segment.type === "text" ? <MarkdownText key={segment.key} text={segment.text} streaming={segment.streaming ?? false} />
            : segment.type === "batch" ? <ToolBatch key={segment.key} tools={segment.tools} /> : null)}
        </article> : null)}
    </div>
  </main>;
}

function DemoTranscript({ keyboard }: { keyboard: boolean }) {
  return <Transcript client={undefined} sessionId={undefined} runtimeEpoch={undefined} connected={false} keyboard={keyboard} />;
}

function ToolBatch({ tools }: { tools: readonly ToolView[] }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(false);
  const running = tools.some(tool => tool.status === "running" || tool.status === "queued");
  const failed = tools.filter(tool => tool.status === "failed").length;
  const names = [...new Set(tools.map(tool => tool.toolName))];
  const summary = zh ? `${tools.length} 个工具 · ${names.slice(0, 3).join("、")}${names.length > 3 ? "…" : ""}` : `${tools.length} ${tools.length === 1 ? "tool" : "tools"} · ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`;
  return <div className="m-tools">
    <button type="button" className={`m-tools-chip${open ? " open" : ""}${running ? " running" : ""}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="m-tools-ic" aria-hidden="true">{running ? <span className="m-spin" /> : <ToolIcon />}</span>
      <span className="m-tools-sum">{summary}</span>
      {failed ? <span className="m-tools-fail">{zh ? `${failed} 个失败` : `${failed} failed`}</span> : null}
      <span className="m-chev" aria-hidden="true"><ChevronIcon /></span>
    </button>
    <div className={`m-tools-list${open ? " open" : ""}`}><div>
      <ul>{tools.map(tool => <li key={tool.toolCallId} className={tool.status}><i aria-hidden="true" /><code>{tool.toolName}</code><span>{toolStatusLabel(tool.status, zh)}</span></li>)}</ul>
    </div></div>
  </div>;
}

function toolStatusLabel(status: ToolView["status"], zh: boolean): string {
  const labels: Record<ToolView["status"], [string, string]> = {
    queued: ["排队中", "Queued"], running: ["运行中", "Running"], succeeded: ["完成", "Done"],
    failed: ["失败", "Failed"], aborted: ["已停止", "Stopped"], missing: ["无结果", "No result"],
  };
  return labels[status][zh ? 0 : 1];
}

function PairingArt({ offline }: { offline: boolean }) {
  return <div className={`m-art${offline ? " offline" : ""}`} aria-hidden="true">
    <svg width="260" height="150" viewBox="0 0 260 150">
      <circle className="ring" cx="62" cy="75" r="30" />
      <circle className="ring r2" cx="62" cy="75" r="30" />
      <rect className="dev" x="40" y="28" width="44" height="90" rx="11" />
      <rect className="scr" x="45" y="35" width="34" height="76" rx="7" />
      <rect className="acc" x="54" y="65" width="16" height="16" rx="4" />
      <path className="link" d="M92 75 C 118 54, 140 98, 166 70" />
      <rect className="dev" x="162" y="38" width="84" height="58" rx="7" />
      <rect className="scr" x="168" y="44" width="72" height="46" rx="4" />
      <path className="dev" d="M152 102 h104 l-8 8 h-88 z" />
      <rect className="qr" x="188" y="52" width="10" height="10" rx="2" />
      <rect className="qr" x="210" y="52" width="10" height="10" rx="2" />
      <rect className="qr" x="188" y="72" width="10" height="10" rx="2" />
      <rect className="acc" x="208" y="70" width="14" height="14" rx="3.5" />
    </svg>
  </div>;
}

const svg = (children: ReactNode, size = 20, width = 2) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const BrandMark = () => svg(<><rect x="3" y="4" width="18" height="12" rx="2.5" /><path d="M8 20h8M12 16v4" /></>, 18, 2);
const RefreshIcon = () => svg(<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" />, 18);
const SearchIcon = () => svg(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>, 17, 2.2);
const ChatIcon = () => svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z" />, 26, 1.8);
const BackIcon = () => svg(<path d="M15 5l-7 7 7 7" />, 22, 2.4);
const PlugIcon = () => svg(<path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5M4 4l16 16" />, 18);
const TerminalIcon = () => svg(<path d="M4 17l6-6-6-6M12 19h8" />, 20, 2.2);
const ToolIcon = () => svg(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />, 14, 2);
const ChevronIcon = () => svg(<path d="M6 9l6 6 6-6" />, 14, 2.4);
const SendIcon = () => svg(<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />, 20, 2.6);
const StopIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3.5" fill="currentColor" /></svg>;

createRoot(document.getElementById("root")!).render(<I18nProvider><PreviewModeProvider><MobileApp /></PreviewModeProvider></I18nProvider>);
