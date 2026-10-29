import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalRecordingControls } from "./TerminalRecordingControls";
vi.mock("./RecordingPlayer", () => ({ RecordingPlayer: () => null }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("joins an outstanding status read across hidden and visible changes", async () => {
 let finish!: (value: unknown) => void;
 const first = new Promise(resolve => { finish = resolve; });
 const recordingStatus = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ state: "recording", elapsedMs: 1, bytes: 0 });
 const recordingStop = vi.fn();
 const api = { recordingStatus, recordingStop } as unknown as NonNullable<typeof globalThis.ompStudioTerminal>;
 const view = render(<TerminalRecordingControls api={api} id="terminal" ended={false} visible />);
 await act(async () => {});
 view.rerender(<TerminalRecordingControls api={api} id="terminal" ended={false} visible={false} />);
 view.rerender(<TerminalRecordingControls api={api} id="terminal" ended={false} visible />);
 expect(recordingStatus).toHaveBeenCalledOnce();
 await act(async () => { finish({ state: "idle", elapsedMs: 0, bytes: 0 }); });
 expect(recordingStatus).toHaveBeenCalledTimes(2);
 expect(recordingStop).not.toHaveBeenCalled();
});

it("stops hidden panel polling without stopping the recording and refreshes on return", async () => {
  vi.useFakeTimers();
  const recordingStatus = vi.fn(async () => ({ state: "recording", elapsedMs: 0, bytes: 0 }));
  const recordingStop = vi.fn();
  const api = { recordingStatus, recordingStop } as unknown as NonNullable<typeof globalThis.ompStudioTerminal>;
  const view = render(<TerminalRecordingControls api={api} id="terminal" ended={false} visible />);
  await act(async () => {});
  expect(recordingStatus).toHaveBeenCalledOnce();
  view.rerender(<TerminalRecordingControls api={api} id="terminal" ended={false} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(recordingStatus).toHaveBeenCalledOnce();
  expect(recordingStop).not.toHaveBeenCalled();
  view.rerender(<TerminalRecordingControls api={api} id="terminal" ended={false} visible />);
  await act(async () => {});
  expect(recordingStatus).toHaveBeenCalledTimes(2);
});
