/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { selectOption } from "../test/selectOption";
import { useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { RemoteApi, RemoteInventory } from "../../../desktop/src/remote/shared";
import { RemoteScopeNotice } from "./RemoteScopeNotice";
import { ExecutionTargets, useExecutionTarget, useTargetMemory } from "./ExecutionTargets";
import { ExecutionTargetPicker } from "./ExecutionTargetPicker";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";

vi.mock("../platform", async importOriginal => ({ ...await importOriginal<typeof import("../platform")>(), PLATFORM: "win32" }));
const local = { subscribe: () => () => {}, close: async () => {} } as unknown as StudioClient;
afterEach(() => { cleanup(); globalThis.ompStudioRemote = undefined; localStorage.clear(); });
function Surface() {
  const target = useExecutionTarget();
  const [draft, setDraft] = useTargetMemory("draft", () => "");
  const [error, setError] = useState("");
  return <><span data-testid="target">{target.id ?? "local"}</span><input aria-label="draft" value={draft} onChange={e => setDraft(e.target.value)} /><button onClick={() => void target.select("remote").catch(e => setError(e.message))}>remote</button><button onClick={() => void target.select(null)}>local</button><span>{error}</span></>;
}
function ConnectSurface() {
  const target = useExecutionTarget();
  return <button onClick={() => void target.connect("new-remote")}>connect new</button>;
}
function bootstrap(): ClientBootstrap {
  return { contractVersion: 2, authority: { authorityId: "authority", authorityEpoch: 1 }, runtime: { status: "unavailable", classification: "unavailable" }, surface: { terminalAttach: false, fileReveal: false, previewInput: false, openExternal: false }, capabilityManifest: { profile: "full-parity-v1", generatedAt: "2026-10-25", hash: "test", capabilities: [] }, commandManifestHash: "test", selected: { workspaceId: "ws" } } as unknown as ClientBootstrap;
}
function api() {
  return { list: vi.fn(async () => ({ profiles: [{ id: "remote", name: "Test", host: "test", platform: "linux" }], statuses: [{ id: "remote", state: "connected" }] })), onChanged: () => () => {}, onEvent: () => () => {}, select: vi.fn(async () => {}), bootstrap: vi.fn(async () => bootstrap()), connect: vi.fn(), save: vi.fn(), disconnect: vi.fn() } as unknown as RemoteApi;
}
it("keeps drafts on their original execution target when switching back", async () => {
  globalThis.ompStudioRemote = api();
  render(<ExecutionTargets client={local}>{(_client, key) => <Surface key={key} />}</ExecutionTargets>);
  fireEvent.change(await screen.findByLabelText("draft"), { target: { value: "local-only" } });
  fireEvent.click(screen.getByText("remote"));
  await waitFor(() => expect(screen.getByTestId("target").textContent).toBe("remote"));
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "remote-only" } });
  fireEvent.click(screen.getByText("local"));
  await waitFor(() => expect(screen.getByTestId("target").textContent).toBe("local"));
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("local-only");
});
it("a failed remote bootstrap preserves the local target and draft", async () => {
  const remote = api(); remote.bootstrap = vi.fn(async () => { throw new Error("SSH unavailable"); }); globalThis.ompStudioRemote = remote;
  render(<ExecutionTargets client={local}>{(_client, key) => <Surface key={key} />}</ExecutionTargets>);
  fireEvent.change(await screen.findByLabelText("draft"), { target: { value: "keep me" } }); fireEvent.click(screen.getByText("remote"));
  await screen.findByText("SSH unavailable");
  expect(screen.getByTestId("target").textContent).toBe("local"); expect(remote.select).not.toHaveBeenCalled();
});
function RecoverySurface() {
  const target = useExecutionTarget();
  const [draft, setDraft] = useState("");
  return <><input aria-label="unsaved form" value={draft} onChange={event => setDraft(event.target.value)} /><span data-testid="connection-state">{target.inventory.statuses[0]?.state}</span><span data-testid="sync-revision">{target.syncRevision}</span><RemoteScopeNotice /></>;
}
function recoveryApi() {
  let changed = () => {};
  let inventory: RemoteInventory = { profiles: [{ id: "remote", name: "Test", host: "test", platform: "linux" }], statuses: [{ id: "remote", state: "connected", generation: 1 }], activeId: "remote" };
  const remote = api();
  remote.list = vi.fn(async () => inventory);
  remote.onChanged = listener => { changed = listener; return () => {}; };
  remote.disconnect = vi.fn(async () => { inventory = { ...inventory, statuses: [{ id: "remote", state: "disconnected", generation: inventory.statuses[0]?.generation ?? 0 }] }; changed(); });
  globalThis.ompStudioRemote = remote;
  render(<ExecutionTargets client={local}>{(_client, key) => <PreviewModeProvider switchEnabled><RecoverySurface key={key} /></PreviewModeProvider>}</ExecutionTargets>);
  return { remote, update: (state: RemoteInventory["statuses"][number]["state"], generation = 1) => { inventory = { ...inventory, statuses: [{ id: "remote", state, generation }] }; changed(); } };
}
it("recovery synchronizes the existing client before enabling writes and preserves an unsaved form", async () => {
  const f = recoveryApi();
  await waitFor(() => expect(screen.getByTestId("connection-state").textContent).toBe("connected"));
  fireEvent.change(screen.getByLabelText("unsaved form"), { target: { value: "keep this edit" } });
  await act(async () => f.update("recovering"));
  expect(screen.getByTestId("connection-state").textContent).toBe("recovering");
  let release!: (value: ClientBootstrap) => void;
  f.remote.bootstrap = vi.fn(() => new Promise<ClientBootstrap>(resolve => { release = resolve; }));
  await act(async () => f.update("connected", 2));
  expect(screen.getByTestId("connection-state").textContent).toBe("synchronizing");
  await act(async () => release(bootstrap()));
  await waitFor(() => expect(screen.getByTestId("connection-state").textContent).toBe("connected"));
  expect((screen.getByLabelText("unsaved form") as HTMLInputElement).value).toBe("keep this edit");
  expect(screen.getByTestId("sync-revision").textContent).toBe("2");
  expect(f.remote.connect).not.toHaveBeenCalled(); expect(f.remote.select).not.toHaveBeenCalled();
});
it("a failed page sync offers resync rather than redeployment or another password prompt", async () => {
  const f = recoveryApi();
  await waitFor(() => expect(screen.getByTestId("connection-state").textContent).toBe("connected"));
  await act(async () => f.update("recovering"));
  f.remote.bootstrap = vi.fn(async () => { throw new Error("snapshot unavailable"); });
  await act(async () => f.update("connected", 2));
  await screen.findByRole("button", { name: "重新同步" });
  f.remote.bootstrap = vi.fn(async () => bootstrap());
  fireEvent.click(screen.getByRole("button", { name: "重新同步" }));
  await waitFor(() => expect(screen.getByTestId("connection-state").textContent).toBe("connected"));
  expect(f.remote.connect).not.toHaveBeenCalled(); expect(f.remote.select).not.toHaveBeenCalled();
});
it("cancel during recovery calls disconnect without changing execution target", async () => {
  const f = recoveryApi();
  await waitFor(() => expect(screen.getByTestId("connection-state").textContent).toBe("connected"));
  await act(async () => f.update("recovering"));
  fireEvent.click(screen.getByRole("button", { name: "取消恢复" }));
  await waitFor(() => expect(f.remote.disconnect).toHaveBeenCalledWith("remote"));
  expect(f.remote.select).not.toHaveBeenCalled();
});
it("preview target selection never connects to a real SSH host", async () => {
  const remote = api(); globalThis.ompStudioRemote = remote; localStorage.setItem("omp.previewMode", "1");
  render(<ExecutionTargets client={local}>{() => <PreviewModeProvider switchEnabled><ExecutionTargetPicker /></PreviewModeProvider>}</ExecutionTargets>);
  fireEvent.click(await screen.findByRole("button", { name: /此计算机/ })); fireEvent.click(screen.getByRole("menuitem", { name: /dev-linux/ }));
  expect(screen.getByRole("button", { name: /SSH · dev-linux/ })).toBeTruthy(); expect(remote.connect).not.toHaveBeenCalled(); expect(remote.select).not.toHaveBeenCalled();
});

