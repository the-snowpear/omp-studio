import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { previewPtyInputWaits } from "../preview/ptyWaitPreview";
import { CONVERSATION_REVEAL, revealConversationTarget, type ConversationRevealRequest } from "./conversationReveal";
import { PtyWaitNotice, type PtyInputWait } from "./PtyWaitNotice";
import type { StudioClient } from "@omp-studio/client-contract";

const url = window.location.href;
afterEach(() => { cleanup(); window.history.replaceState({}, "", url); });
const waits: PtyInputWait[] = [{ sessionId: "session", toolCallId: "pty-call", command: "python configure.py", waiting: true, notify: false }];

it("shows a native PTY without a trace or job and reveals its exact tool call across language changes", async () => {
  const scroller = document.createElement("div");
  const reveals: string[] = [];
  scroller.addEventListener(CONVERSATION_REVEAL, event => {
    event.preventDefault();
    const request = (event as CustomEvent<ConversationRevealRequest>).detail;
    reveals.push(request.toolCallId!); request.finish(true);
  });
  const onReveal = (toolCallId: string) => revealConversationTarget(scroller, { toolCallId });
  const view = (language: "zh" | "en", rows = waits) => <I18nProvider forcedLanguage={language}><PtyWaitNotice sessionId="session" waits={rows} onReveal={onReveal} /></I18nProvider>;
  const mounted = render(view("zh"));
  expect(screen.getByText("终端正在等待输入")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看命令" })); });
  mounted.rerender(view("en"));
  expect(screen.getByText("Console waiting for input")).toBeTruthy();
  expect(screen.getByText("python configure.py")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "View command" })); });
  mounted.rerender(view("zh"));
  expect(screen.getByRole("button", { name: "查看命令" })).toBeTruthy();
  expect(reveals).toEqual(["pty-call", "pty-call"]);
  mounted.rerender(view("zh", [{ ...waits[0]!, waiting: false }, { ...waits[0]!, sessionId: "another-session" }]));
  expect(screen.queryByText("终端正在等待输入")).toBeNull();
});

it("localizes a missing-source result without clearing it or rewriting the command", async () => {
  const reveal = vi.fn(async () => false);
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PtyWaitNotice sessionId="session" waits={waits} onReveal={reveal} /></I18nProvider>;
  const mounted = render(view("zh"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看命令" })); });
  expect(screen.getByText("对应命令尚未载入当前对话。")).toBeTruthy();
  mounted.rerender(view("en"));
  expect(screen.getByText("The source command is not loaded in this conversation yet.")).toBeTruthy();
  mounted.rerender(view("zh"));
  expect(screen.getByText("对应命令尚未载入当前对话。")).toBeTruthy();
  expect(screen.getByText("python configure.py")).toBeTruthy();
});

it("uses the matching preview tool identity and hides the demo mark with marks=off", async () => {
  window.history.replaceState({}, "", "?preview=1&marks=off");
  const onReveal = vi.fn(async () => true);
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><PreviewSurface preview><PtyWaitNotice sessionId="preview-session" waits={previewPtyInputWaits("t1")} onReveal={onReveal} /></PreviewSurface></PreviewModeProvider></I18nProvider>;
  const mounted = render(view("zh"));
  expect(screen.queryByText("演示")).toBeNull();
  mounted.rerender(view("en"));
  expect(screen.queryByText("Demo")).toBeNull();
  expect(screen.getByText("npm run typecheck")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "View command" })); });
  expect(onReveal).toHaveBeenCalledWith("preview-bash-live", expect.objectContaining({ jobId: "preview-pty" }));
  mounted.rerender(view("zh"));
  expect(screen.getByRole("button", { name: "查看命令" })).toBeTruthy();
  expect(screen.getByText("npm run typecheck")).toBeTruthy();
  expect(previewPtyInputWaits("t2")).toEqual([]);
});

it("opens a child PTY directly by job identity when its transcript is not loaded and resets it on scope changes", async () => {
  const row: PtyInputWait = { ...waits[0]!, sourceSessionId: "child-session", ownerAgentId: "Child", jobId: "child-job", jobGeneration: 77 };
  const commands: Record<string, unknown> = {};
  let sequence = 0;
  const command = vi.fn(async (kind: string) => {
    const requestId = String(++sequence);
    commands[requestId] = { status: "completed", result: { result: kind === "jobs.inspect" ? { jobId: row.jobId, pids: [], canInput: true, inputGeneration: 77, waitingForInput: true } : { sent: true } } };
    return { requestId };
  });
  const client = { command, getState: () => ({ commands }) } as unknown as StudioClient;
  const reveal = vi.fn(async () => false);
  const view = (language: "zh" | "en", preview = false, rows = [row], sessionId = "session") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><PreviewSurface preview={preview}><PtyWaitNotice client={client} sessionId={sessionId} waits={rows} onReveal={reveal} /></PreviewSurface></PreviewModeProvider></I18nProvider>;
  const mounted = render(view("zh"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看命令" })); });
  expect(reveal).toHaveBeenCalledWith("pty-call", row);
  fireEvent.click(screen.getByRole("button", { name: "打开终端" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "终端输入" }), { target: { value: "answer" } });
  mounted.rerender(view("en"));
  expect(screen.getByRole("textbox", { name: "Console input" })).toHaveProperty("value", "answer");
  fireEvent.click(screen.getByRole("button", { name: "Send + Enter" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("jobs.input", { sessionId: "session", jobId: "child-job", expectedGeneration: 77, data: "answer\r" }));
  mounted.rerender(view("zh"));
  fireEvent.click(screen.getByRole("button", { name: "关闭终端" }));
  expect(screen.queryByRole("textbox", { name: "终端输入" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开终端" }));
  await screen.findByRole("textbox", { name: "终端输入" });
  mounted.rerender(view("zh", true));
  expect(screen.queryByRole("textbox", { name: "终端输入" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开终端" }));
  expect(screen.getByRole("textbox", { name: "终端输入" })).toBeTruthy();
  mounted.rerender(view("zh", false, [{ ...row, sessionId: "next" }], "next"));
  expect(screen.queryByRole("textbox", { name: "终端输入" })).toBeNull();
});
