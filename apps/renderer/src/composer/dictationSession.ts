import type { StudioClient } from "@omp-studio/client-contract";
import type { DictationCaptureState, DictationConfiguration, DictationInputMode } from "@omp-studio/studio-protocol";
import type { DictationAudioApi, DictationAudioResult, DictationDesktopEvent, DictationOwner, DictationRecovery } from "../../../desktop/src/dictation-audio-shared";
import type { ComposerDictationHandle } from "./dictationTypes";
import { acceptDictationConsent, dictationCommand, needsDictationConsent } from "./dictationClient";
import { openPcmCapture, type PcmCapture, type PcmCaptureOptions } from "../media/liveCapture";
import { ensureMicrophoneAccess, microphoneFailureMessage } from "../media/microphoneAccess";
import { hostErrorMessage } from "../hostError";

export type DictationViewPhase = "off" | "inspecting" | "review" | "preparing" | "opening" | "recording" | "transcribing" | "retained" | "complete" | "error";
export interface DictationView {
  phase: DictationViewPhase;
  configuration?: DictationConfiguration;
  capture?: DictationCaptureState;
  recovery?: DictationRecovery;
  inserted?: boolean;
  pendingRetry?: boolean;
  message: string;
  level: number;
  startedAt?: number;
}
export interface DictationSessionOptions {
  client?: StudioClient;
  sessionId?: string;
  draftId: string;
  label: string;
  available: boolean;
  visible: boolean;
  remote: boolean;
  zh: boolean;
  deviceId: string;
  editor(): ComposerDictationHandle | null;
  ensureSession?(signal: AbortSignal): Promise<string>;
  onSubmit?(): void;
}
interface CaptureRun {
  localId: string;
  sourceSessionId?: string;
  client: StudioClient;
  editor: ComposerDictationHandle;
  draftId: string;
  state?: DictationCaptureState;
  completion?: Promise<void>;
  owner?: DictationOwner;
  audioId?: string;
  mode: DictationInputMode;
  abort: AbortController;
  input?: PcmCapture;
  stopped: boolean;
  finishing: boolean;
  commit: boolean;
  allowSubmit: boolean;
}
interface Dependencies {
  api(): DictationAudioApi | undefined;
  openCapture(options: PcmCaptureOptions): Promise<PcmCapture>;
  permission(zh: boolean): Promise<void> | undefined;
}
const EMPTY: DictationView = { phase: "off", message: "", level: 0 };

export function dictationDesktopApi(api = globalThis.ompStudioChrome): DictationAudioApi | undefined {
  if (!api?.attachDictationAudio || !api.controlDictationAudio || !api.appendDictationAudio || !api.drainDictationAudio || !api.getDictationRecovery || !api.replayDictationAudio || !api.retainDictationAudio || !api.releaseDictationAudio || !api.onDictationAudio) return undefined;
  return api as typeof api & DictationAudioApi;
}
function checked(result: DictationAudioResult): DictationAudioResult {
  if (!result.ok) throw { code: result.code ?? "AUDIO_UNAVAILABLE", message: result.message ?? "Audio connection ended" };
  return result;
}

/** Owns only one input surface; Main owns the window's single recoverable recording. */
export class DictationSession {
  options: DictationSessionOptions;
  #view: DictationView = EMPTY;
  #listeners = new Set<() => void>();
  #run: CaptureRun | undefined;
  #off: (() => void) | undefined;
  #appliedAudioId: string | undefined;
  #inspection = 0;
  #connected = false;
  #cleanup: Promise<void> | undefined;
  readonly #deps: Dependencies;

  constructor(options: DictationSessionOptions, dependencies: Partial<Dependencies> = {}) {
    this.options = options;
    this.#deps = { api: dictationDesktopApi, openCapture: openPcmCapture, permission: ensureMicrophoneAccess, ...dependencies };
  }
  getSnapshot = (): DictationView => this.#view;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  get active(): boolean { return this.#run !== undefined && !this.#run.stopped; }
  #text(cn: string, en: string): string { return this.options.zh ? cn : en; }
  #publish(patch: Partial<DictationView>): void {
    this.#view = { ...this.#view, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #replace(view: DictationView): void { this.#view = view; for (const listener of this.#listeners) listener(); }