it("keeps authentication inside the connection dialog and identifies the target system automatically", async () => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); },
    close(this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  const remote = api(); globalThis.ompStudioRemote = remote;
  render(<ExecutionTargets client={local}>{() => <PreviewModeProvider switchEnabled><ExecutionTargetPicker /></PreviewModeProvider>}</ExecutionTargets>);
  fireEvent.click(await screen.findByRole("button", { name: /此计算机/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加 SSH 连接" }));
  const dialog = screen.getByRole("dialog", { name: "添加 SSH 连接" });
  const auth = screen.getByRole("combobox", { name: /认证方式/ });
  fireEvent.click(auth);
  expect(dialog.contains(screen.getByRole("listbox"))).toBe(true);
  selectOption(auth, "用户名和密码");
  expect(screen.queryByRole("combobox", { name: /远端系统/ })).toBeNull();
  expect(screen.getByText(/连接后自动识别 Windows/)).toBeTruthy();
  expect(screen.getByLabelText("用户名").hasAttribute("required")).toBe(true);
  expect(remote.save).not.toHaveBeenCalled();
});

it("loads a just-saved connection when connect runs before the inventory rerender", async () => {
  let inventory: RemoteInventory = { profiles: [], statuses: [] };
  const remote = api();
  remote.list = vi.fn(async () => inventory);
  remote.connect = vi.fn(async () => {});
  remote.save = vi.fn(async () => { throw new Error("not used"); });
  remote.onChanged = () => () => {};
  globalThis.ompStudioRemote = remote;
  render(<ExecutionTargets client={local}>{() => <ConnectSurface />}</ExecutionTargets>);
  await screen.findByText("connect new");
  inventory = { profiles: [{ id: "new-remote", name: "New", host: "new" }], statuses: [{ id: "new-remote", state: "disconnected" }] };
  fireEvent.click(screen.getByText("connect new"));
  await waitFor(() => expect(remote.connect).toHaveBeenCalledWith("new-remote", undefined));
});

it("refreshes WSL distributions, translates the mounted menu and connects the ensured profile", async () => {
  const remote = api();
  const profile = { id: "wsl-Ubuntu", host: "Ubuntu", name: "Ubuntu", kind: "wsl" as const, distro: "Ubuntu" };
  const ensure = vi.fn(async () => profile);
  remote.ensureWsl = ensure;
  remote.wslDistributions = vi.fn(async () => ({ available: true, distributions: [
    { name: "Ubuntu", version: 2 as const, running: true, isDefault: true }, { name: "Legacy", version: 1 as const, running: false, isDefault: false },
  ] }));
  remote.list = vi.fn(async () => ({ profiles: [profile], statuses: [] }));
  globalThis.ompStudioRemote = remote;
  const tree = (lang: "zh" | "en") => <I18nProvider forcedLanguage={lang}><ExecutionTargets client={local}>{() => <ExecutionTargetPicker />}</ExecutionTargets></I18nProvider>;
  const ui = render(tree("zh"));
  fireEvent.click(await screen.findByRole("button", { name: /此计算机/ }));
  expect(await screen.findByRole("menuitem", { name: /Ubuntu.*运行中/ })).toBeTruthy();
  ui.rerender(tree("en"));
  expect(await screen.findByRole("menuitem", { name: /Ubuntu.*Running/ })).toBeTruthy();
  expect((screen.getByRole("menuitem", { name: /Legacy.*Requires WSL 2/ }) as HTMLButtonElement).disabled).toBe(true);
  ui.rerender(tree("zh"));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Ubuntu.*运行中/ }));
  await waitFor(() => expect(remote.connect).toHaveBeenCalled());
  expect(ensure).toHaveBeenCalledWith("Ubuntu");
  expect(vi.mocked(remote.connect).mock.calls[0]?.[0]).toBe(profile.id);
});
it("omits the group when WSL discovery reports unavailable", async () => {
  const remote = api();
  remote.wslDistributions = vi.fn(async () => ({ available: false, distributions: [] }));
  globalThis.ompStudioRemote = remote;
  render(<ExecutionTargets client={local}>{() => <ExecutionTargetPicker />}</ExecutionTargets>);
  fireEvent.click(await screen.findByRole("button", { name: /此计算机/ }));
  expect(await screen.findByRole("menuitem", { name: /Test/ })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("WSL")).toBeNull());
});

