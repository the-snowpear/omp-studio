import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerModePicker } from "./ComposerModePicker";
import { I18nProvider } from "./i18n";

afterEach(cleanup);

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
    fireEvent.change(screen.getByRole("combobox", { name: "循环继续条件" }), { target: { value: "until" } });
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
