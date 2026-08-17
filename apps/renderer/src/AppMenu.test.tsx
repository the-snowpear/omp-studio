import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));

import { AppMenu } from "./App.js";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { PREVIEW_PROJECTS } from "./preview/fixtures";

type AppMenuChrome = Parameters<typeof AppMenu>[0]["chrome"];

function fakeChrome(overrides: Partial<AppMenuChrome> = {}): AppMenuChrome {
  return {
    onStartNewChat: vi.fn(),
    onPickProject: vi.fn(),
    onOpenPalette: vi.fn(),
    onOpenTerminalPanel: vi.fn(),
    onOpenDialog: vi.fn(),
    onOpenProjectInEditor: vi.fn(),
    onOpenProjectDirectory: vi.fn(),
    projectShellUnavailable: undefined,
    projectShellAction: null,
    ...overrides,
  } as unknown as AppMenuChrome;
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

describe("AppMenu", () => {
  it("opens from the hamburger button and lists all 17 items in 4 groups", () => {
    renderMenu({ chrome: fakeChrome() });
    const button = screen.getByRole("button", { name: "应用菜单" });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    const menu = screen.getByRole("menu", { name: "应用菜单" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu.querySelectorAll("[role=menuitem]")).toHaveLength(17);
    expect(screen.getByText("全局操作")).toBeTruthy();
    // 4 组之间应有 3 条分隔线。
    expect(menu.querySelectorAll(".menu-sep")).toHaveLength(3);
    // 快捷键徽标只标注真实存在的快捷键。
    expect(screen.getByText("新建对话").closest(".menu-item")!.querySelector(".kbd")!.textContent).toBe("Ctrl ⇧ O");
  });

  it("navigates to history and closes the menu", () => {
    const onRoute = vi.fn();
    renderMenu({ chrome: fakeChrome(), onRoute });

    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));
    fireEvent.click(screen.getByText("打开会话历史"));

    expect(onRoute).toHaveBeenCalledWith("history");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps items without a backend disabled with a reason", () => {
    renderMenu({ chrome: fakeChrome() });
    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));

    for (const label of ["克隆 Git 仓库…", "创建临时工作区", "最近项目", "打开 OMP 配置目录"]) {
      const item = screen.getByText(label).closest<HTMLButtonElement>(".menu-item")!;
      expect(item.disabled).toBe(true);
      expect(item.title).toBe("不在公共 contract 中");
    }
  });

  it("closes on Escape and on outside mousedown", () => {
    renderMenu({ chrome: fakeChrome() });
    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs project shell actions through chrome when available", () => {
    const chrome = fakeChrome();
    renderMenu({ chrome });
    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));

    const editor = screen.getByText("在外部编辑器中打开项目").closest<HTMLButtonElement>(".menu-item")!;
    expect(editor.disabled).toBe(false);
    fireEvent.click(editor);
    expect(chrome.onOpenProjectInEditor).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables project shell actions with the reason from chrome", () => {
    renderMenu({ chrome: fakeChrome({ projectShellUnavailable: "请先打开本地项目" }) });
    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));

    for (const label of ["在外部编辑器中打开项目", "打开系统文件管理器"]) {
      const item = screen.getByText(label).closest<HTMLButtonElement>(".menu-item")!;
      expect(item.disabled).toBe(true);
      expect(item.title).toBe("请先打开本地项目");
    }
  });

  it("preview mode: disables 打开本地项目 and derives the project count from fixtures", () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
    const chrome = fakeChrome();
    const onRoute = vi.fn();
    render(
      <PreviewModeProvider>
        <AppMenu chrome={chrome} onRoute={onRoute} projectCount={PREVIEW_PROJECTS.length} />
      </PreviewModeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));

    const pick = screen.getByText("打开本地项目…").closest<HTMLButtonElement>(".menu-item")!;
    expect(pick.disabled).toBe(true);
    expect(pick.title).toBe("预览模式下不可用");
    fireEvent.click(pick);
    expect(chrome.onPickProject).not.toHaveBeenCalled();

    const switchProject = screen.getByText("切换项目").closest(".menu-item")!;
    expect(switchProject.querySelector(".hint")!.textContent).toBe(`${PREVIEW_PROJECTS.length} 个项目`);
    fireEvent.click(screen.getByText("切换项目"));
    expect(onRoute).toHaveBeenCalledWith("home");
  });
});

function renderMenu({ chrome, onRoute = vi.fn(), projectCount = 2 }: {
  chrome: AppMenuChrome;
  onRoute?: ReturnType<typeof vi.fn>;
  projectCount?: number;
}) {
  // 无 PreviewModeProvider 时 usePreviewMode() 默认真实模式（preview=false）。
  return render(<AppMenu chrome={chrome} onRoute={onRoute as unknown as Parameters<typeof AppMenu>[0]["onRoute"]} projectCount={projectCount} />);
}
