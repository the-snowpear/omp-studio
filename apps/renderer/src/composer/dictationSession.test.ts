import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { DictationCaptureState, DictationConfiguration, DictationInput } from "@omp-studio/studio-protocol";
import type { DictationAudioApi, DictationDesktopEvent, DictationOwner, DictationRecovery } from "../../../desktop/src/dictation-audio-shared";
import type { ComposerDictationHandle } from "./dictationTypes";
import { DictationSession } from "./dictationSession";
import type { PcmCaptureOptions } from "../media/liveCapture";

const configuration: DictationConfiguration = {
  protocolVersion: 2, configurationId: "local-test", available: true, enabled: true, model: "local/whisper-base", language: "zh", submitTrigger: "never", mode: "segmented", languageSupport: "supported", cloud: false, credentials: "local", downloadRequired: false,
  sources: { enabled: "global", language: "global", submitTrigger: "default" },
};
const state = (phase: DictationCaptureState["phase"], text = ""): DictationCaptureState => ({ phase, committedText: text, partialText: "", submit: false });
const sessions: DictationSession[] = [];
afterEach(() => { sessions.splice(0).forEach(session => session.disconnect()); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 50; i++) { if (check()) return; await Promise.resolve(); } throw new Error("State did not settle"); }
function setup(options: { ready?: boolean; blocked?: boolean; permission?: Promise<void>; final?: DictationCaptureState } = {}) {
  const events = new Set<(event: DictationDesktopEvent) => void>();
  const order: string[] = [];
  const owner: DictationOwner = { sessionId: "one", draftId: "composer", label: "Composer" };
  let recovery: DictationRecovery | null = null;
  let audioId = "audio-1", captures = 0;
  let currentState = state("prepared");
  const emit = (next: DictationCaptureState) => { currentState = next; for (const listener of events) listener({ kind: "state", audioId, owner, state: next }); };
  const editor: ComposerDictationHandle = { beginDictation: vi.fn(() => true), updateDictation: vi.fn(), commitDictation: vi.fn(() => ({ applied: true, unchanged: true })), cancelDictation: vi.fn() };
  const submitted = vi.fn();
  const commands: string[] = [];
  const receipts: Record<string, unknown> = {};
  const client = {
    command: vi.fn(async (kind: string) => {
      commands.push(kind); const requestId = `r${commands.length}`;
      const config = { ...configuration, ...(options.blocked ? { enabled: false, blockedReason: "disabled" } : {}) };
      const result = kind === "dictation.inspect" ? config : kind === "dictation.open" ? { protocolVersion: 2, audioId: `audio-${++captures}`, sessionId: "one", expiresAt: Date.now() + 30000, configuration: config } : { text: "", phase: "off" };
      receipts[requestId] = { requestId, status: "completed", result: { result } };
      return { requestId };
    }),
    getState: () => ({ commands: receipts }),
    subscribe: () => () => {},
  } as unknown as StudioClient;
  const api: DictationAudioApi = {
    attachDictationAudio: vi.fn(async input => { audioId = input.channel.audioId; currentState = state("prepared"); order.push("attach"); return { ok: true }; }),
    controlDictationAudio: vi.fn(async ({ input }: { audioId: string; input: DictationInput }) => {
      order.push(input.kind);
      if (input.kind === "start" && options.ready !== false) emit(state("ready"));
      if (input.kind === "recording") emit(state("recording"));
      if (input.kind === "stop") emit(options.final ?? state("complete", "检查 API 配置。"));
      return { ok: true };
    }),
    appendDictationAudio: vi.fn(async () => { order.push("frame"); return { ok: true }; }),
    drainDictationAudio: vi.fn(async () => { order.push("drain"); return { ok: true }; }),
    getDictationRecovery: vi.fn(async () => ({ ok: true, recovery })),
    replayDictationAudio: vi.fn(async () => { order.push("replay"); emit(state("complete", "重新转写的内容")); return { ok: true }; }),
    retainDictationAudio: vi.fn(async () => {
      order.push("retain");
      recovery = { audioId, owner, state: currentState, durationMs: 1000, bytes: 32000, retained: true, canReplay: true, configuration };
      return { ok: true, recovery };
    }),
    releaseDictationAudio: vi.fn(async () => { order.push("release"); recovery = null; return { ok: true }; }),
    onDictationAudio: listener => { events.add(listener); return () => { events.delete(listener); }; },
  };
  const inputStop = vi.fn();
  let captureOptions: PcmCaptureOptions | undefined;
  const openCapture = vi.fn(async (input: PcmCaptureOptions) => {
    order.push("device"); captureOptions = input; await input.beforeCapture?.();
    return { stop: inputStop, finish: vi.fn(async () => { order.push("finish"); await input.onFrame(new Float32Array([.25]).buffer, 0); }) };
  });
  const session = new DictationSession({ client, sessionId: "one", draftId: "composer", label: "Composer", available: true, visible: true, remote: false, zh: true, deviceId: "", editor: () => editor, onSubmit: submitted }, { api: () => api, openCapture, permission: () => options.permission });
  sessions.push(session); session.connect();
  return { session, api, editor, submitted, commands, order, emit, openCapture, inputStop, capture: () => captureOptions!, retain: () => { for (const listener of events) if (recovery) listener({ kind: "retained", recovery }); } };
}

