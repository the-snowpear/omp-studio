import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { ChipComposer, type ChipComposerHandle } from "./ChipComposer";
import { snapshotFromText } from "./serialize";
import type { StudioSlashCommand } from "./commands";

afterEach(() => cleanup());

const DYNAMIC_COMMAND: StudioSlashCommand = {
  name: "dynamic",
  aliases: [],
  description: "Runtime dynamic command",
  group: "capability",
  allowArgs: false,
  availability: "available",
  risk: "normal",
  select: "run-now",
  invokeId: "skill.dynamic",
  source: "skill",
};

describe("ChipComposer explicit slash catalog", () => {
  it("discovers and dispatches a dynamic command from the supplied menu catalog", () => {
    const ref = createRef<ChipComposerHandle>();
    const onRunCommand = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" slashCatalog={[DYNAMIC_COMMAND]} onRunCommand={onRunCommand} />);

    act(() => {
      ref.current?.openCommandMenu();
    });
    const option = screen.getByRole("option", { name: /\/dynamic/ });
    fireEvent.mouseDown(option);
    expect(onRunCommand).toHaveBeenCalledWith(expect.objectContaining({ invokeId: "skill.dynamic" }), "");
  });

  it("uses the supplied catalog when deciding whether Enter is a slash execute", () => {
    const ref = createRef<ChipComposerHandle>();
    const onSubmit = vi.fn();
    render(<ChipComposer ref={ref} placeholder="msg" slashCatalog={[DYNAMIC_COMMAND]} onSubmit={onSubmit} />);

    act(() => {
      ref.current?.setSnapshot(snapshotFromText("/dynamic"));
    });
    const editor = document.querySelector<HTMLElement>(".chip-composer-editor");
    expect(editor).toBeTruthy();
    fireEvent.keyDown(editor as HTMLElement, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