  connect(): void {
    this.#connected = true;
    this.#off = this.#deps.api()?.onDictationAudio(event => this.#event(event));
    void this.refreshRecovery();
  }
  disconnect(): void {
    this.#connected = false;
    this.#inspection++;
    this.#off?.();
    this.#off = undefined;
    void this.interrupt();
  }
  setOptions(options: DictationSessionOptions): void {
    const previous = this.options;
    this.options = options;
    const run = this.#run;
    if (run && (options.draftId !== run.draftId || options.client !== run.client || options.remote || !options.visible || !options.available || (previous.sessionId !== options.sessionId && (run.owner ? options.sessionId !== run.owner.sessionId : run.sourceSessionId !== undefined && options.sessionId !== run.sourceSessionId)))) void this.interrupt();
    if (previous.sessionId !== options.sessionId || previous.draftId !== options.draftId || previous.client !== options.client) this.#inspection++;
  }
  async inspect(): Promise<void> {
    const { client, sessionId, available, remote } = this.options;
    if (!client || !sessionId || !available || remote || this.active) return;
    const generation = ++this.#inspection;
    try {
      const configuration = await dictationCommand(client, "dictation.inspect", { sessionId });
      if (this.#connected && generation === this.#inspection) this.#publish({ configuration });
    } catch (cause) {
      if (this.#connected && generation === this.#inspection) this.#publish({ message: hostErrorMessage(cause, this.#text("无法读取听写设置", "Could not inspect dictation")) });
    }
  }
  async refreshRecovery(): Promise<void> {
    const api = this.#deps.api();
    if (!api) return;
    try {
      const generation = this.#inspection;
      const result = checked(await api.getDictationRecovery());
      if (!this.#connected || this.active || this.#cleanup || generation !== this.#inspection) return;
      if (this.#appliedAudioId && result.recovery && this.#appliedAudioId === result.recovery.audioId) {
        this.#publish({ phase: "retained", inserted: true, recovery: result.recovery, capture: result.recovery.state });
        return;
      }
      if (result.recovery?.retained) this.#publish({ phase: "retained", recovery: result.recovery, capture: result.recovery.state });
      else if (!result.recovery && this.#view.recovery) {
        const { recovery: _, capture: __, ...rest } = this.#view;
        this.#replace({ ...rest, phase: "off", message: "", level: 0 });
      }
    } catch (cause) { if (this.#connected) this.#publish({ message: hostErrorMessage(cause, "Audio recovery unavailable") }); }
  }
  review(): void { if (!this.active) this.#publish({ phase: this.#view.recovery ? "retained" : "review", message: "" }); }
  dismiss(): void {
    if (!this.active) this.#publish({ phase: this.#view.recovery ? "retained" : "off", message: "", pendingRetry: false });
  }
  #current(run: CaptureRun): boolean { return this.#run === run && !run.stopped && !run.abort.signal.aborted; }
  #assertCurrent(run: CaptureRun): void {
    run.abort.signal.throwIfAborted();
    if (!this.#current(run)) throw new DOMException("Dictation cancelled", "AbortError");
  }
  async #target(run: CaptureRun): Promise<string> {
    const sessionId = this.options.ensureSession ? await this.options.ensureSession(run.abort.signal) : this.options.sessionId;
    this.#assertCurrent(run);
    if (!sessionId) throw new Error(this.#text("请先创建或打开一个会话，再使用语音输入。", "Create or open a conversation before using dictation."));
    run.owner = { sessionId, draftId: run.draftId, label: this.options.label };
    return sessionId;
  }
  async #abandonPrepared(run: CaptureRun): Promise<void> {
    if (!run.audioId || !run.owner) return;
    try { await dictationCommand(run.client, "dictation.cancel", { sessionId: run.owner.sessionId, audioId: run.audioId }); } catch { /* Prepared channels also have a Runtime expiry. */ }
  }
  async start(mode: DictationInputMode = "click", confirmed = false, retry = false): Promise<void> {
    if (this.active || this.#cleanup) return;
    if (this.#appliedAudioId) {
      this.#publish({ phase: "retained", message: this.#text("文字已经插入，请先清除上次录音缓存再开始。", "Text was already inserted. Clear the previous recording cache before starting again.") });
      return;
    }
    const api = this.#deps.api();
    const reviewedConfigurationId = this.#view.configuration?.configurationId;
    const recovery = retry ? this.#view.recovery : undefined;
    if (!retry && this.#view.recovery) { this.#publish({ phase: "retained" }); return; }
    if (!api || !this.options.client || this.options.remote || !this.options.available || !this.options.visible) {
      this.#publish({ phase: "review", message: this.#text(this.options.remote ? "远程工作区暂不转发本机麦克风。" : "需要已连接的本机 Runtime 和新版桌面音频通道。", "A local Runtime and the updated desktop audio channel are required.") });
      return;
    }
    if (retry && (!recovery || !this.ownsRecovery())) return;
    const editor = this.options.editor();
    if (!editor) { this.#publish({ phase: "error", message: this.#text("请先将光标放在可编辑的输入框中。", "Place the cursor in an editable composer first.") }); return; }
    const run: CaptureRun = { localId: crypto.randomUUID(), ...(this.options.sessionId ? { sourceSessionId: this.options.sessionId } : {}), client: this.options.client, editor, draftId: this.options.draftId, mode: retry ? "retry" : mode, abort: new AbortController(), stopped: false, finishing: false, commit: false, allowSubmit: !retry };
    this.#run = run;
    if (!run.editor.beginDictation(run.localId)) {
      this.#run = undefined;
      this.#publish({ phase: "error", message: this.#text("请先将光标放在可编辑的输入框中。", "Place the cursor in an editable composer first.") });
      return;
    }
    this.#publish({ phase: "inspecting", message: "", level: 0, capture: { phase: "prepared", committedText: "", partialText: "", submit: false } });
    try {
      const sessionId = await this.#target(run);
      const client = run.client;
      const configuration = await dictationCommand(client, "dictation.inspect", { sessionId });
      this.#assertCurrent(run);
      this.#publish({ configuration });
      if (!configuration.enabled || configuration.blockedReason || (confirmed && reviewedConfigurationId !== configuration.configurationId) || (needsDictationConsent(configuration) && !confirmed)) {
        run.editor.cancelDictation(run.localId);
        this.#run = undefined;
        this.#publish({ phase: "review", pendingRetry: retry, message: configuration.message ?? "" });
        return;
      }
      if (confirmed) acceptDictationConsent(configuration);
      const existing = checked(await api.getDictationRecovery()).recovery;
      this.#assertCurrent(run);
      if (existing && existing.audioId !== recovery?.audioId) {
        run.editor.cancelDictation(run.localId);
        this.#run = undefined;
        if (existing.retained) this.#publish({ phase: "retained", recovery: existing, capture: existing.state });
        else this.#publish({ phase: "review", message: this.#text("另一个输入位置正在听写，请先结束那次录音。", "Another input is dictating. Finish that recording first.") });
        return;
      }
      this.#publish({ phase: "preparing", pendingRetry: false, message: "" });
      const channel = await dictationCommand(client, "dictation.open", { sessionId, configurationId: configuration.configurationId });
      run.audioId = channel.audioId;
      if (!this.#current(run)) { await this.#abandonPrepared(run); return; }
      checked(await api.attachDictationAudio({ channel, owner: run.owner!, ...(recovery ? { recoveryId: recovery.audioId } : {}) }));
      if (!this.#current(run)) {
        if (this.#cleanup) await this.#cleanup;
        const late = (await api.getDictationRecovery()).recovery;
        if (late?.audioId === channel.audioId) {
          if (recovery) await api.retainDictationAudio({ audioId: channel.audioId });
          else await api.releaseDictationAudio({ audioId: channel.audioId });
        }
        await this.#abandonPrepared(run);
        return;
      }
      checked(await api.controlDictationAudio({ audioId: channel.audioId, input: { kind: "start", mode: run.mode, configurationId: configuration.configurationId } }));
      await this.#waitFor(run, state => state.phase === "ready", 15 * 60 * 1000);
      this.#assertCurrent(run);
      if (recovery) {
        run.commit = true;
        run.finishing = true;
        this.#publish({ phase: "transcribing", message: this.#text("正在重新转写保留的录音…", "Transcribing the retained recording…") });
        checked(await api.replayDictationAudio({ audioId: channel.audioId }));
        await this.#waitFor(run, state => state.phase === "complete", 130000);
        await run.completion;
        return;
      }
      this.#publish({ phase: "opening", message: "" });
      await this.#deps.permission(this.options.zh);
      this.#assertCurrent(run);
      const input = await this.#deps.openCapture({
        signal: run.abort.signal,
        ...(this.options.deviceId ? { deviceId: this.options.deviceId } : {}),
        beforeCapture: async () => { checked(await api.controlDictationAudio({ audioId: channel.audioId, input: { kind: "recording" } })); this.#assertCurrent(run); },
        onFrame: async (bytes, sequence) => { checked(await api.appendDictationAudio({ audioId: channel.audioId, sequence, bytes })); },
        onLevel: level => { if (this.#current(run) && !run.finishing) this.#publish({ level }); },
        onFault: message => { if (this.#current(run)) void this.#fail(run, new Error(message)); },
      });
      if (!this.#current(run)) { input.stop(); return; }
      run.input = input;
      this.#publish({ phase: "recording", startedAt: Date.now(), message: "" });
    } catch (cause) {
      if (this.#current(run)) await this.#fail(run, cause);
      else if (run.audioId) await this.#abandonPrepared(run);
    }
  }
  async stop(): Promise<void> {
    const run = this.#run;
    if (!run || run.finishing || run.stopped) return;
    if (!run.input) { await this.cancel(); return; }
    run.finishing = true;
    run.commit = true;
    this.#publish({ phase: "transcribing", level: 0, message: "" });
    const api = this.#deps.api();
    try {
      if (!api || !run.audioId) throw new Error("Audio connection ended");
      await run.input.finish();
      this.#assertCurrent(run);
      checked(await api.drainDictationAudio({ audioId: run.audioId }));
      this.#assertCurrent(run);
      checked(await api.controlDictationAudio({ audioId: run.audioId, input: { kind: "stop" } }));
      await this.#waitFor(run, state => state.phase === "complete", 130000);
      await run.completion;
    } catch (cause) { if (this.#current(run)) await this.#fail(run, cause); }
  }
  #waitFor(run: CaptureRun, done: (state: DictationCaptureState) => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (cause?: unknown) => { clearTimeout(timer); off(); run.abort.signal.removeEventListener("abort", aborted); if (cause) reject(cause); else resolve(); };
      const check = () => {
        const state = run.state;
        if (state && done(state)) finish();
        else if (state?.phase === "error" || state?.phase === "cancelled") finish(state.error ?? new Error("Dictation ended"));
        else if (run.stopped) finish(new DOMException("Dictation interrupted", "AbortError"));
      };
      const aborted = () => finish(run.abort.signal.reason ?? new DOMException("Dictation cancelled", "AbortError"));
      const off = this.subscribe(check);
      const timer = setTimeout(() => finish(new Error(this.#text("听写等待超时，录音仍可恢复。", "Dictation timed out. Your recording can be recovered."))), timeoutMs);
      run.abort.signal.addEventListener("abort", aborted, { once: true });
      check();
      if (run.abort.signal.aborted) aborted();
    });
  }
  #event(event: DictationDesktopEvent): void {
    if (event.kind === "released") {
      if (this.#appliedAudioId === event.audioId) this.#appliedAudioId = undefined;
      if (this.#view.recovery?.audioId === event.audioId && !this.active) {
        const { recovery: _, ...view } = this.#view;
        this.#replace({ ...view, phase: "off", message: "" });
      }
      return;
    }
    if (event.kind === "retained") {
      if (event.recovery.audioId === this.#appliedAudioId) return;
      const run = this.#run;
      if (run?.audioId === event.recovery.audioId && !run.stopped) void this.interrupt();
      if (!this.active) this.#publish({ phase: "retained", recovery: event.recovery, capture: event.recovery.state, level: 0 });
      return;
    }
    if (event.kind === "limit") {
      const run = this.#run;
      if (run?.audioId === event.audioId && !run.stopped) { run.allowSubmit = false; void this.stop(); }
      return;
    }
    const run = this.#run;
    if (!run || run.audioId !== event.audioId || run.stopped) return;
    if (event.owner.sessionId !== run.owner?.sessionId || event.owner.draftId !== run.draftId) return;
    const state = event.state;
    run.state = state;
    this.#publish({ capture: state, ...(state.phase === "preparing" ? { phase: "preparing" as const } : {}), ...(state.phase === "transcribing" ? { phase: "transcribing" as const } : {}) });
    run.editor.updateDictation(run.localId, state.committedText, state.partialText);
    if (state.phase === "error") { run.completion ??= this.#fail(run, state.error ?? new Error("Transcription failed")); return; }
    if (state.phase === "complete" && run.commit) run.completion ??= this.#complete(run, state);
    else if (state.phase === "cancelled" && this.#current(run)) void this.interrupt();
  }
  async #complete(run: CaptureRun, state: DictationCaptureState): Promise<void> {
    if (!this.#current(run)) return;
    const text = state.committedText + state.partialText;
    const result = text ? run.editor.commitDictation(run.localId, text) : undefined;
    if (!this.#current(run)) return;
    if (text && !result?.applied) { await this.#fail(run, new Error(this.#text("输入位置已改变。录音已保留，请确认新的插入位置。", "The insertion point changed. The recording is retained; choose where to insert it."))); return; }
    if (!text) run.editor.cancelDictation(run.localId);
    const submit = !!text && !!result?.unchanged && run.allowSubmit && state.submit && run.mode !== "click" && run.mode !== "retry";
    this.#appliedAudioId = run.audioId;
    run.stopped = true;
    run.input?.stop();
    this.#run = undefined;
    const { recovery: _, ...view } = this.#view;
    this.#replace({ ...view, phase: "complete", level: 0, message: text ? this.#text("已填入草稿", "Added to your draft") : this.#text("未检测到语音，请检查输入设备后重试。", "No speech detected. Check your microphone and try again.") });
    try {
      if (run.audioId) checked(await this.#deps.api()!.releaseDictationAudio({ audioId: run.audioId }));
    } catch {
      const retained = await this.#deps.api()?.getDictationRecovery().catch(() => undefined);
      this.#publish({ phase: "retained", inserted: true, ...(retained?.recovery ? { recovery: retained.recovery } : {}), message: this.#text("文字已填入草稿，但录音缓存未能清除。请丢弃上次录音，不要重复插入。", "Text was inserted, but the audio cache could not be cleared. Discard the previous recording rather than inserting it again.") });
      return;
    }
    if (this.#appliedAudioId === run.audioId) this.#appliedAudioId = undefined;
    if (submit && this.#connected && !document.hidden && this.options.visible && this.options.client === run.client && this.options.draftId === run.draftId && this.options.sessionId === run.owner?.sessionId) this.options.onSubmit?.();
  }
  async #fail(run: CaptureRun, cause: unknown): Promise<void> {
    if (run.stopped) return;
    const message = microphoneFailureMessage(cause, this.options.zh) ?? hostErrorMessage(cause, this.#text("听写失败", "Dictation failed"));
    await this.interrupt();
    if (!this.active) this.#publish({ phase: this.#view.recovery ? "retained" : "error", message });
  }
  interrupt(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    const run = this.#run;
    if (!run || run.stopped) return Promise.resolve();
    run.stopped = true;
    run.commit = false;
    run.allowSubmit = false;
    run.editor.cancelDictation(run.localId);
    this.#run = undefined;
    const cleanup = this.#retain(run).finally(() => { if (this.#cleanup === cleanup) this.#cleanup = undefined; });
    this.#cleanup = cleanup;
    return cleanup;
  }
  async #retain(run: CaptureRun): Promise<void> {
    const input = run.input;
    if (!input) run.abort.abort();
    const tail = input?.finish().catch(() => {});
    const api = this.#deps.api();
    try {
      if (run.audioId && api) {
        const result = checked(await api.retainDictationAudio({ audioId: run.audioId }));
        await tail;
        await api.drainDictationAudio({ audioId: run.audioId });
        const latest = checked(await api.getDictationRecovery()).recovery ?? result.recovery;
        if (latest && (latest.bytes || latest.state.committedText || latest.state.partialText)) this.#publish({ phase: "retained", recovery: latest, capture: latest.state, level: 0 });
        else { checked(await api.releaseDictationAudio({ audioId: run.audioId })); this.#publish({ phase: "off", level: 0 }); }
      } else { await tail; await this.#abandonPrepared(run); this.#publish({ phase: "off", level: 0 }); }
    } catch (cause) {
      await tail;
      await this.#abandonPrepared(run);
      this.#publish({ phase: "error", level: 0, message: hostErrorMessage(cause, "Could not retain recording") });
    } finally { run.abort.abort(); }
  }
  async cancel(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    const run = this.#run;
    if (!run) return;
    run.stopped = true;
    run.abort.abort();
    run.input?.stop();
    run.editor.cancelDictation(run.localId);
    this.#run = undefined;
    const cleanup = (async () => {
      try {
        if (run.audioId) {
          const result = await this.#deps.api()?.releaseDictationAudio({ audioId: run.audioId });
          if (result && !result.ok && result.code !== "owner-mismatch") checked(result);
          await this.#abandonPrepared(run);
        }
        const configuration = this.#view.configuration;
        this.#replace({ ...EMPTY, ...(configuration ? { configuration } : {}) });
      } catch (cause) { this.#publish({ phase: "error", level: 0, message: hostErrorMessage(cause, "Could not discard recording") }); }
    })().finally(() => { if (this.#cleanup === cleanup) this.#cleanup = undefined; });
    this.#cleanup = cleanup;
    return cleanup;
  }
  ownsRecovery(): boolean {
    const owner = this.#view.recovery?.owner;
    return !!owner && owner.draftId === this.options.draftId && owner.sessionId === this.options.sessionId;
  }
  async discardRecovery(): Promise<void> {
    const recovery = this.#view.recovery;
    if (!recovery || this.#cleanup) return;
    const cleanup = (async () => {
      try {
        checked(await this.#deps.api()!.releaseDictationAudio({ audioId: recovery.audioId }));
        if (this.#appliedAudioId === recovery.audioId) this.#appliedAudioId = undefined;
        const configuration = this.#view.configuration;
        this.#replace({ ...EMPTY, ...(configuration ? { configuration } : {}) });
      } catch (cause) { this.#publish({ phase: "retained", message: hostErrorMessage(cause, "Could not clear recording") }); }
    })().finally(() => { if (this.#cleanup === cleanup) this.#cleanup = undefined; });
    this.#cleanup = cleanup;
    return cleanup;
  }
  async keepText(): Promise<void> {
    const recovery = this.#view.recovery;
    if (!recovery || !this.ownsRecovery() || this.#appliedAudioId || this.#cleanup) return;
    const text = recovery.state.committedText + recovery.state.partialText;
    if (!text) return;
    const id = crypto.randomUUID(), editor = this.options.editor();
    if (!editor?.beginDictation(id) || !editor.commitDictation(id, text).applied) { editor?.cancelDictation(id); this.#publish({ message: this.#text("请将光标放到要插入的位置。", "Place the cursor where you want this text.") }); return; }
    this.#appliedAudioId = recovery.audioId;
    this.#publish({ inserted: true });
    await this.discardRecovery();
    if (!this.#view.recovery) this.#publish({ phase: "complete", message: this.#text("已保留到草稿", "Kept in your draft") });
    else this.#publish({ phase: "retained", inserted: true, message: this.#text("文字已保留，请丢弃剩余录音缓存，不要重复插入。", "Text was kept. Discard the remaining audio cache rather than inserting it again.") });
  }
}
