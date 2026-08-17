import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { CommandInput, CommandName } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import { ComposerModePicker } from "./ComposerModePicker";
import { containsStandaloneKeyword, injectMagicKeyword, type MagicKeyword } from "./composerMode";

afterEach(cleanup);

describe("injectMagicKeyword", () => {
  it("prepends a standalone keyword when the draft does not already trigger it", () => {
    expect(injectMagicKeyword("fix the tests", "orchestrate")).toBe("orchestrate\nfix the tests");
    expect(containsStandaloneKeyword("orchestrate the migration", "orchestrate")).toBe(true);
  });

  it("does not inject when the standalone word is already present", () => {
    expect(injectMagicKeyword("orchestrate the migration", "orchestrate")).toBe("orchestrate the migration");
  });

  it("ignores the word inside code and identifiers", () => {
    expect(containsStandaloneKeyword("see `orchestrate` and orchestrate.ts", "orchestrate")).toBe(false);
    expect(injectMagicKeyword("see orchestrate.ts", "orchestrate")).toBe("orchestrate\nsee orchestrate.ts");
  });

  it("injects ultrathink the same way", () => {
    expect(injectMagicKeyword("fix the tests", "ultrathink")).toBe("ultrathink\nfix the tests");
    expect(injectMagicKeyword("ultrathink through the refactor", "ultrathink")).toBe("ultrathink through the refactor");
  });
});

