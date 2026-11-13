import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAssignmentEditor, type TaskAssignmentMode, type TaskStepDraft } from "./TaskAssignmentEditor";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Draft({ initialMode = "steps", disabled = false, supported = true }: { initialMode?: TaskAssignmentMode; disabled?: boolean; supported?: boolean }) {
  const [mode, setMode] = useState<TaskAssignmentMode>(initialMode);
  const [assignment, setAssignment] = useState("single draft");
  const [steps, setSteps] = useState<TaskStepDraft[]>([{ id: "a", text: "Inspect native contracts" }, { id: "b", text: "Implement the seam" }, { id: "c", text: "Verify the result" }]);
  return <><TaskAssignmentEditor mode={mode} onModeChange={setMode} assignment={assignment} onAssignmentChange={setAssignment} steps={steps} onStepsChange={setSteps} disabled={disabled} stepsSupported={supported} stepsAdvertised={false} zh />
    <output aria-label="step draft">{JSON.stringify(steps.map(step => step.text))}</output></>;
}
const draft = () => JSON.parse(screen.getByLabelText("step draft").textContent!) as string[];

describe("task assignment editing", () => {
  it("edits only one selected step and navigates the ordered outline with the keyboard", () => {
    render(<Draft />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox", { name: "第 1 步" }), { target: { value: "Inspect the task contract" } });
    const outline = screen.getByRole("list", { name: "任务步骤顺序" });
    const first = screen.getByRole("button", { name: "第 1 步: Inspect the task contract" });
    first.focus(); fireEvent.keyDown(first, { key: "ArrowDown" });
    expect((screen.getByRole("textbox", { name: "第 2 步" }) as HTMLTextAreaElement).value).toBe("Implement the seam");
    expect(outline.contains(document.activeElement)).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Implement native forwarding" } });
    expect(draft()).toEqual(["Inspect the task contract", "Implement native forwarding", "Verify the result"]);
  });

  it("adds, reorders and removes steps without replacing the focused editor or losing text", () => {
    render(<Draft />);
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    editor.focus();
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(draft()).toEqual(["Inspect native contracts", "", "Implement the seam", "Verify the result"]);
    expect(document.activeElement).toBe(editor);
    fireEvent.change(editor, { target: { value: "Keep the original agent identity" } });
    fireEvent.keyDown(editor, { key: "ArrowUp", altKey: true });
    expect(screen.getByRole("textbox", { name: "第 1 步" })).toBe(editor);
    expect(editor.value).toBe("Keep the original agent identity");
    expect(draft()).toEqual(["Keep the original agent identity", "Inspect native contracts", "Implement the seam", "Verify the result"]);
    fireEvent.keyDown(editor, { key: "Backspace", ctrlKey: true, shiftKey: true });
    expect(draft()).toEqual(["Inspect native contracts", "Implement the seam", "Verify the result"]);
    expect(screen.getByRole("textbox")).toBe(editor);
    expect(editor.value).toBe("Inspect native contracts");
  });

  it("preserves the two drafts across Single/Steps without treating the advertising flag as permission", () => {
    render(<Draft initialMode="single" />);
    fireEvent.click(screen.getByRole("button", { name: "分步任务" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Inspect native contracts");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated step" } });
    fireEvent.click(screen.getByRole("button", { name: "单一任务" }));
    expect((screen.getByRole("textbox", { name: "任务描述" }) as HTMLTextAreaElement).value).toBe("single draft");
    fireEvent.click(screen.getByRole("button", { name: "分步任务" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Updated step");
  });

  it("keeps unavailable native steps honest and locks changes while submitting", () => {
    const view = render(<Draft initialMode="single" supported={false} />);
    expect((screen.getByRole("button", { name: "分步任务" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/当前 Runtime 未提供原生步骤选项/)).toBeTruthy();
    view.unmount();
    render(<Draft disabled />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(draft()).toEqual(["Inspect native contracts", "Implement the seam", "Verify the result"]);
    expect((screen.getByRole("button", { name: "新增步骤" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
