import captureModule from "./live-capture.worklet.js?url&no-inline";

export interface PcmCapture {
  finish(): Promise<void>;
  stop(): void;
}
export interface LiveCapture extends PcmCapture {
  audioId: string;
  pause(): void;
}

export interface PcmCaptureOptions {
  deviceId?: string;
  signal: AbortSignal;
  beforeCapture?(): Promise<void>;
  onFrame(bytes: ArrayBuffer, sequence: number): Promise<void>;
  onLevel?(level: number): void;
  onFault(message: string): void;
}

/** Capture is opened only after its caller has a ready receiver. No microphone monitoring output. */
export async function openPcmCapture(options: PcmCaptureOptions): Promise<PcmCapture> {
  options.signal.throwIfAborted();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this window");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}) },
    video: false,
  });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  let sequence = 0;
  let lastLevelAt = 0;
  let finishPromise: Promise<void> | undefined;
  let drained: (() => void) | undefined;
  let rejectDrain: ((error: Error) => void) | undefined;

  let tracksStopped = false;
  const stopTracks = () => {
    if (tracksStopped) return;
    tracksStopped = true;
    stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    stopTracks();
    options.signal.removeEventListener("abort", stop);
    rejectDrain?.(new DOMException("Capture cancelled", "AbortError"));
    rejectDrain = undefined;
    if (processor) {
      processor.port.onmessage = null;
      processor.port.postMessage("stop");
      processor.disconnect();
      processor.port.close();
      processor = undefined;
    }
    source?.disconnect();
    source = undefined;
    void context?.close().catch(() => {});
    context = undefined;
  };
  const fault = (cause: unknown) => {
    if (closed || failure) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    rejectDrain?.(failure);
    stop();
    options.onFault(failure.message);
  };
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    options.signal.throwIfAborted();
    if (document.hidden) throw new Error("Show the window before opening the microphone");
    stream.getTracks().forEach(track => { track.onended = () => fault(new Error("Microphone disconnected")); });
    context = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    if (context.sampleRate !== 16000) throw new Error("The audio system could not create a 16 kHz input");
    await context.audioWorklet.addModule(captureModule);
    options.signal.throwIfAborted();
    await options.beforeCapture?.();
    options.signal.throwIfAborted();
    if (closed) throw new DOMException("Capture cancelled", "AbortError");
    processor = new AudioWorkletNode(context, "omp-studio-live-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    processor.port.onmessage = event => {
      if (event.data?.error) { fault(new Error(String(event.data.error))); return; }
      if (event.data?.drained) { drained?.(); return; }
      const bytes = event.data?.bytes;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > 1280 || bytes.byteLength % 4) {
        fault(new Error("Invalid audio frame"));
        return;
      }
      const now = performance.now();
      if (options.onLevel && now - lastLevelAt >= 80) {
        let squares = 0;
        const samples = new Float32Array(bytes);
        for (const sample of samples) squares += sample * sample;
        options.onLevel(Math.min(1, Math.sqrt(squares / samples.length) * 4));
        lastLevelAt = now;
      }
      tail = tail.then(async () => {
        if (closed) return;
        await options.onFrame(bytes, sequence++);
        if (!closed) processor?.port.postMessage("ack");
      }).catch(fault);
    };
    processor.onprocessorerror = () => fault(new Error("Audio processor stopped"));
    source = context.createMediaStreamSource(stream);
    source.connect(processor);
    processor.connect(context.destination);
    await context.resume();
    options.signal.throwIfAborted();
    const finish = (): Promise<void> => {
      if (finishPromise) return finishPromise;
      if (closed) return failure ? Promise.reject(failure) : Promise.resolve();
      stopTracks();
      source?.disconnect();
      source = undefined;
      finishPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            drained = resolve;
            rejectDrain = reject;
            timer = setTimeout(() => reject(new Error("Audio input did not finish in time")), 2000);
            processor?.port.postMessage("drain");
          });
          rejectDrain = undefined;
          await tail;
          if (failure) throw failure;
        } finally {
          clearTimeout(timer);
          drained = undefined;
          rejectDrain = undefined;
          stop();
        }
      })();
      return finishPromise;
    };
    return { finish, stop };
  } catch (cause) {
    stop();
    throw cause;
  }
}

/** Chromium owns device consent; Main owns the Runtime endpoint/token and transport. */
export async function openLiveCapture(options: {
  deviceId?: string; signal: AbortSignal; attach(): Promise<string>; onFault(message: string): void;
}): Promise<LiveCapture> {
  const api = globalThis.ompStudioChrome;
  if (!api?.attachLiveAudio || !api.appendLiveAudio || !api.detachLiveAudio) throw new Error("Desktop Live audio is unavailable");
  let audioId: string | undefined;
  const detach = () => { if (audioId) void api.detachLiveAudio!({ audioId }).catch(() => {}); };
  try {
    const capture = await openPcmCapture({
      ...(options.deviceId ? { deviceId: options.deviceId } : {}),
      signal: options.signal,
      beforeCapture: async () => {
        audioId = await options.attach();
        if (options.signal.aborted) { detach(); options.signal.throwIfAborted(); }
      },
      onFrame: async (bytes, sequence) => {
        const result = await api.appendLiveAudio!({ audioId: audioId!, sequence, bytes });
        if (!result.ok) throw new Error(result.message ?? "Live audio detached");
      },
      onFault: message => { detach(); options.onFault(message); },
    });
    const stop = () => { capture.stop(); detach(); };
    options.signal.addEventListener("abort", stop, { once: true });
    return { audioId: audioId!, pause: capture.stop, finish: capture.finish, stop: () => { options.signal.removeEventListener("abort", stop); stop(); } };
  } catch (cause) {
    detach();
    throw cause;
  }
}
