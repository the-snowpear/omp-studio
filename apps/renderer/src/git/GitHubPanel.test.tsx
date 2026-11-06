import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { previewGithubSource } from "../preview/githubPreview";
import { GitHubPanel } from "./GitHubPanel";

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

it("previews PR discussion and selected diffs as a reference without invoking the real client", async () => {
  window.history.replaceState({}, "", "/?preview=1");
  const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  const insert = vi.fn();
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider><GitHubPanel client={client} kind="pr" onReference={insert} /></PreviewModeProvider></I18nProvider>);
  fireEvent.click(await screen.findByText("修复 Mermaid 主题切换并补充回归验证"));
  fireEvent.click(await screen.findByRole("tab", { name: "Discussion (2)" }));
  expect(screen.getByText("components/MermaidBlock.tsx:146")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(await screen.findByRole("button", { name: /components\/MermaidBlock.tsx/ }));
  const checkbox = await screen.findByLabelText("Include this file diff in the reference");
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Add to composer" }));
  await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
  expect(insert.mock.calls[0]![0]).toMatchObject({ repository: { remote: "origin" }, item: { number: 47 }, comments: expect.any(Array), diffs: [expect.objectContaining({ path: "components/MermaidBlock.tsx" })] });
  expect(client.query).not.toHaveBeenCalled(); expect(client.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
  expect(screen.getByText("修复 Mermaid 主题切换并补充回归验证")).toBeTruthy();
});

it("queries only the selected repository and preserves a loaded list when selecting details", async () => {
  const query = vi.fn((name, input) => previewGithubSource.query(name, input));
  const client = { query, command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><GitHubPanel client={client} workspaceId={"workspace" as WorkspaceId} kind="issue" onReference={vi.fn()} /></I18nProvider>);
  fireEvent.click(await screen.findByText("切换主题后 Mermaid 图表没有更新"));
  await screen.findByRole("button", { name: "Add to composer" });
  expect(query.mock.calls.filter(([name]) => name === "github.items.list")).toHaveLength(1);
  fireEvent.click(screen.getByRole("combobox", { name: "Remote repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "upstream/omp-studio · upstream" }));
  await waitFor(() => expect(query).toHaveBeenCalledWith("github.items.list", expect.objectContaining({ remote: "upstream" })));
  expect(client.command).not.toHaveBeenCalled();
});

it("does not insert a late reference from the repository the user has left", async () => {
  let release!: (value: Awaited<ReturnType<typeof previewGithubSource.query<"github.items.get">>>) => void;
  const delayed = new Promise<Awaited<ReturnType<typeof previewGithubSource.query<"github.items.get">>>>(resolve => { release = resolve; });
  const query = vi.fn((name, input) => name === "github.items.get" && input.remote === "origin" ? delayed : previewGithubSource.query(name, input));
  const client = { query, command: vi.fn() } as unknown as StudioClient;
  const insert = vi.fn();
  const workspaceId = "workspace" as WorkspaceId;
  render(<I18nProvider forcedLanguage="en"><GitHubPanel client={client} workspaceId={workspaceId} kind="issue" onReference={insert} /></I18nProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Add to composer #42" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Remote repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "upstream/omp-studio · upstream" }));
  await waitFor(() => expect(query).toHaveBeenCalledWith("github.items.list", expect.objectContaining({ remote: "upstream" })));
  release(await previewGithubSource.query("github.items.get", { workspaceId, remote: "origin", kind: "issue", number: 42 }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Add to composer #42" }) as HTMLButtonElement).disabled).toBe(false));
  expect(insert).not.toHaveBeenCalled();
});