describe("ComposerModePicker", () => {
  const run = vi.fn(async (_name: CommandName, _input: CommandInput<CommandName>) => true);
  afterEach(() => run.mockClear());

  function Harness({
    preview = true,
    can = () => false,
    keyword: initialKeyword = null,
    onRun = run,
    disabled = false,
  }: {
    preview?: boolean;
    can?: (id: string) => boolean;
    keyword?: MagicKeyword | null;
    onRun?: typeof run;
    disabled?: boolean;
  }) {
    const [keyword, setKeyword] = useState<MagicKeyword | null>(initialKeyword);
    return (
      <ComposerModePicker
        preview={preview}
        can={can}
        busy={false}
        disabled={disabled}
        keyword={keyword}
        onKeywordChange={setKeyword}
        onRun={onRun}
      />
    );
  }

  function openToggles() {
    fireEvent.click(screen.getByRole("button", { name: "更多模式" }));
  }

  it("预览：同层互斥、层 3 可多选，不发 Host command", () => {
    render(<Harness disabled />);

    fireEvent.click(screen.getByRole("button", { name: "会话模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Plan/ }));
    expect(document.querySelector(".mode-chip-label-full")?.textContent).toBe("Plan");
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Vibe/ }));
    expect([...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining(["Vibe"]),
    );
    expect([...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent)).not.toContain("Plan");

    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Orchestrate/ }));
    expect([...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining(["Vibe", "Orchestrate"]),
    );

    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Ultrathink/ }));
    expect([...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining(["Vibe", "Ultrathink"]),
    );
    expect([...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent)).not.toContain("Orchestrate");
    expect([...document.querySelectorAll(".mode-chip-label-initial")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining(["V", "U"]),
    );

    openToggles();
    fireEvent.click(screen.getByRole("checkbox", { name: /Loop/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Fast/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Prewalk/ }));
    expect([...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent?.replace(/\s+/g, " ").trim())).toEqual(
      expect.arrayContaining(["Vibe", "Ultrathink", "Loop", "Fast", "Prewalk"]),
    );
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "更多模式（可多选）" })).toBeTruthy();
    expect(screen.getByRole("menu", { name: "会话模式" })).toBeTruthy();
  });

  it("勾选层 3 时 mousedown 阻止默认聚焦，避免 composer 失焦闪烁", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "会话模式" }));
    openToggles();
    const checkbox = screen.getByRole("checkbox", { name: /Loop/ });
    expect(fireEvent.mouseDown(checkbox)).toBe(false);
    expect(screen.getByRole("menu", { name: "更多模式（可多选）" })).toBeTruthy();
    expect(fireEvent.mouseDown(screen.getByLabelText("Loop 限制类型"))).toBe(true);
  });

  it("预览：胶囊叉号取消对应层", () => {
    render(<Harness keyword="orchestrate" />);

    fireEvent.click(screen.getByRole("button", { name: "取消 Orchestrate" }));
    expect(document.querySelector(".mode-chip")).toBeNull();
  });

  it("真实模式且父级锁定时，加号仍可打开菜单，Plan/Vibe 可点", () => {
    render(
      <ComposerModePicker
        preview={false}
        can={(id) => id === "mode.plan.enter" || id === "mode.vibe.enter"}
        busy={false}
        disabled={true}
        keyword={null}
        onKeywordChange={vi.fn()}
        onRun={run}
      />,
    );
    const plus = screen.getByRole("button", { name: "会话模式" }) as HTMLButtonElement;
    expect(plus.disabled).toBe(false);
    fireEvent.click(plus);
    expect((screen.getByRole("menuitemradio", { name: /^Plan/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("menuitemradio", { name: /^Vibe/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("真实模式：Plan 走 mode.plan.enter，capability 缺失时 Fast 禁用", () => {
    const onRun = vi.fn(async (_name: CommandName, _input: CommandInput<CommandName>) => true);
    render(
      <ComposerModePicker
        preview={false}
        can={(id) => id === "mode.plan.enter" || id === "mode.plan.exit" || id === "loop.enable"}
        busy={false}
        disabled={false}
        keyword={null}
        onKeywordChange={vi.fn()}
        onRun={onRun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "会话模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Plan/ }));
    expect(onRun).toHaveBeenCalledWith("mode.plan.enter", {});

    openToggles();
    expect((screen.getByRole("checkbox", { name: /Fast/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Prewalk/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("预览：选中 Loop / Prewalk 后仍可改参数", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "会话模式" }));
    openToggles();
    fireEvent.click(screen.getByRole("checkbox", { name: /Loop/ }));
    const kind = screen.getByLabelText("Loop 限制类型") as HTMLSelectElement;
    expect(kind.disabled).toBe(false);
    fireEvent.change(kind, { target: { value: "turns" } });
    expect(
      [...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(expect.arrayContaining(["Loop · 10t"]));

    fireEvent.click(screen.getByRole("checkbox", { name: /Prewalk/ }));
    const into = screen.getByLabelText("Prewalk into") as HTMLInputElement;
    expect(into.disabled).toBe(false);
    fireEvent.change(into, { target: { value: "@fast" } });
    expect(
      [...document.querySelectorAll(".mode-chip-label-full")].map((node) => node.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(expect.arrayContaining(["Prewalk · @fast"]));
    expect(run).not.toHaveBeenCalled();
  });

  it("真实模式：Loop 已开时改限制会再次 loop.enable", () => {
    const onRun = vi.fn(async (_name: CommandName, _input: CommandInput<CommandName>) => true);
    render(
      <ComposerModePicker
        preview={false}
        snapshot={{ loop: { status: "waiting" } } as OperatorStateSnapshot}
        can={(id) => id === "loop.enable"}
        busy={false}
        disabled={false}
        keyword={null}
        onKeywordChange={vi.fn()}
        onRun={onRun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "会话模式" }));
    openToggles();
    expect((screen.getByRole("checkbox", { name: /Loop/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Loop 限制类型") as HTMLSelectElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Loop 限制类型"), { target: { value: "minutes" } });
    expect(onRun).toHaveBeenCalledWith("loop.enable", { limit: { minutes: 10 } });
  });

  it("真实模式：Prewalk 已武装时仍可改 into 并重新 arm", () => {
    const onRun = vi.fn(async (_name: CommandName, _input: CommandInput<CommandName>) => true);
    render(
      <ComposerModePicker
        preview={false}
        snapshot={{ prewalk: { status: "armed", target: "@smol" } } as OperatorStateSnapshot}
        can={(id) => id === "session.prewalk.arm"}
        busy={false}
        disabled={false}
        keyword={null}
        onKeywordChange={vi.fn()}
        onRun={onRun}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "会话模式" }));
    openToggles();
    const into = screen.getByLabelText("Prewalk into") as HTMLInputElement;
    expect(into.disabled).toBe(false);
    fireEvent.change(into, { target: { value: "opus" } });
    fireEvent.blur(into);
    expect(onRun).toHaveBeenCalledWith("session.prewalk.arm", { target: "opus" });
  });
});
