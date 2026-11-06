import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitHubReference, GitOperation, GitRepositoryReadModel, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { GitQuickCard } from "./GitQuickCard";
import { GitWorkbench, type GitOpenIntent } from "./GitWorkbench";
import { GitWorkspaceProvider, useGitWorkspace } from "./GitWorkspaceContext";

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); localStorage.clear(); });

it("shares preview staging and commit drafts with the full view and adds a PR reference without Host writes", async () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  const references: GitHubReference[] = [];
  function Both() {
    const [intent, setIntent] = useState<GitOpenIntent>();
    return <I18nProvider forcedLanguage="en"><PreviewModeProvider><GitWorkspaceProvider client={client}>
      <GitQuickCard client={client} visible worktrees={null} onOpen={next => setIntent({ ...next, key: Date.now() })} onReference={reference => references.push(reference)} onCommitReference={vi.fn()} />
      <GitWorkbench client={client} visible workspaceName="demo" intent={intent} worktrees={null} onReference={reference => references.push(reference)} />
    </GitWorkspaceProvider></PreviewModeProvider></I18nProvider>;
  }
  render(<Both />);
  const card = within(screen.getByRole("region", { name: "Git quick card" }));
  await card.findByRole("button", { name: "Add PR #47 to composer" });
  fireEvent.change(card.getByRole("textbox", { name: "Commit message" }), { target: { value: "fix theme" } });
  expect((screen.getByPlaceholderText("Commit message") as HTMLTextAreaElement).value).toBe("fix theme");
  fireEvent.keyDown(card.getByRole("tab", { name: "Changes" }), { key: "ArrowRight" });
  expect(card.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(card.getByRole("tab", { name: "History" }));
  await card.findByText("Initial commit");
  expect(card.queryByRole("textbox", { name: "Commit message" })).toBeNull();
  fireEvent.click(card.getByRole("tab", { name: "Issues" }));
  fireEvent.click(await card.findByRole("button", { name: "Add Issue #42 to composer" }));
  await waitFor(() => expect(references).toHaveLength(1));
  expect(references[0]).toMatchObject({ item: { kind: "issue", number: 42, body: expect.stringContaining("复现步骤") }, comments: expect.any(Array) });
  references.length = 0;
  fireEvent.click(card.getByRole("tab", { name: "PR" }));
  await card.findByRole("button", { name: "Add PR #44 to composer" });
  fireEvent.click(card.getByRole("button", { name: "View all" }));
  expect(await screen.findByRole("combobox", { name: "Remote repository" })).toBeTruthy();
  fireEvent.click(card.getByRole("tab", { name: "Changes" }));
  expect((card.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("fix theme");
  // Restore the full local view before checking shared staging and drafts.
  fireEvent.click(card.getByRole("button", { name: "View all" }));
  fireEvent.click(card.getByRole("button", { name: "Stage components/MermaidBlock.tsx" }));
  await card.findByRole("button", { name: "Staged 3" });
  fireEvent.click(card.getByRole("button", { name: "Staged 3" }));
  expect(card.getByRole("button", { name: "Unstage components/MermaidBlock.tsx" })).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Open components/MermaidBlock.tsx" }));
  expect(screen.getByText("components/MermaidBlock.tsx", { selector: ".diff-toolbar span" })).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Add PR #47 to composer" }));
  await waitFor(() => expect(references).toHaveLength(1));
  expect(references[0]).toMatchObject({ repository: { remote: "origin" }, item: { number: 47, headOid: "preview-head-47" }, comments: expect.any(Array), diffs: [] });
  expect(references[0]?.comments).toHaveLength(2);
  fireEvent.click(card.getByRole("button", { name: "Commit" }));
  await waitFor(() => expect((card.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe(""));
  expect((screen.getByPlaceholderText("Commit message") as HTMLTextAreaElement).value).toBe("");
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});

it("remembers quick tabs per workspace and isolates preview from real views", async () => {
  const client = { query: vi.fn(async (name, input) => name === "git.repository.get" ? { workspaceId: input.workspaceId, isRepository: false, changes: [], ahead: 0, behind: 0 } : { workspaceId: input.workspaceId, repositories: [] }), command: vi.fn(), subscribe: vi.fn(() => () => {}) } as unknown as StudioClient;
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const first = "quick-tab-first" as WorkspaceId, second = "quick-tab-second" as WorkspaceId;
  function Surface({ workspace }: { workspace: WorkspaceId }) {
    return <I18nProvider forcedLanguage="en"><PreviewModeProvider><GitWorkspaceProvider key={workspace} client={client} workspaceId={workspace}>
      <GitQuickCard client={client} workspaceId={workspace} visible worktrees={null} onOpen={vi.fn()} onReference={vi.fn()} onCommitReference={vi.fn()} />
    </GitWorkspaceProvider></PreviewModeProvider></I18nProvider>;
  }
  const app = render(<Surface workspace={first} />);
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  fireEvent.click(await screen.findByRole("tab", { name: "History graph" }));
  fireEvent.click(screen.getByRole("tab", { name: "Issues" }));
  await screen.findByRole("button", { name: "Add Issue #42 to composer" });
  app.rerender(<Surface workspace={second} />);
  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true");
  app.rerender(<Surface workspace={first} />);
  expect(screen.getByRole("tab", { name: "Issues" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  expect(screen.getByRole("tab", { name: "History graph" }).getAttribute("aria-selected")).toBe("true");
  app.unmount();
  window.history.replaceState({}, "", "/?preview=0");
  render(<Surface workspace={first} />);
  await screen.findByText("Not a Git repository");
  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("button", { name: "Add Issue #42 to composer" })).toBeNull();
});

it("loads only the chosen list, prioritizes branch PRs, and discards a late result from the previous remote", async () => {
  const workspaceId = "quick-reads" as WorkspaceId;
  const repositories = ["origin", "upstream"].map(remote => ({ remote, host: "github.com", ownerRepo: `${remote}/project`, url: `https://github.com/${remote}/project` }));
  const item = (number: number, kind = "pr", headBranch = "other") => ({ kind, number, title: `${kind} title ${number}`, headBranch, body: "Source body", url: `https://github.com/origin/project/pull/${number}`, state: "open", author: "Ada", labels: ["bug"], commentCount: 0, updatedAt: `2026-11-01T10:${String(number).padStart(2, "0")}:00Z` });
  let resolveOrigin!: (value: unknown) => void;
  const query = vi.fn(async (name: string, input: { workspaceId: WorkspaceId; remote?: string; kind?: string; search?: string; number?: number }) => {
    const repository = repositories.find(repo => repo.remote === input.remote) ?? repositories[0];
    if (name === "git.repository.get") return { workspaceId, isRepository: true, branch: "main", headOid: "head", changes: [], ahead: 0, behind: 0 };
    if (name === "github.repositories.list") return { workspaceId, repositories };
    if (name === "github.auth.get") return { available: true, authenticated: true };
    if (name === "git.log.list") return { workspaceId, headOid: "abcdef0", mergeBaseOid: "abcdef2", upstream: "origin/main", ahead: 2, behind: 0, truncated: true,
      commits: Array.from({ length: 8 }, (_, index) => ({ oid: `abcdef${index}`, subject: `Commit ${index}`, authorName: "Ada", authorDate: "2026-11-01T10:00:00Z",
        refs: index === 0 ? [{ name: "main", kind: "local", current: true }] : index === 2 ? [{ name: "origin/main", kind: "remote", current: false }] : [],
        parents: index === 0 ? ["abcdef2", "abcdef1"] : index < 7 ? [`abcdef${index + 1}`] : [], relation: index === 0 ? "head" : "common" })) };
    if (name === "git.commit.changes") return { workspaceId, oid: "abcdef0", subject: "Commit 0", files: [{ path: "src/a.ts", status: "modified" }] };
    if (name === "github.items.get") return { repository, item: item(input.number!, "issue"), checks: [] };
    if (name === "github.discussion.list") return { comments: [] };
    if (name === "github.items.list") {
      if (input.kind === "issue" && input.remote === "origin") return new Promise(resolve => { resolveOrigin = resolve; });
      const items = input.kind === "issue" ? [item(42, "issue")] : input.search ? [item(1, "pr", "main")] : [item(4), item(3), item(2)];
      return { repository, items, totalCount: items.length };
    }
    throw Error(name);
  });
  const client = { query, subscribe: vi.fn(() => () => {}), command: vi.fn() } as unknown as StudioClient;
  const onOpen = vi.fn(), onReference = vi.fn(), onCommitReference = vi.fn();
  function Controls() { const shared = useGitWorkspace(); return <button onClick={() => shared.setRemote("upstream")}>Use upstream</button>; }
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider><GitWorkspaceProvider client={client} workspaceId={workspaceId}>
    <Controls /><GitQuickCard client={client} workspaceId={workspaceId} workspaceName="Project A" visible worktrees={null} onOpen={onOpen} onReference={onReference} onCommitReference={onCommitReference} />
  </GitWorkspaceProvider></PreviewModeProvider></I18nProvider>);
  await screen.findByRole("button", { name: "Add PR #1 to composer" });
  expect(query.mock.calls.some(([name]) => name === "git.log.list")).toBe(false);
  expect(query.mock.calls.some(([name, args]) => name === "github.items.list" && args.kind === "issue")).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByText("Commit 4");
  expect(screen.queryByText("Commit 5")).toBeNull();
  expect(query).toHaveBeenCalledWith("git.log.list", { workspaceId, limit: 5 });
  fireEvent.keyDown(screen.getByRole("tab", { name: "List view" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "History graph" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "History graph" }));
  expect(screen.getByText("Outgoing Changes")).toBeTruthy();
  expect(screen.getByText("origin/main", { selector: ".git-ref-scroll" })).toBeTruthy();
  expect(document.querySelectorAll(".git-quick-tree-row .git-graph-svg path").length).toBeGreaterThan(0);
  expect(query.mock.calls.filter(([name]) => name === "git.log.list")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Add commit abcdef0 to composer" }));
  await waitFor(() => expect(onCommitReference).toHaveBeenCalledWith(expect.objectContaining({ kind: "commit", oid: "abcdef0", text: expect.stringContaining("modified: src/a.ts") })));
  expect(query).toHaveBeenCalledWith("git.commit.changes", { workspaceId, oid: "abcdef0" });
  expect(onCommitReference.mock.calls[0]?.[0].text).toContain("Workspace: Project A");
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "List view" }));
  expect(screen.getByText("abcdef0")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "PR" }));
  await screen.findByRole("button", { name: "Add PR #4 to composer" });
  const rows = [...document.querySelectorAll(".git-quick-items .git-quick-pr-main strong")].map(node => node.textContent);
  expect(rows).toEqual(["#1", "#4", "#3"]);
  fireEvent.click(screen.getByRole("button", { name: "View all" }));
  expect(onOpen).toHaveBeenLastCalledWith({ view: "pr", remote: "origin" });
  fireEvent.click(screen.getByRole("tab", { name: "Issues" }));
  await waitFor(() => expect(resolveOrigin).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Use upstream" }));
  await screen.findByRole("button", { name: "Add Issue #42 to composer" });
  await act(async () => resolveOrigin({ repository: repositories[0], items: [item(9, "issue")], totalCount: 1 }));
  expect(screen.queryByRole("button", { name: "Add Issue #9 to composer" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add Issue #42 to composer" }));
  await waitFor(() => expect(onReference).toHaveBeenCalledWith(expect.objectContaining({ repository: expect.objectContaining({ remote: "upstream" }) })));
  expect(client.command).not.toHaveBeenCalled();
});

it("adds the preview commit snapshot without reading or writing the Host", async () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  const onCommitReference = vi.fn(), onOpen = vi.fn();
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider><GitWorkspaceProvider client={client}>
    <GitQuickCard client={client} visible worktrees={null} onOpen={onOpen} onReference={vi.fn()} onCommitReference={onCommitReference} />
  </GitWorkspaceProvider></PreviewModeProvider></I18nProvider>);
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  fireEvent.click(await screen.findByRole("tab", { name: "History graph" }));
  expect(await screen.findByText("Outgoing Changes")).toBeTruthy();
  expect(screen.getByText("origin/main", { selector: ".git-ref-scroll" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Add commit aaaaaaa to composer" }));
  await waitFor(() => expect(onCommitReference).toHaveBeenCalledWith(expect.objectContaining({ kind: "commit", oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", text: expect.stringContaining("apps/renderer/src/conversation/SessionChanges.tsx") })));
  expect(client.query).not.toHaveBeenCalled();
  expect(client.command).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

it("keeps a failed real commit draft and sends successful commits through the existing Git command", async () => {
  const workspaceId = "quick-real-workspace" as WorkspaceId;
  const repository: GitRepositoryReadModel = { workspaceId, isRepository: true, branch: "main", detached: false, unborn: false, ahead: 1, behind: 0, stashCount: 0,
    changes: [{ path: "src/a.ts", index: "modified", worktree: "unmodified", conflicted: false }] };
  let fail = true;
  const command = vi.fn(async (_name: string, input: { operation: GitOperation }) => {
    if (input.operation.kind === "commit" && fail) throw Error("Commit rejected");
    return { requestId: "request-1" };
  });
  const client = {
    query: vi.fn(async (name: string) => name === "git.repository.get" ? repository : { workspaceId, repositories: [] }),
    subscribe: vi.fn(() => () => {}), command,
    getState: () => ({ commands: { "request-1": { status: "completed", result: { message: "Committed" } } } }),
  } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider><GitWorkspaceProvider client={client} workspaceId={workspaceId}>
    <GitQuickCard client={client} workspaceId={workspaceId} visible worktrees={null} onOpen={vi.fn()} onReference={vi.fn()} onCommitReference={vi.fn()} />
  </GitWorkspaceProvider></PreviewModeProvider></I18nProvider>);
  const card = within(screen.getByRole("region", { name: "Git quick card" }));
  await card.findByRole("button", { name: "Staged 1" });
  fireEvent.change(card.getByRole("textbox", { name: "Commit message" }), { target: { value: "keep this draft" } });
  fireEvent.click(card.getByRole("button", { name: "Commit" }));
  await card.findByText("Commit rejected");
  expect((card.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe("keep this draft");
  fail = false;
  fireEvent.click(card.getByRole("button", { name: "Commit" }));
  await waitFor(() => expect((card.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement).value).toBe(""));
  expect(command).toHaveBeenLastCalledWith("git.execute", { workspaceId, operation: { kind: "commit", message: "keep this draft" } });
});

it("opens the requested PR and follows a subsequent remote selection for references", async () => {
  window.history.replaceState({}, "", "/?preview=1&marks=off");
  const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  const references: GitHubReference[] = [];
  function Both() {
    const [intent, setIntent] = useState<GitOpenIntent>();
    return <I18nProvider forcedLanguage="en"><PreviewModeProvider><GitWorkspaceProvider client={client}>
      <GitQuickCard client={client} visible worktrees={null} onOpen={next => setIntent({ ...next, key: Date.now() })} onReference={reference => references.push(reference)} onCommitReference={vi.fn()} />
      <GitWorkbench client={client} visible workspaceName="demo" intent={intent} worktrees={null} onReference={reference => references.push(reference)} />
    </GitWorkspaceProvider></PreviewModeProvider></I18nProvider>;
  }
  render(<Both />);
  const card = within(screen.getByRole("region", { name: "Git quick card" }));
  fireEvent.click(await card.findByRole("button", { name: /#47.*修复 Mermaid/ }));
  expect(await screen.findByRole("button", { name: "Add to composer" })).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "Remote repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "upstream/omp-studio · upstream" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Add to composer" })).toBeNull());
  fireEvent.click(await card.findByRole("button", { name: "Add PR #47 to composer" }));
  await waitFor(() => expect(references[0]?.repository.remote).toBe("upstream"));
});

it("does not clear the next workspace draft when an earlier commit finishes", async () => {
  const first = "quick-first" as WorkspaceId, second = "quick-second" as WorkspaceId;
  let finish!: (value: unknown) => void;
  const command = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const client = {
    query: vi.fn(async (name: string, input: { workspaceId: WorkspaceId }) => name === "git.repository.get"
      ? { workspaceId: input.workspaceId, isRepository: true, branch: "main", detached: false, unborn: false, ahead: 0, behind: 0, stashCount: 0, changes: [{ path: "src/a.ts", index: "modified", worktree: "unmodified", conflicted: false }] }
      : { workspaceId: input.workspaceId, repositories: [] }),
    subscribe: vi.fn(() => () => {}), command,
    getState: () => ({ commands: { "request-1": { status: "completed", result: { message: "Committed" } } } }),
  } as unknown as StudioClient;
  function Switcher() {
    const [workspace, setWorkspace] = useState(first);
    return <I18nProvider forcedLanguage="en"><PreviewModeProvider><button onClick={() => setWorkspace(second)}>Next workspace</button><GitWorkspaceProvider key={workspace} client={client} workspaceId={workspace}>
      <GitQuickCard client={client} workspaceId={workspace} visible worktrees={null} onOpen={vi.fn()} onReference={vi.fn()} onCommitReference={vi.fn()} />
    </GitWorkspaceProvider></PreviewModeProvider></I18nProvider>;
  }
  render(<Switcher />);
  const message = () => screen.getByRole("textbox", { name: "Commit message" }) as HTMLTextAreaElement;
  await screen.findByRole("button", { name: "Staged 1" });
  fireEvent.change(message(), { target: { value: "same draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));
  fireEvent.click(screen.getByRole("button", { name: "Next workspace" }));
  await screen.findByRole("button", { name: "Staged 1" });
  fireEvent.change(message(), { target: { value: "same draft" } });
  await act(async () => { finish({ requestId: "request-1" }); await Promise.resolve(); await Promise.resolve(); });
  expect(message().value).toBe("same draft");
});
