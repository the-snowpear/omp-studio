import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import {
  UserMessageTreeConfirmDialog,
  useUserMessageTreeConfirm,
} from "./UserMessageTreeConfirm";
import {
  USER_MESSAGE_BRANCH_CONFIRM_COPY,
  USER_MESSAGE_RESTORE_CONFIRM_COPY,
} from "./userMessageRestore";

afterEach(cleanup);

function ConfirmHarness({ preview }: { readonly preview: boolean }) {
  const { ask, dialog } = useUserMessageTreeConfirm(preview);
  const [last, setLast] = useState<string>("idle");
  return (
    <>
      <button type="button" onClick={() => { void ask("restore").then((ok) => setLast(ok ? "ok" : "cancelled")); }}>
        open-restore
      </button>
      <span data-testid="confirm-result">{last}</span>
      {dialog}
    </>
  );
}

describe("UserMessageTreeConfirmDialog", () => {
  it("renders restore copy with in-app dialog controls", () => {
    const cancelled: string[] = [];
    render(
      <UserMessageTreeConfirmDialog
        kind="restore"
        preview={false}
        onCancel={() => cancelled.push("cancel")}
        onConfirm={() => cancelled.push("confirm")}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: USER_MESSAGE_RESTORE_CONFIRM_COPY.title });
    expect(dialog.closest(".modal-backdrop")?.parentElement).toBe(document.body);
    expect(screen.getByText(USER_MESSAGE_RESTORE_CONFIRM_COPY.body)).toBeTruthy();
    expect(screen.getByText(USER_MESSAGE_RESTORE_CONFIRM_COPY.hint)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancelled).toEqual(["cancel"]);
  });

  it("preview restore shows the demo hint instead of Host copy", () => {
    render(
      <UserMessageTreeConfirmDialog
        kind="restore"
        preview={true}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(screen.getByText(USER_MESSAGE_RESTORE_CONFIRM_COPY.hintPreview)).toBeTruthy();
    expect(screen.queryByText(USER_MESSAGE_RESTORE_CONFIRM_COPY.hint)).toBeNull();
  });

  it("renders branch copy on the same in-app dialog", () => {
    render(
      <UserMessageTreeConfirmDialog
        kind="branch"
        preview={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog", { name: USER_MESSAGE_BRANCH_CONFIRM_COPY.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: USER_MESSAGE_BRANCH_CONFIRM_COPY.action })).toBeTruthy();
  });
});

describe("useUserMessageTreeConfirm", () => {
  it("cancel leaves restore unconfirmed", async () => {
    render(<ConfirmHarness preview={false} />);
    fireEvent.click(screen.getByRole("button", { name: "open-restore" }));
    expect(screen.getByRole("dialog", { name: "确认恢复" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.getByTestId("confirm-result").textContent).toBe("cancelled");
    });
    expect(screen.queryByRole("dialog", { name: "确认恢复" })).toBeNull();
  });

  it("confirm resolves true after the primary action", async () => {
    render(<ConfirmHarness preview={false} />);
    fireEvent.click(screen.getByRole("button", { name: "open-restore" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => {
      expect(screen.getByTestId("confirm-result").textContent).toBe("ok");
    });
  });
});