it("WSL preview keeps the selected distro and directory draft across language changes without touching the Host", async () => {
  const remote = api();
  remote.ensureWsl = vi.fn();
  remote.wslDistributions = vi.fn();
  globalThis.ompStudioRemote = remote;
  localStorage.setItem("omp.previewMode", "1");
  const tree = (lang: "zh" | "en") => <PreviewModeProvider switchEnabled><I18nProvider forcedLanguage={lang}><ExecutionTargets client={local}>{() => <ExecutionTargetPicker />}</ExecutionTargets></I18nProvider></PreviewModeProvider>;
  const ui = render(tree("zh"));
  fireEvent.click(await screen.findByRole("button", { name: /此计算机/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Ubuntu-24.04/ }));
  fireEvent.click(screen.getByRole("button", { name: /WSL · Ubuntu/ }));
  expect(await screen.findByText(/默认使用 WSL 网络，失败时/)).toBeTruthy();
  ui.rerender(tree("en"));
  expect(await screen.findByText(/Uses the WSL network first and falls back/)).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Select WSL directory" }));
  fireEvent.change(screen.getByLabelText("Linux absolute path"), { target: { value: "/mnt/c/test" } });
  expect(await screen.findByText(/This directory is on a Windows drive/)).toBeTruthy();
  ui.rerender(tree("zh"));
  expect((screen.getByLabelText("Linux 绝对路径") as HTMLInputElement).value).toBe("/mnt/c/test");
  expect(await screen.findByText(/该目录位于 Windows 磁盘/)).toBeTruthy();
  expect(remote.ensureWsl).not.toHaveBeenCalled();
  expect(remote.wslDistributions).not.toHaveBeenCalled();
  expect(remote.connect).not.toHaveBeenCalled();
});
