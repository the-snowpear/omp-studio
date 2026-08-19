import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));

import { AppMenu } from "./App.js";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

import { I18nProvider } from "./i18n";

type AppMenuChrome = Parameters<typeof AppMenu>[0]["chrome"];

function fakeChrome(overrides: Partial<AppMenuChrome> = {}): AppMenuChrome {
  return {
    onStartNewChat: vi.fn(),
    onPickProject: vi.fn(),
    onCreateProject: vi.fn(),
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
  it("opens from the hamburger button and lists all 15 items in 4 groups", () => {
    renderMenu({ chrome: fakeChrome() });
    const button = screen.getByRole("button", { name: "应用菜单" });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    const menu = screen.getByRole("menu", { name: "应用菜单" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu.querySelectorAll("[role=menuitem]")).toHaveLength(15);
    expect(screen.getByText("全局操作")).toBeTruthy();
    expect(screen.getByText("全局搜索")).toBeTruthy();
    expect(screen.getByText("新建项目")).toBeTruthy();
    expect(screen.getByText("首页")).toBeTruthy();
    expect(screen.queryByText("Command Palette")).toBeNull();
    expect(screen.queryByText("切换项目")).toBeNull();
    expect(screen.queryByText("最近项目")).toBeNull();
    expect(screen.queryByText("打开 OMP 配置目录")).toBeNull();
    // 4 组之间应有 3 条分隔线。
    expect(menu.querySelectorAll(".menu-sep")).toHaveLength(3);
    // 快捷键徽标只标注真实存在的快捷键。
    expect(screen.getByText("新建对话").closest(".menu-item")!.querySelector(".kbd")!.textContent).toBe("Ctrl ⇧ O");
  });

  it("renders English items when in English locale", () => {
    render(
      <I18nProvider forcedLanguage="en">
        <AppMenu chrome={fakeChrome()} onRoute={vi.fn()} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "App Menu" });
    fireEvent.click(button);
    expect(screen.getByText("Global Actions")).toBeTruthy();
    expect(screen.getByText("New Chat")).toBeTruthy();
    expect(screen.getByText("Open Local Project…")).toBeTruthy();
    expect(screen.getByText("Home")).toBeTruthy();
  });

  it("navigates to history and closes the menu", () => {
    const onRoute = vi.fn();
    renderMenu({ chrome: fakeChrome(), onRoute });

    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));
    fireEvent.click(screen.getByText("会话历史"));

    expect(onRoute).toHaveBeenCalledWith("history");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the create-project flow and goes home from the project group", () => {
    const chrome = fakeChrome();
    const onRoute = vi.fn();
    renderMenu({ chrome, onRoute });

    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));
    fireEvent.click(screen.getByText("新建项目"));
    expect(chrome.onCreateProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));
    fireEvent.click(screen.getByText("首页"));
    expect(onRoute).toHaveBeenCalledWith("home");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps items without a backend disabled with a reason", () => {
    renderMenu({ chrome: fakeChrome() });
    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));

    for (const [label, reason] of [
      ["克隆 Git 仓库…", "暂未实现"],
      ["创建临时工作区", "暂未实现"],
    ] as const) {
      const item = screen.getByText(label).closest<HTMLButtonElement>(".menu-item")!;
      expect(item.disabled).toBe(true);
      expect(item.getAttribute("data-tip")).toBe(reason);
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
      expect(item.getAttribute("data-tip")).toBe("请先打开本地项目");
    }
  });

  it("preview mode: disables 打开本地项目 and keeps 新建项目 on the create-project path", () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
    const chrome = fakeChrome();
    const onRoute = vi.fn();
    render(
      <PreviewModeProvider switchEnabled>
        <I18nProvider forcedLanguage="zh">
          <AppMenu chrome={chrome} onRoute={onRoute} />
        </I18nProvider>
      </PreviewModeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "应用菜单" }));

    const pick = screen.getByText("打开本地项目…").closest<HTMLButtonElement>(".menu-item")!;
    expect(pick.disabled).toBe(true);
    expect(pick.getAttribute("data-tip")).toBe("预览模式下不可用");
    fireEvent.click(pick);
    expect(chrome.onPickProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("新建项目"));
    expect(chrome.onCreateProject).toHaveBeenCalledTimes(1);
    expect(onRoute).not.toHaveBeenCalled();
  });
});

function renderMenu({ chrome, onRoute = vi.fn() }: {
  chrome: AppMenuChrome;
  onRoute?: ReturnType<typeof vi.fn>;
}) {
  return render(
    <I18nProvider forcedLanguage="zh">
      <AppMenu chrome={chrome} onRoute={onRoute as unknown as Parameters<typeof AppMenu>[0]["onRoute"]} />
    </I18nProvider>,
  );
}
