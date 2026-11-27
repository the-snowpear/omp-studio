import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { previewPtyInputWaits } from "../preview/ptyWaitPreview";
import { CONVERSATION_REVEAL, revealConversationTarget, type ConversationRevealRequest } from "./conversationReveal";
import { PtyWaitNotice, type PtyInputWait } from "./PtyWaitNotice";

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
  expect(onReveal).toHaveBeenCalledWith("preview-bash-live");
  mounted.rerender(view("zh"));
  expect(screen.getByRole("button", { name: "查看命令" })).toBeTruthy();
  expect(screen.getByText("npm run typecheck")).toBeTruthy();
  expect(previewPtyInputWaits("t2")).toEqual([]);
});
