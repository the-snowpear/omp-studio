import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AvailableModelRecord, ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { ModelCompactionPane } from "./ModelCompactionPane";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";

const models: AvailableModelRecord[] = [
  { provider: "acme", id: "small", selector: "acme/small", name: "Small", contextWindow: 200_000, reasoning: true },
  { provider: "acme", id: "wide", selector: "acme/wide", name: "Wide", contextWindow: 1_000_000, reasoning: true },
];
const context = {
  sessionId: "main", available: true,
  capabilities: { capabilities: ["preferences.features.get", "preferences.features.set", "models.compaction.preview", "models.compaction.set"].map(id => ({ id, grade: "stable" })) } as ClientBootstrap["capabilityManifest"],
};

beforeEach(() => {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => { cleanup(); window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); });

function nativeClient(initial: Record<string, number | string | null> = {}) {
  let entries = { ...initial };
  const commands: Record<string, unknown> = {};
  let request = 0;
  const command = vi.fn(async (kind: string, input: { selector?: string; input?: string; confirmed?: boolean }) => {
    const requestId = `compaction-${++request}`;
    let result: unknown;
    if (kind === "preferences.features.get") result = { settings: [{ key: "compaction.modelThresholds", value: { ...entries }, source: "global" }] };
    else if (kind === "models.compaction.preview") {
      const window = input.input === "f400k" || input.selector === "acme/wide" ? 1_000_000 : 200_000;
      result = input.input === "bad" ? { valid: false, extended: false } : { valid: true, window, trigger: input.input === "80%" ? window * .8 : input.input === "f400k" ? 400_000 : window * .85, extended: input.input === "f400k", summary: "native preview" };
    } else if (input.input === "f400k" && !input.confirmed) result = { saved: false, confirmationRequired: true, summary: "Opens 1M window; >200K costs more" };
    else {
      if (!input.input) delete entries[input.selector!];
      else entries[input.selector!] = input.input === "f400k" ? "f400000" : input.input;
      result = { saved: true, confirmationRequired: false, summary: "Native compaction setting saved" };
    }
    commands[requestId] = { status: "completed", result: { result } };
    return { requestId };
  });
  return { client: { command, getState: () => ({ commands }) } as unknown as StudioClient, command };
}

async function chooseModel(name: string) {
  const picker = screen.getByRole("button", { name: "压缩配置模型" });
  await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

it("keeps an unavailable role model selected until the user chooses a replacement", async () => {
  const { client, command } = nativeClient();
  render(<PreviewModeProvider switchEnabled><ModelCompactionPane client={client} context={context} visible models={models} initialSelector="stopped/old" /></PreviewModeProvider>);
  const picker = screen.getByRole("button", { name: "压缩配置模型" });
  expect(picker.textContent).toContain("stopped/old");
  expect((screen.getByRole("textbox", { name: "压缩阈值" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("meter")).toBeNull();
  await chooseModel("Small");
  await waitFor(() => expect(command).toHaveBeenCalledWith("models.compaction.preview", { sessionId: "main", selector: "acme/small", input: "" }));
});

it("prefills the role's model threshold and keeps the saved value when switching models", async () => {
  const { client, command } = nativeClient({ "acme/small": "80%", "acme/wide": "f400000" });
  render(<PreviewModeProvider switchEnabled><ModelCompactionPane client={client} context={context} visible models={models} initialSelector="acme/wide" /></PreviewModeProvider>);
  const field = screen.getByRole("textbox", { name: "压缩阈值" }) as HTMLInputElement;
  await waitFor(() => expect(field.value).toBe("f400k"));
  await waitFor(() => expect(command).toHaveBeenCalledWith("models.compaction.preview", { sessionId: "main", selector: "acme/wide", input: "f400k" }));
  await chooseModel("Small");
  await waitFor(() => expect(field.value).toBe("80%"));
  await chooseModel("Wide");
  await waitFor(() => expect(field.value).toBe("f400k"));
});

it("saves through native compaction and re-reads the effective settings before reporting completion", async () => {
  const { client, command } = nativeClient();
  const onSaved = vi.fn();
  render(<PreviewModeProvider switchEnabled><ModelCompactionPane client={client} context={context} visible models={models} onSaved={onSaved} /></PreviewModeProvider>);
  const field = screen.getByRole("textbox", { name: "压缩阈值" }) as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: "80%" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存阈值" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "保存阈值" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(command).toHaveBeenCalledWith("models.compaction.set", { sessionId: "main", selector: "acme/small", input: "80%", confirmed: false });
  expect(command.mock.calls.filter(([kind]) => kind === "preferences.features.get")).toHaveLength(2);
  expect(screen.getByRole("status").textContent).toContain("Native compaction setting saved");
  await chooseModel("Wide");
  await chooseModel("Small");
  await waitFor(() => expect(field.value).toBe("80%"));
  fireEvent.change(field, { target: { value: "" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "恢复默认" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("models.compaction.set", { sessionId: "main", selector: "acme/small", input: "", confirmed: false }));
});

it("requires the native extended-window confirmation and drops it when the input changes", async () => {
  const { client, command } = nativeClient();
  render(<PreviewModeProvider switchEnabled><ModelCompactionPane client={client} context={context} visible models={models} /></PreviewModeProvider>);
  const field = screen.getByRole("textbox", { name: "压缩阈值" });
  await waitFor(() => expect((field as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(field, { target: { value: "f400k" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存阈值" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "保存阈值" }));
  expect((await screen.findByRole("alertdialog")).textContent).toContain("Opens 1M window; >200K costs more");
  fireEvent.change(field, { target: { value: "80%" } });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.change(field, { target: { value: "f400k" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存阈值" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "保存阈值" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认并保存" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("models.compaction.set", { sessionId: "main", selector: "acme/small", input: "f400k", confirmed: true }));
});

it("retains per-model preview edits without Host writes, and shows no invented values when Runtime is disconnected", async () => {
  const { client, command } = nativeClient();
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const view = render(<PreviewModeProvider switchEnabled><ModelCompactionPane client={client} context={context} visible models={models} /></PreviewModeProvider>);
  const field = screen.getByRole("textbox", { name: "压缩阈值" }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "80%" } });
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("80");
  fireEvent.click(screen.getByRole("button", { name: "保存阈值" }));
  await chooseModel("Wide");
  await chooseModel("Small");
  await waitFor(() => expect(field.value).toBe("80%"));
  expect(command).not.toHaveBeenCalled();
  view.unmount();
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  render(<PreviewModeProvider switchEnabled><ModelCompactionPane client={client} context={{ ...context, available: false }} visible models={models} /></PreviewModeProvider>);
  expect((screen.getByRole("textbox", { name: "压缩阈值" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.getByText("连接支持模型压缩配置的 Runtime 后可编辑。")).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
});
