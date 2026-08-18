import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { ApprovalMode } from "@omp-studio/studio-protocol";

import { approvalPickerDisabled, ComposerApprovalPicker } from "./ComposerApprovalPicker";

afterEach(cleanup);

describe("approvalPickerDisabled", () => {
  const live = {
    preview: false,
    executionMatches: true,
    runtimeConnected: true,
    snapshotReady: true,
    canSet: true,
    resyncRequired: false,
    selectedSessionId: "sess-live",
    selectedThreadId: "thread-live",
  };

  it("历史会话尚未切到 Runtime 时不禁用：胶囊可点，由父级先 resume", () => {
    expect(
      approvalPickerDisabled({
        ...live,
        executionMatches: false,
        runtimeConnected: false,
        snapshotReady: false,
        canSet: false,
        selectedSessionId: "sess-hist",
        selectedThreadId: "thread-hist",
      }),
    ).toBe(false);
  });

  it("当前 Runtime 会话缺少 permissions.mode.set 时禁用", () => {
    expect(approvalPickerDisabled({ ...live, canSet: false })).toBe(true);
  });

  it("预览开时不禁用，即使缺少 Host 能力", () => {
    expect(approvalPickerDisabled({ ...live, preview: true, canSet: false })).toBe(false);
  });

  it("历史会话缺少 threadId 时禁用：无法 resume", () => {
    const { selectedThreadId: _omit, ...withoutThread } = live;
    expect(
      approvalPickerDisabled({
        ...withoutThread,
        executionMatches: false,
        selectedSessionId: "sess-hist",
      }),
    ).toBe(true);
  });

  it("需要 resync 时禁用，历史会话也不例外", () => {
    expect(
      approvalPickerDisabled({
        ...live,
        executionMatches: false,
        resyncRequired: true,
        selectedSessionId: "sess-hist",
        selectedThreadId: "thread-hist",
      }),
    ).toBe(true);
  });
});

describe("ComposerApprovalPicker", () => {
  function Harness({
    preview = true,
    mode: initial = "write",
    disabled = false,
    onChange = vi.fn(),
  }: {
    preview?: boolean;
    mode?: ApprovalMode;
    disabled?: boolean;
    onChange?: (mode: ApprovalMode) => void;
  }) {
    const [mode, setMode] = useState<ApprovalMode>(initial);
    return (
      <ComposerApprovalPicker
        preview={preview}
        mode={mode}
        disabled={disabled}
        onChange={(next) => {
          onChange(next);
          setMode(next);
        }}
      />
    );
  }

  it("预览：Full Access 可点，只改本地档位", () => {
    const onChange = vi.fn();
    render(<Harness preview mode="write" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "权限模式：Workspace" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Full Access/ }));
    expect(onChange).toHaveBeenCalledWith("yolo");
    expect(screen.getByRole("button", { name: "权限模式：Full Access" })).toBeTruthy();
  });

  it("预览：当前已是 Full Access 时仍可打开菜单切走", () => {
    const onChange = vi.fn();
    render(<Harness preview mode="yolo" onChange={onChange} />);

    const pill = screen.getByRole("button", { name: "权限模式：Full Access" }) as HTMLButtonElement;
    expect(pill.disabled).toBe(false);
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Review/ }));
    expect(onChange).toHaveBeenCalledWith("always-ask");
  });

  it("真实模式且父级锁定时，胶囊禁用", () => {
    render(<Harness preview={false} mode="yolo" disabled />);
    expect((screen.getByRole("button", { name: "权限模式：Full Access" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("本轮进行中打开菜单时提示下一轮才生效，胶囊仍可点", () => {
    render(
      <ComposerApprovalPicker
        preview={false}
        mode="yolo"
        disabled={false}
        nextTurnOnly
        onChange={vi.fn()}
      />,
    );
    const pill = screen.getByRole("button", { name: "权限模式：Full Access" }) as HTMLButtonElement;
    expect(pill.disabled).toBe(false);
    fireEvent.click(pill);
    expect(screen.getByText("当前轮次仍用原权限，下一轮对话才生效")).toBeTruthy();
  });

  it("点 Full Access 时 mousedown 阻止默认聚焦，避免 composer 失焦", () => {
    render(<Harness preview mode="write" />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式：Workspace" }));
    const item = screen.getByRole("menuitemradio", { name: /^Full Access/ });
    expect(fireEvent.mouseDown(item)).toBe(false);
  });

  it("历史会话不确定当前档时，点已显示的 Full Access 仍会提交 yolo", () => {
    const onChange = vi.fn();
    render(
      <ComposerApprovalPicker
        preview={false}
        mode="yolo"
        indeterminate
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "权限模式：Full Access" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Full Access/ }));
    expect(onChange).toHaveBeenCalledWith("yolo");
  });
});
