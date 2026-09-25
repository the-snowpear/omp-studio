import { expect, it } from "vitest";
import { applyRecordedFrame, parsePlaybackRecording, type RecordedScreen } from "./format";
const header = JSON.stringify({ ompcast: 1, cols: 80, rows: 2, title: "OMP", createdAt: "2026-09-25T00:00:00Z" });
it("reconstructs native viewport, patch, history and resize frames and recovers a truncated final line", () => {
  const recording = parsePlaybackRecording(header + '\n[0,{"t":"viewport","rows":["one","two"]}]\n[50,{"t":"patch","ops":[[1,"changed"]],"rows":2}]\n[60,{"t":"history","rows":["past"]}]\n[70,{"t":"resize","cols":100,"rows":3}]\n[80,{');
  expect(recording.truncated).toBe(true); expect(recording.durationMs).toBe(70);
  const screen: RecordedScreen = { cols: 80, rows: 2, history: [], viewport: [] };
  for (const event of recording.events) applyRecordedFrame(screen, event.frame);
  expect(screen).toEqual({ cols: 100, rows: 3, history: ["past"], viewport: ["one", "changed", ""] });
});
it("rejects out-of-range patches, backward timestamps, malformed complete lines and unknown frames", () => {
  for (const events of ['[0,{"t":"patch","ops":[[999,"x"]],"rows":2}]\n', '[20,{"t":"reset"}]\n[10,{"t":"reset"}]\n', '[0,{\n', '[0,{"t":"shell","command":"execute"}]\n']) {
    expect(() => parsePlaybackRecording(header + "\n" + events)).toThrow();
  }
});