describe("dictation input lifecycle", () => {
  it("does not request a device before native readiness, and cancelled readiness cannot reopen it", async () => {
    const s = setup({ ready: false });
    const starting = s.session.start("hold");
    await until(() => s.order.includes("start"));
    expect(s.openCapture).not.toHaveBeenCalled();
    await s.session.cancel(); s.emit(state("ready")); await starting;
    expect(s.openCapture).not.toHaveBeenCalled();
    expect(s.editor.commitDictation).not.toHaveBeenCalled();
  });
  it("finishes the device and final frame before Runtime drain and stop, then commits exactly once", async () => {
    const s = setup(); await s.session.start(); await s.session.stop();
    expect(s.order).toEqual(["attach", "start", "device", "recording", "finish", "frame", "drain", "stop", "release"]);
    expect(s.editor.commitDictation).toHaveBeenCalledTimes(1);
    expect(s.editor.commitDictation).toHaveBeenCalledWith(expect.any(String), "检查 API 配置。");
    expect(s.submitted).not.toHaveBeenCalled();
    s.emit(state("complete", "duplicate")); expect(s.editor.commitDictation).toHaveBeenCalledTimes(1);
    expect(s.commands).toEqual(["dictation.inspect", "dictation.open"]);
  });
  it("keeps disabled first-use configuration actionable instead of opening a microphone", async () => {
    const s = setup({ blocked: true }); await s.session.start();
    expect(s.session.getSnapshot()).toMatchObject({ phase: "review", configuration: { enabled: false } });
    expect(s.openCapture).not.toHaveBeenCalled();
    expect(s.api.attachDictationAudio).not.toHaveBeenCalled();
  });
  it("cancels during the operating system permission prompt and ignores the late grant", async () => {
    const permission = deferred<void>(); const s = setup({ permission: permission.promise });
    const starting = s.session.start(); await until(() => s.session.getSnapshot().phase === "opening");
    await s.session.cancel(); permission.resolve(); await starting;
    expect(s.openCapture).not.toHaveBeenCalled(); expect(s.editor.commitDictation).not.toHaveBeenCalled();
  });
  it("interrupts a recording without cloud flush, retains it and retries without reopening the microphone", async () => {
    const s = setup(); await s.session.start("hold"); s.emit({ ...state("recording", "确认部分"), partialText: "未确认" });
    await s.session.interrupt();
    expect(s.order).not.toContain("stop"); expect(s.session.getSnapshot()).toMatchObject({ phase: "retained", recovery: { bytes: 32000 } });
    expect(s.editor.commitDictation).not.toHaveBeenCalled();
    await s.session.start("retry", false, true);
    expect(s.openCapture).toHaveBeenCalledTimes(1); expect(s.api.replayDictationAudio).toHaveBeenCalledTimes(1);
    expect(s.editor.commitDictation).toHaveBeenCalledWith(expect.any(String), "重新转写的内容");
    expect(s.submitted).not.toHaveBeenCalled();
  });
  it("honors native submit only for an unchanged normal hold result", async () => {
    const s = setup({ final: { ...state("complete", "执行任务"), submit: true } });
    await s.session.start("hold"); await s.session.stop(); expect(s.submitted).toHaveBeenCalledTimes(1);
    vi.mocked(s.editor.commitDictation).mockReturnValue({ applied: true, unchanged: false });
    await s.session.start("hold"); await s.session.stop(); expect(s.submitted).toHaveBeenCalledTimes(1);
  });
  it("does not reopen or submit when the target changes during permission or final release", async () => {
    const permission = deferred<void>();
    const s = setup({ permission: permission.promise });
    const start = s.session.start("hold");
    await until(() => s.session.getSnapshot().phase === "opening");
    s.session.setOptions({ ...s.session.options, sessionId: "two" });
    permission.resolve(); await start;
    expect(s.openCapture).not.toHaveBeenCalled();
    expect(s.editor.commitDictation).not.toHaveBeenCalled();
    expect(s.submitted).not.toHaveBeenCalled();

    const final = setup({ final: { ...state("complete", "执行任务"), submit: true } });
    const released = deferred<void>();
    vi.mocked(final.api.releaseDictationAudio).mockImplementation(async () => { await released.promise; return { ok: true }; });
    await final.session.start("hold"); const stop = final.session.stop();
    await until(() => vi.mocked(final.editor.commitDictation).mock.calls.length > 0);
    final.session.setOptions({ ...final.session.options, sessionId: "two" });
    released.resolve(); await stop;
    expect(final.editor.commitDictation).toHaveBeenCalledTimes(1);
    expect(final.submitted).not.toHaveBeenCalled();
  });
  it("reports a denied microphone with a settings recovery path and never records", async () => {
    const s = setup();
    s.openCapture.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    await s.session.start();
    expect(s.session.getSnapshot().message).toContain("系统隐私设置");
    expect(s.editor.commitDictation).not.toHaveBeenCalled();
  });
  it("keeps recovery text exactly once while release is pending or fails", async () => {
    const s = setup(); await s.session.start(); s.emit(state("recording", "保留这一段")); await s.session.interrupt();
    const release = deferred<{ ok: boolean; message: string }>();
    vi.mocked(s.api.releaseDictationAudio).mockImplementation(async () => release.promise);
    const first = s.session.keepText();
    await s.session.keepText();
    expect(s.editor.commitDictation).toHaveBeenCalledTimes(1);
    release.resolve({ ok: false, message: "The audio service is unavailable" }); await first;
    expect(s.session.getSnapshot()).toMatchObject({ phase: "retained", inserted: true });
    await s.session.keepText();
    expect(s.editor.commitDictation).toHaveBeenCalledTimes(1);
  });
  it("retains audio instead of guessing a new insertion point when the editor transaction expired", async () => {
    const s = setup(); vi.mocked(s.editor.commitDictation).mockReturnValue({ applied: false, unchanged: false });
    await s.session.start(); await s.session.stop();
    expect(s.session.getSnapshot().phase).toBe("retained"); expect(s.api.releaseDictationAudio).not.toHaveBeenCalled();
    expect(s.submitted).not.toHaveBeenCalled();
  });
});
