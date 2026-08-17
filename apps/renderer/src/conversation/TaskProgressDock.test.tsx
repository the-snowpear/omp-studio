import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_TODO_FILES, PREVIEW_TODOS } from "../preview/fixtures";
import { scrollCurrentTodoIntoList, TaskProgressDock } from "./TaskProgressDock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("task progress dock", () => {
  it("renders nothing when there are no todos and no files", () => {
    const { container } = render(<TaskProgressDock todos={[]} files={[]} />);
    expect(container.querySelector(".task-dock")).toBeNull();
  });

  it("shows the collapsed pill with step, file count, and diffstat from preview fixtures", () => {
    render(<TaskProgressDock todos={PREVIEW_TODOS} files={PREVIEW_TODO_FILES} demo />);
    const toggle = screen.getByRole("button", { name: /第 5 \/ 7 步 · 3 个文件已更改/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("+223");
    expect(toggle.textContent).toContain("-4");
    expect(screen.getByText("演示")).toBeTruthy();
    const dock = document.querySelector(".task-dock");
    const shell = document.querySelector(".task-dock-shell");
    const collapse = document.querySelector(".task-dock-collapse");
    const pill = document.querySelector(".task-dock-pill");
    expect(dock?.classList.contains("open")).toBe(false);
    expect(dock?.classList.contains("both")).toBe(true);
    expect(collapse?.getAttribute("aria-hidden")).toBe("true");
    expect(collapse?.hasAttribute("hidden")).toBe(false);
    expect(shell?.firstElementChild).toBe(collapse);
    expect(shell?.lastElementChild).toBe(pill);
  });

  it("expands into a todo list on the left and file changes on the right", () => {
    const opened: string[] = [];
    const reviewed: string[] = [];
    render(
      <TaskProgressDock
        todos={PREVIEW_TODOS}
        files={PREVIEW_TODO_FILES}
        demo
        onReview={() => { reviewed.push("review"); }}
        onOpen={(path) => { opened.push(path); }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /第 5 \/ 7 步/ }));
    expect(screen.getByRole("button", { name: /第 5 \/ 7 步/ }).getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".task-dock")?.classList.contains("open")).toBe(true);
    expect(document.querySelector(".task-dock")?.classList.contains("both")).toBe(true);
    expect(document.querySelector(".task-dock-collapse")?.getAttribute("aria-hidden")).toBe("false");
    expect(document.querySelectorAll(".task-dock-todo")).toHaveLength(PREVIEW_TODOS.length);
    expect(document.querySelectorAll(".task-dock-file")).toHaveLength(PREVIEW_TODO_FILES.length);
    const p1 = screen.getByRole("button", { name: /P1 文档/ });
    const p2 = screen.getByRole("button", { name: /P2 验证/ });
    expect(p1.textContent).toContain("P1");
    expect(p1.querySelector(".task-dock-phase-index")?.textContent).toBe("P1");
    expect(p2.querySelector(".task-dock-phase-index")?.textContent).toBe("P2");
    expect(p1.getAttribute("aria-expanded")).toBe("false");
    expect(p2.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "P2 验证" }).textContent).toContain("重新运行 typecheck 与 lint 确认通过");
    expect(screen.getByLabelText("任务列表").textContent).toContain("创建 Checkpoint #13 并汇总本轮变更");
    expect(screen.getByLabelText("文件修改").textContent).toContain("UPSTREAM-SYNC.md");
    expect(screen.getByLabelText("文件修改").textContent).toContain("MermaidBlock.tsx");
    fireEvent.click(screen.getByRole("button", { name: "审核" }));
    expect(reviewed).toEqual(["review"]);
    fireEvent.click(screen.getByRole("button", { name: /打开 docs\/UPSTREAM-SYNC.md/ }));
    expect(opened).toEqual(["docs/UPSTREAM-SYNC.md"]);
  });

  it("uses a half-width card and omits the empty column when only one side has data", () => {
    const { unmount } = render(<TaskProgressDock todos={PREVIEW_TODOS} files={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /第 5 \/ 7 步/ }));
    expect(document.querySelector(".task-dock")?.classList.contains("single")).toBe(true);
    expect(document.querySelector(".task-dock")?.classList.contains("open")).toBe(true);
    expect(screen.getByLabelText("任务列表")).toBeTruthy();
    expect(screen.queryByLabelText("文件修改")).toBeNull();
    unmount();

    render(<TaskProgressDock todos={[]} files={PREVIEW_TODO_FILES} />);
    fireEvent.click(screen.getByRole("button", { name: /3 个文件已更改/ }));
    expect(document.querySelector(".task-dock")?.classList.contains("single")).toBe(true);
    expect(screen.getByLabelText("文件修改")).toBeTruthy();
    expect(screen.queryByLabelText("任务列表")).toBeNull();
    expect(screen.queryByText("本轮还没有待办")).toBeNull();
  });

  it("keeps a single unnamed or default Tasks list flat", () => {
    render(
      <TaskProgressDock
        todos={[{ id: "1", content: "写文档", status: "in_progress", phase: "Tasks" }]}
        files={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /第 1 \/ 1 步/ }));
    expect(document.querySelector(".task-dock-phase")).toBeNull();
    expect(screen.queryByRole("group", { name: "Tasks" })).toBeNull();
    expect(screen.getByLabelText("任务列表").textContent).toContain("写文档");
  });

  it("collapses completed phases until the whole list is done, and lets each phase toggle", () => {
    render(<TaskProgressDock todos={PREVIEW_TODOS} files={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /第 5 \/ 7 步/ }));
    const p1 = screen.getByRole("button", { name: /P1 文档/ });
    expect(p1.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(p1);
    expect(p1.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "P1 文档" }).textContent).toContain("阅读 docs/ 现有文档与 package.json");
  });

  it("expands every phase when all tasks are complete", () => {
    render(
      <TaskProgressDock
        todos={[
          { id: "a", phase: "文档", content: "读文档", status: "completed" },
          { id: "b", phase: "验证", content: "lint", status: "completed" },
        ]}
        files={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /第 2 \/ 2 步/ }));
    expect(screen.getByRole("button", { name: /P1 文档/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /P2 验证/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("centers the in-progress row inside the task list", () => {
    const scrollTo = vi.fn();
    const list = {
      getBoundingClientRect: () => ({ top: 0, height: 140 }),
      clientHeight: 140,
      scrollTop: 0,
      scrollTo,
    };
    const row = {
      getBoundingClientRect: () => ({ top: 200, height: 28 }),
      offsetHeight: 28,
    };
    scrollCurrentTodoIntoList(list as unknown as HTMLElement, row as unknown as HTMLElement);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 144 }));
  });

  it("scrolls to the current task when the dock opens and when todos update", () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const list = this.classList.contains("task-dock-todos");
      return {
        top: list ? 0 : 80,
        height: list ? 140 : 28,
        bottom: list ? 140 : 108,
        left: 0,
        right: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 140; } });
    const first = [
      { id: "1", phase: "文档", content: "读文档", status: "completed" as const },
      { id: "2", phase: "验证", content: "lint", status: "in_progress" as const },
      { id: "3", phase: "验证", content: "提交", status: "pending" as const },
    ];
    const { rerender } = render(<TaskProgressDock todos={first} files={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /第 2 \/ 3 步/ }));
    expect(document.querySelector("[data-current=true]")?.textContent).toContain("lint");
    expect(scrollTo).toHaveBeenCalled();
    scrollTo.mockClear();
    rerender(
      <TaskProgressDock
        todos={[
          { id: "1", phase: "文档", content: "读文档", status: "completed" },
          { id: "2", phase: "验证", content: "lint", status: "completed" },
          { id: "3", phase: "验证", content: "提交", status: "in_progress" },
        ]}
        files={[]}
      />,
    );
    expect(document.querySelector("[data-current=true]")?.textContent).toContain("提交");
    expect(scrollTo).toHaveBeenCalled();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });
});
