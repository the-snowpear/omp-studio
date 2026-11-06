import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseSessionCompactionInput, type SessionCompactionState } from "@omp-studio/studio-protocol";
import { SessionCompactionInput } from "./SessionCompactionInput";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Control({ save }: { save: (input: string) => Promise<boolean> }) {
  const [state, setState] = useState<SessionCompactionState>({ sessionId: "one", threshold: null, contextWindow: 1000000, triggerTokens: 850000, automatic: true });
  return <SessionCompactionInput state={state} enabled loading={false} saving={false} error="" onSave={async input => {
    if (!await save(input)) return false;
    setState({ ...state, threshold: parseSessionCompactionInput(input) }); return true;
  }} />;
}

it("explains automatic detection, applies on Enter, and restores inheritance on reset", async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<Control save={save} />);
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "80" } });
  expect(screen.getByRole("status").textContent).toContain("80%");
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("80%"));
  fireEvent.click(screen.getByRole("button", { name: /恢复默认|Reset/ }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(""));
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
});

it("keeps example selection editable and Escape discards drafts without saving", () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<Control save={save} />);
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.click(screen.getByRole("button", { name: "150k" }));
  expect((input as HTMLInputElement).value).toBe("150k");
  expect(screen.getByRole("status").textContent).toContain("150,000");
  fireEvent.keyDown(input, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("button", { name: "150k" })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("a failed save retains the draft for retry instead of showing a saved value", async () => {
  const save = vi.fn().mockResolvedValue(false);
  render(<Control save={save} />);
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "0.5m" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(save).toHaveBeenCalledWith("0.5m"));
  expect((input as HTMLInputElement).value).toBe("0.5m");
  expect(screen.queryByText(/已保存到本对话|Saved to this conversation/)).toBeNull();
});

it("closes after saving while preserving a new edit until the user leaves", async () => {
  vi.useFakeTimers();
  const save = vi.fn().mockResolvedValue(true);
  render(<Control save={save} />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "80" } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  expect(screen.getByRole("status").textContent).toMatch(/已保存到本对话|Saved to this conversation/);
  act(() => vi.advanceTimersByTime(1200));
  expect(screen.queryByRole("button", { name: /恢复默认|Reset/ })).toBeNull();
  expect(document.activeElement).not.toBe(input);

  act(() => input.focus());
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.queryByRole("button", { name: /恢复默认|Reset/ })).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);

  act(() => input.focus());
  fireEvent.change(input, { target: { value: "90" } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  fireEvent.change(input, { target: { value: "95" } });
  act(() => vi.advanceTimersByTime(1200));
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("95");
  expect(screen.getByRole("status").textContent).toContain("95%");
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("button", { name: /恢复默认|Reset/ })).toBeNull();
  expect(document.activeElement).not.toBe(input);
  expect(input.value).toBe("90%");
  expect(save).toHaveBeenCalledTimes(2);
});
