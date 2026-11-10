import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitRepositoryReadModel, WorkspaceId } from "@omp-studio/client-contract";
import { EnvironmentCard, EnvironmentDockCard } from "./EnvironmentCard";
import { parentAddress } from "./environmentCardModel";
import { DockProvider } from "../dock/DockContext";
import { DockStore } from "../dock/store";
import { WORKBENCH_PANELS } from "../panels/registry";

afterEach(cleanup);

const change = (path: string): GitFileChange => ({ path, index: "unmodified", worktree: "modified", conflicted: false });

const repository = (over: Partial<GitRepositoryReadModel> = {}): GitRepositoryReadModel => ({
  workspaceId: "workspace" as WorkspaceId,
  isRepository: true,
  branch: "main",
  detached: false,
  unborn: false,
  upstream: "origin/main",
  ahead: 2,
  behind: 0,
  stashCount: 0,
  changes: [change("src/App.tsx"), change("src/main.tsx"), change("src/index.css")],
  insertions: 42,
  deletions: 7,
  ...over,
});

/** Build a repository read model that genuinely omits a field (exactOptionalPropertyTypes). */
function repositoryWithout(keys: ReadonlyArray<keyof GitRepositoryReadModel>, over: Partial<GitRepositoryReadModel> = {}): GitRepositoryReadModel {
  const model: Record<string, unknown> = { ...repository(), ...over };
  for (const key of keys) delete model[key];
  return model as unknown as GitRepositoryReadModel;
}

function renderCard(over: Partial<Parameters<typeof EnvironmentCard>[0]> = {}) {
  return render(<EnvironmentCard
    target={{ remote: false }}
    runtimeStatus="connected"
    version="v0.82.1"
    project={{ name: "omp-studio", root: "D:\\Project\\omp-studio" }}
    repository={{ repository: repository(), loading: false }}
    {...over}
  />);
}

describe("EnvironmentCard", () => {
  it("reads as two axes: project and Git position on the left, machine and version on the right", () => {
    renderCard();
    expect(screen.getByText("omp-studio")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("↑2")).toBeTruthy();
    expect(screen.queryByText("↓0")).toBeNull();
    expect(screen.getByText("此计算机")).toBeTruthy();
    expect(screen.getByText("v0.82.1")).toBeTruthy();
  });

  it("puts the project on top with its address on the right", () => {
    const { container } = renderCard({ onOpenProject: () => undefined });
    const hero = screen.getByRole("button", { name: /omp-studio/ });
    expect(hero).toBe(container.querySelector(".env-hero"));
    expect(hero.textContent).toContain("omp-studio");
    expect(hero.textContent).toContain("D:\\Project");
    // The name is the leaf, so the address is the parent folder rather than a repeat.
    expect(hero.textContent).not.toContain("omp-studio\\omp-studio");
  });

  it("puts the working tree under the rule with its line totals", () => {
    renderCard();
    expect(screen.getByText("3 个文件")).toBeTruthy();
    expect(screen.getByText("+42")).toBeTruthy();
    expect(screen.getByText("−7")).toBeTruthy();
  });

  it("names the remote execution target instead of claiming the local machine", () => {
    renderCard({ target: { remote: true, name: "build-box" } });
    expect(screen.getByText("SSH · build-box")).toBeTruthy();
    expect(screen.queryByText("此计算机")).toBeNull();
  });

  it("keeps a clean tree and a missing project honest, without inventing numbers or actions", () => {
    renderCard({ project: undefined, repository: { repository: repository({ changes: [], insertions: 0, deletions: 0 }), loading: false } });
    expect(screen.getByText("未选择项目")).toBeTruthy();
    expect(screen.getByText("工作区干净")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
    expect(screen.queryByRole("button", { name: /omp-studio/ })).toBeNull();
  });

  it("says so when the workspace is not a Git repository, and offers nothing to open", () => {
    renderCard({ repository: { repository: repositoryWithout(["branch"], { isRepository: false }), loading: false } });
    expect(screen.getByText("非 Git 仓库")).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.queryByRole("button", { name: /打开 Changes 改动/ })).toBeNull();
  });

  it("shows a detached HEAD and a rebase in flight instead of a stale branch name", () => {
    renderCard({ repository: { repository: repositoryWithout(["branch"], { detached: true, operation: "rebase", ahead: 0, behind: 0 }), loading: false } });
    expect(screen.getByText("游离 HEAD")).toBeTruthy();
    expect(screen.getByText("rebase")).toBeTruthy();
    expect(screen.queryByText("↑2")).toBeNull();
  });

  it("opens the project in the file tree and the changes row in Changes", () => {
    const onOpenProject = vi.fn();
    const onOpenChanges = vi.fn();
    renderCard({ onOpenProject, onOpenChanges });
    screen.getByRole("button", { name: /omp-studio/ }).click();
    screen.getByRole("button", { name: /打开 Changes 改动/ }).click();
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });

  it("uses the branch row as the Git shortcut, titled with its upstream", () => {
    const onOpenGit = vi.fn();
    renderCard({ onOpenGit });
    screen.getByRole("button", { name: /上游 origin\/main/ }).click();
    expect(onOpenGit).toHaveBeenCalledTimes(1);
  });

  it("sends the dock wiring's changes row to the Changes panel, not Git", () => {
    const store = new DockStore(null);
    // Start on the Git tab so the assertion proves the click switched surfaces.
    store.dispatch({ type: "activate", groupId: "right-main", panel: "git" });
    render(<DockProvider definitions={WORKBENCH_PANELS} store={store}>
      <EnvironmentDockCard target={{ remote: false }} runtimeStatus="connected"
        project={{ name: "omp-studio", root: "D:\\Project\\omp-studio" }}
        repository={{ repository: repository(), loading: false }} />
    </DockProvider>);
    screen.getByRole("button", { name: /打开 Changes 改动/ }).click();
    const layout = store.getSnapshot().layout;
    expect(layout.right.groups[0]!.active).toBe("changes");
    expect(layout.right.visible).toBe(true);
  });

  it("tints the machine glyph and names the state when the Runtime is not up", () => {
    const { container } = renderCard({ runtimeStatus: "connecting" });
    expect(container.querySelector(".env-row.is-env .env-glyph")?.getAttribute("data-state")).toBe("connecting");
    expect(screen.getByText("此计算机").closest(".env-row")?.getAttribute("data-tip")).toBe("Runtime 连接中");
  });

  it("shows a reading state while the repository read is still in flight", () => {
    renderCard({ repository: { loading: true } });
    expect(screen.getAllByRole("status").length).toBe(2);
  });
});

describe("parentAddress", () => {
  it("keeps the leaf out and normalises the parent for both separators", () => {
    expect(parentAddress("D:\\Project\\omp-studio")).toBe("D:\\Project");
    expect(parentAddress("/home/me/app")).toBe("/home/me");
    expect(parentAddress("D:\\app")).toBe("D:\\");
    expect(parentAddress("/app")).toBe("/");
    expect(parentAddress("D:\\Project\\omp-studio\\\\")).toBe("D:\\Project");
    expect(parentAddress("/")).toBeUndefined();
    expect(parentAddress("relative")).toBeUndefined();
  });
});
