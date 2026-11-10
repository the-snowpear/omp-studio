import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { ResourcesPane } from "./ResourcesPane";
import { LocalFilesPane } from "./LocalFilesPane";

const receipts = vi.hoisted(() => ({ serial: 0, values: new Map<string, () => unknown>() }));
vi.mock("../hostError", async importOriginal => ({
  ...await importOriginal<typeof import("../hostError")>(),
  waitReceipt: async (_client: unknown, requestId: string) => ({ result: await receipts.values.get(requestId)!() }),
}));
vi.mock("./CapabilityEditor", () => ({ CapabilityEditor: ({ value, onChange, label, readOnly }: { value: string; onChange?: (value: string) => void; label: string; readOnly?: boolean }) => <textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange?.(event.target.value)} /> }));

const VERSION = "1".repeat(64), NEXT_VERSION = "2".repeat(64);
const FILES = [
  { name: "PLAN.md", uri: "local://PLAN.md", bytes: 20, modifiedAt: 1793172000000 },
  { name: "notes.md", uri: "local://notes.md", bytes: 30, modifiedAt: 1793170000000 },
];
type Input = { sessionId: string; uri?: string; version?: string; text?: string; offset?: number };
function clientWith(handler?: (kind: string, input: Input) => unknown) {
  const command = vi.fn(async (kind: string, input: Input) => {
    const requestId = `request-${++receipts.serial}`;
    receipts.values.set(requestId, () => {
      if (handler) return handler(kind, input);
      if (kind === "resource.local.list") return { files: FILES, truncated: false };
      if (kind === "resource.local.open") return { uri: input.uri, version: VERSION, text: `Original ${input.uri}` };
      if (kind === "resource.local.save") return { uri: input.uri, version: NEXT_VERSION, saved: true };
      return { uri: input.uri, version: VERSION, offset: input.offset ?? 0, total: 16, nextOffset: input.offset ? undefined : 8, text: input.offset ? "Second page" : "First page", truncated: !input.offset };
    });
    return { requestId };
  });
  const query = vi.fn(async () => ({ capabilities: ["resource.local.list", "resource.local.open", "resource.local.save", "resource.read"].map(id => ({ id, grade: "native" })) }));
  return { command, query } as unknown as StudioClient & { command: typeof command; query: typeof query };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function surface(client: StudioClient, sessionId = "s", preview = false, localOnly = false, initialName?: string) {
  return <I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled={false}><PreviewSurface preview={preview}>{localOnly ? <LocalFilesPane client={client} sessionId={sessionId} available {...(initialName ? { initialName } : {})} /> : <ResourcesPane client={client} sessionId={sessionId} available />}</PreviewSurface></PreviewModeProvider></I18nProvider>;
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const editor = () => screen.getByRole("textbox", { name: "本地文件正文" }) as HTMLTextAreaElement;
async function ready() { await screen.findByRole("textbox", { name: "本地文件正文" }); await waitFor(() => expect(editor().readOnly).toBe(false)); }
async function reader() { fireEvent.click(screen.getByRole("tab", { name: "按 URI 读取" })); address("local://notes.md"); await waitFor(() => expect(button("读取").disabled).toBe(false)); }
function address(value: string) { fireEvent.change(screen.getByRole("textbox", { name: "Resource URI" }), { target: { value } }); }

beforeEach(() => { receipts.values.clear(); localStorage.clear(); window.history.replaceState({}, "", "/"); });
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

describe("local resource workspace", () => {
  it("opens the caller's target, searches real files, and saves to the original URI with its version", async () => {
    const client = clientWith();
    render(surface(client, "s", false, true, "notes.md"));
    await ready();
    expect(editor().value).toBe("Original local://notes.md");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索本地文件" }), { target: { value: "notes" } });
    expect(within(screen.getByRole("navigation", { name: "本地文件列表" })).queryByRole("button", { name: /PLAN.md/ })).toBeNull();
    fireEvent.change(editor(), { target: { value: "Updated notes" } });
    fireEvent.click(button("保存到原文件"));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith("resource.local.save", { sessionId: "s", uri: "local://notes.md", version: VERSION, text: "Updated notes" }));
    await waitFor(() => expect(button("保存到原文件").disabled).toBe(true));
    await screen.findByText("已保存到原文件");
    fireEvent.change(editor(), { target: { value: "Second change" } });
    fireEvent.click(button("保存到原文件"));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith("resource.local.save", expect.objectContaining({ version: NEXT_VERSION })));
  });

  it("confirms switching and refreshing dirty files, and retains the draft on external conflict", async () => {
    const client = clientWith((kind, input) => {
      if (kind === "resource.local.list") return { files: FILES, truncated: false };
      if (kind === "resource.local.save") throw { code: "CONFLICT", message: "File changed externally" };
      return { uri: input.uri, version: VERSION, text: `Original ${input.uri}` };
    });
    render(surface(client)); await ready();
    fireEvent.change(editor(), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: /notes.md/ }));
    await screen.findByRole("dialog", { name: "放弃未保存的修改？" });
    expect(client.command.mock.calls.filter(([kind]) => kind === "resource.local.open")).toHaveLength(1);
    fireEvent.click(button("继续编辑")); expect(editor().value).toBe("Keep this draft");
    fireEvent.click(button("保存到原文件"));
    await screen.findByText("保存未完成，草稿已保留");
    expect(editor().value).toBe("Keep this draft");
    expect(screen.getByRole("alert").textContent).toContain("File changed externally");
    fireEvent.click(button("刷新本地文件"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(button("继续编辑"));
    fireEvent.click(button("重新打开"));
    fireEvent.click(button("放弃草稿并继续"));
    await waitFor(() => expect(editor().value).toBe("Original local://PLAN.md"));
    fireEvent.change(editor(), { target: { value: "Discard me" } });
    fireEvent.click(screen.getByRole("button", { name: /notes.md/ }));
    fireEvent.click(button("放弃草稿并继续"));
    await waitFor(() => expect(editor().value).toBe("Original local://notes.md"));
  });

  it("locks editing during save and enforces the UTF-8 byte limit", async () => {
    const pending = deferred<unknown>();
    const client = clientWith((kind, input) => kind === "resource.local.list" ? { files: FILES, truncated: false } : kind === "resource.local.save" ? pending.promise : { uri: input.uri, version: VERSION, text: "Original" });
    render(surface(client, "s", false, true)); await ready();
    fireEvent.change(editor(), { target: { value: "界".repeat(180_000) } });
    expect(button("保存到原文件").disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("512 KiB");
    fireEvent.change(editor(), { target: { value: "Save this" } });
    fireEvent.click(button("保存到原文件"));
    expect(editor().readOnly).toBe(true);
    fireEvent.change(editor(), { target: { value: "Do not accept" } });
    expect(editor().value).toBe("Save this");
    await act(async () => pending.resolve({ uri: "local://PLAN.md", version: NEXT_VERSION, saved: true }));
    await waitFor(() => expect(editor().readOnly).toBe(false));
    expect(editor().value).toBe("Save this");
  });

  it.each(["session", "client", "preview"])("isolates a late local open when the %s changes", async change => {
    const stale = deferred<unknown>();
    const first = clientWith((kind, input) => kind === "resource.local.list" ? { files: FILES, truncated: false } : stale.promise);
    const second = clientWith();
    const view = render(surface(first, "first", false, true));
    await waitFor(() => expect(first.command).toHaveBeenCalledWith("resource.local.open", expect.anything()));
    const target = change === "client" ? second : first;
    if (change === "session") {
      receipts.values.clear();
      first.command.mockImplementation(async (kind, input) => {
        const requestId = `new-${++receipts.serial}`;
        receipts.values.set(requestId, () => kind === "resource.local.list" ? { files: [], truncated: false } : { uri: input.uri, version: VERSION, text: "New session" });
        return { requestId };
      });
    }
    view.rerender(surface(target, change === "session" ? "second" : "first", change === "preview", true));
    if (change !== "session") await ready();
    await act(async () => stale.resolve({ uri: "local://PLAN.md", version: VERSION, text: "Stale document" }));
    expect(screen.queryByDisplayValue("Stale document")).toBeNull();
    if (change !== "session") expect(editor().readOnly).toBe(false);
  });
});

describe("URI resources", () => {
  it("pages backward and forward against the loaded URI/version, not the edited address", async () => {
    const client = clientWith(); render(surface(client)); await reader();
    address("omp://docs"); fireEvent.click(button("读取"));
    await screen.findByDisplayValue("First page");
    address("attachment://1"); fireEvent.click(button("下一页"));
    await screen.findByDisplayValue("Second page");
    expect(client.command).toHaveBeenLastCalledWith("resource.read", { sessionId: "s", uri: "omp://docs", version: VERSION, offset: 8 });
    fireEvent.click(button("上一页"));
    await screen.findByDisplayValue("First page");
    expect(client.command).toHaveBeenLastCalledWith("resource.read", { sessionId: "s", uri: "omp://docs", version: VERSION, offset: 0 });
    fireEvent.click(button("重新读取"));
    await waitFor(() => expect(client.command).toHaveBeenLastCalledWith("resource.read", { sessionId: "s", uri: "omp://docs" }));
    expect((screen.getByRole("textbox", { name: "Resource URI" }) as HTMLInputElement).value).toBe("attachment://1");
    expect(within(screen.getByRole("navigation", { name: "最近访问的资源" })).getAllByRole("button")).toHaveLength(1);
  });

  it("late reads from a previous session neither pollute the new page nor unlock its request", async () => {
    const old = deferred<unknown>(), current = deferred<unknown>();
    const client = clientWith((kind, input) => kind === "resource.local.list" ? { files: [], truncated: false } : input.sessionId === "first" ? old.promise : current.promise);
    const view = render(surface(client, "first")); await reader();
    address("omp://docs"); fireEvent.click(button("读取"));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith("resource.read", expect.objectContaining({ sessionId: "first" })));
    view.rerender(surface(client, "second"));
    address("local://notes.md");
    await waitFor(() => expect(button("读取").disabled).toBe(false));
    fireEvent.click(button("读取"));
    await act(async () => old.resolve({ uri: "omp://docs", version: VERSION, offset: 0, total: 1, text: "Stale page", truncated: false }));
    expect(button("读取").disabled).toBe(true);
    expect(screen.queryByDisplayValue("Stale page")).toBeNull();
    await act(async () => current.resolve({ uri: "local://notes.md", version: NEXT_VERSION, offset: 0, total: 1, text: "Current page", truncated: false }));
    await screen.findByDisplayValue("Current page");
    expect(within(screen.getByRole("navigation", { name: "最近访问的资源" })).queryByText("omp://docs")).toBeNull();
  });

  it("uses all four preview protocols, preserves local edits, and hides demo copy with marks off without Host calls", async () => {
    window.history.replaceState({}, "", "/?marks=off");
    const client = clientWith(); render(surface(client, "s", true)); await ready();
    fireEvent.change(editor(), { target: { value: "Preview-only edit" } }); fireEvent.click(button("保存到原文件"));
    await screen.findByText("已保存到原文件");
    fireEvent.click(button("重新打开")); await waitFor(() => expect(editor().value).toBe("Preview-only edit"));
    await reader(); fireEvent.click(button("读取"));
    await screen.findByDisplayValue(/This is a local preview resource/);
    fireEvent.click(button("omp://")); fireEvent.click(button("读取"));
    await screen.findByDisplayValue(/OMP documentation/);
    fireEvent.click(button("下一页")); await screen.findByDisplayValue(/Working with resources/);
    fireEvent.click(button("attachment://")); fireEvent.click(button("读取"));
    const image = await screen.findByRole("img", { name: "attachment://1" }); expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    fireEvent.click(button("conflict://")); fireEvent.click(button("读取"));
    await screen.findByDisplayValue("const resourceScope = 'session';");
    expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
    expect(screen.queryByText(/演示|Demo/)).toBeNull();
  });
});
