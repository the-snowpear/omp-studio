import { selectOption } from "./test/selectOption";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerModePicker } from "./ComposerModePicker";
import { I18nProvider } from "./i18n";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(preview = false) {
  const onRun = vi.fn(async () => true);
  render(
    <I18nProvider forcedLanguage="zh">
      <ComposerModePicker preview={preview} can={() => true} busy={false} disabled={false} keyword={null} onKeywordChange={() => {}} onRun={onRun} openNonce={1} />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "更多模式" }));
  return onRun;
}

describe("Composer migration controls", () => {
  it("submits a structured until condition and requires non-empty command text", () => {
    const onRun = mount();
    selectOption(screen.getByRole("combobox", { name: "循环继续条件" }), "until");
    const loop = screen.getByRole("checkbox", { name: /Loop/ });
    expect((loop as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "循环条件命令" }), { target: { value: "test -f done" } });
    fireEvent.click(loop);
    expect(onRun).toHaveBeenCalledWith("loop.enable", { condition: { command: "test -f done", until: true } });
  });

  it("invokes the typed Prewalk restart rather than passing slash text", () => {
    const onRun = mount();
    fireEvent.click(screen.getByRole("button", { name: "重启 Prewalk" }));
    expect(onRun).toHaveBeenCalledWith("session.prewalk.restart", {});
  });

  it("keeps preview restart and loop configuration local", () => {
    const onRun = mount(true);
    fireEvent.click(screen.getByRole("button", { name: "重启 Prewalk" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Loop/ }));
    expect(onRun).not.toHaveBeenCalled();
  });
});

function mountTools(preview = false, collapse: "full" | "tools" = "tools", openNonce = 0, openToggles = false) {
  const composerActions = {
    onAttachFiles: vi.fn(),
    onMention: vi.fn(),
    onCommands: vi.fn(),
  };
  const onRun = vi.fn(async () => true);
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <div className="composer-bar" data-collapse={collapse}>
        <ComposerModePicker preview={preview} composerActions={composerActions} can={() => true} busy={false} disabled={false} keyword={null} onKeywordChange={() => {}} onRun={onRun} openNonce={openNonce} openToggles={openToggles} />
      </div>
    </I18nProvider>,
  );
  if (openNonce === 0) fireEvent.click(screen.getByRole("button", { name: collapse === "full" ? "会话模式" : "更多功能" }));
  return { composerActions, onRun, bar: container.querySelector(".composer-bar") as HTMLElement };
}

describe("Composer grouped tools", () => {
  it("keeps the original mode menu while the toolbar is expanded", () => {
    mountTools(true, "full");
    expect(screen.getByRole("menuitemradio", { name: /^Plan\b/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /^Ultrathink\b/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "添加内容" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多模式" }));
    expect(screen.getByRole("checkbox", { name: /Loop/ })).toBeTruthy();
  });

  it("switches the open menu with the toolbar layout and preserves selected modes", async () => {
    const { bar, onRun } = mountTools(true, "full");
    bar.dataset.collapse = "tools";
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "添加内容" })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitem", { name: "会话模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Plan\b/ }));

    bar.dataset.collapse = "full";
    await waitFor(() => expect(screen.getByRole("menu", { name: "会话模式" })).toBeTruthy());
    expect(screen.getByRole("menuitemradio", { name: /^Plan\b/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("menuitem", { name: "添加内容" })).toBeNull();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("does not reopen a dismissed mode menu when the toolbar changes width", async () => {
    const { bar } = mountTools(true, "full", 1);
    fireEvent.keyDown(window, { key: "Escape" });
    bar.dataset.collapse = "tools";
    await waitFor(() => expect(screen.getByRole("button", { name: "更多功能" })).toBeTruthy());
    expect(screen.queryByRole("menu")).toBeNull();
    bar.dataset.collapse = "full";
    await waitFor(() => expect(screen.getByRole("button", { name: "会话模式" })).toBeTruthy());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens requested automation controls directly in the narrow menu", () => {
    mountTools(true, "tools", 1, true);
    expect(screen.getByRole("checkbox", { name: /Loop/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "全部功能" }));
    expect(screen.getByRole("menuitem", { name: "添加内容" })).toBeTruthy();
  });

  it("keeps attachments, mentions, and slash commands reachable through the plus menu", () => {
    const { composerActions, onRun } = mountTools();
    fireEvent.click(screen.getByRole("menuitem", { name: "添加内容" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附件 / 图片" }));
    expect(composerActions.onAttachFiles).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "更多功能" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "添加内容" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "@ 引用文件、文件夹、Agent 或 Skill" }));
    expect(composerActions.onMention).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "更多功能" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "指令" }));
    expect(composerActions.onCommands).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("preserves selected preview modes across categories and supports returning and closing", () => {
    const { onRun } = mountTools(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "会话模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Plan\b/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "更多功能" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "会话模式" }));
    expect(screen.getByRole("menuitemradio", { name: /^Plan\b/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("menuitem", { name: "全部功能" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "更多模式" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Loop/ }));
    expect((screen.getByRole("checkbox", { name: /Loop/ }) as HTMLInputElement).checked).toBe(true);
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: "全部功能" }));
    expect(screen.getByRole("menuitem", { name: "添加内容" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多功能" }));
  });
});
