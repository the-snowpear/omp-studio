import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownText } from "./markdown";
import { CommandBlockProvider, CommandExecutionContext } from "./CommandBlock";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { TerminalSessionsProvider, useTerminalStore, type TerminalSessions } from "../terminalSessions";
import { computeHighlight } from "../highlight/compute";

const dock = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../dock/DockContext", () => ({ useDockEngine: () => ({ store: dock }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); history.replaceState(null, "", "/"); });

it("executes the complete script only on click and preserves newlines and quotes", async () => {
  const text = 'printf "%s\\n" "hello world"\n# second line\npwd';
  const run = vi.fn(async () => {}), writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = render(<CommandExecutionContext.Provider value={{ run }}><MarkdownText text={'```bash\n' + text + '\n```'} /></CommandExecutionContext.Provider>);
  expect(run).not.toHaveBeenCalled();
  expect(view.container.querySelector(".md-command")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "在终端执行" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith({ shell: "bash", text }));
  fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
});

it("disables unfinished commands and leaves ordinary source code in the regular frame", () => {
  const run = vi.fn();
  const view = render(<CommandExecutionContext.Provider value={{ run }}><MarkdownText text={'```pwsh\nGet-'} streaming /></CommandExecutionContext.Provider>);
  expect((screen.getByRole("button", { name: "在终端执行" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "在终端执行" }));
  expect(run).not.toHaveBeenCalled();
  view.rerender(<MarkdownText text={'```ts\nconst a = 1\n```'} />);
  expect(view.container.querySelector(".md-command")).toBeNull();
  expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy();
});

it("keeps preview execution local and hides demo notices when marks are off", () => {
  history.replaceState(null, "", "/?preview=1&marks=off");
  const run = vi.fn();
  render(<PreviewModeProvider><CommandExecutionContext.Provider value={{ run }}><MarkdownText text={'```bash\npwd\n```'} /></CommandExecutionContext.Provider></PreviewModeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "在终端执行" }));
  expect(run).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("演示")).toBeNull();
});

it("starts a new terminal in the conversation workspace before revealing it", async () => {
  let store!: TerminalSessions;
  function Probe() { store = useTerminalStore(); return null; }
  const create = vi.fn(async () => ({ id: "command-terminal", name: "pwsh", cwd: "D:/work" }));
  vi.stubGlobal("ompStudioTerminal", { create, dispose: vi.fn(async () => {}), onData: () => () => {}, onExit: () => () => {} });
  render(<TerminalSessionsProvider><Probe /><CommandBlockProvider workspaceId="work" sessionId="session" conversationId="chat"><MarkdownText text={'```pwsh\nGet-Location\n```'} /></CommandBlockProvider></TerminalSessionsProvider>);
  fireEvent.click(screen.getByRole("button", { name: "在终端执行" }));
  await waitFor(() => expect(dock.dispatch).toHaveBeenCalledWith({ type: "open", panel: "terminal" }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "work", command: { shell: "powershell", text: "Get-Location" } }));
  expect(store.snapshot().sessions[0]).toMatchObject({ workspaceId: "work", sessionId: "session", conversationId: "chat" });
  expect(store.activeIds.get(JSON.stringify([null, "work", "chat"]))).toBe("command-terminal");
  await act(async () => {});
});

it("highlights PowerShell aliases in both worker and Markdown paths", () => {
  for (const language of ["powershell", "pwsh", "ps1"]) {
    const code = 'Get-Location\nWrite-Output "hello"';
    const tokens = computeHighlight(language, code);
    expect(tokens.some(token => token.type === "span")).toBe(true);
    const view = render(<MarkdownText text={'```' + language + '\n' + code + '\n```'} />);
    expect(view.container.querySelector("pre")?.textContent).toBe(code + "\n");
    expect(view.container.querySelector(".hljs-built_in")).not.toBeNull();
    view.unmount();
  }
});
