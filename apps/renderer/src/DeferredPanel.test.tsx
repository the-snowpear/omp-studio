import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeferredPanel, LoadWhenVisible, lazyPanel } from "./DeferredPanel";
afterEach(cleanup);
it("loads a panel on first use and keeps it mounted while hidden", async () => {
  const load = vi.fn(async () => ({ default: () => <span>Loaded panel</span> }));
  const Panel = lazyPanel(load);
  const view = render(<LoadWhenVisible visible={false}><Panel /></LoadWhenVisible>);
  expect(load).not.toHaveBeenCalled();
  view.rerender(<LoadWhenVisible visible><Panel /></LoadWhenVisible>);
  await screen.findByText("Loaded panel");
  view.rerender(<LoadWhenVisible visible={false}><Panel /></LoadWhenVisible>);
  expect(screen.getByText("Loaded panel")).toBeTruthy();
  expect(load).toHaveBeenCalledOnce();
});
it("allows a failed chunk load to retry without reloading the workbench", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const load = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ default: () => <span>Recovered panel</span> });
    const Panel = lazyPanel(load);
    render(<><input aria-label="Draft" defaultValue="kept" /><DeferredPanel><Panel /></DeferredPanel></>);
    const retry = await screen.findByRole("button", { name: /Retry|重试/ });
    await act(async () => { fireEvent.click(retry); });
    await screen.findByText("Recovered panel");
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("kept");
    expect(load).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
});
it("shares an in-flight module across instances and renders as soon as it resolves", async () => {
  let resolve!: (module: { default: () => React.ReactNode }) => void;
  const load = vi.fn(() => new Promise<{ default: () => React.ReactNode }>(done => { resolve = done; }));
  const Panel = lazyPanel(load);
  const first = render(<Panel />);
  render(<Panel />);
  expect(load).toHaveBeenCalledOnce();
  first.unmount();
  await act(async () => { resolve({ default: () => <span>Shared module</span> }); });
  expect(screen.getByText("Shared module")).toBeTruthy();
  render(<Panel />);
  expect(screen.getAllByText("Shared module")).toHaveLength(2);
  expect(load).toHaveBeenCalledOnce();
});
