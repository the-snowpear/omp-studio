import captureModule from "./live-capture.worklet.js?url&no-inline";
export interface LiveCapture { audioId: string; stop(): void }
/** Chromium owns device consent; Main owns the Runtime endpoint/token and transport. */
export async function openLiveCapture(options: {
  deviceId?: string; signal: AbortSignal; attach(): Promise<string>; onFault(message: string): void;
}): Promise<LiveCapture> {
  const api = globalThis.ompStudioChrome;
  if (!api?.attachLiveAudio || !api.appendLiveAudio || !api.detachLiveAudio) throw new Error("Desktop Live audio is unavailable");
  options.signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}) }, video: false });
  let context: AudioContext | undefined; let source: MediaStreamAudioSourceNode | undefined; let capture: AudioWorkletNode | undefined; let audioId: string | undefined; let closed = false;
  const stop = () => {
    if (closed) return; closed = true; options.signal.removeEventListener("abort", stop);
    stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (capture) { capture.port.onmessage = null; capture.port.postMessage("stop"); capture.disconnect(); capture.port.close(); }
    source?.disconnect(); void context?.close().catch(() => {});
    if (audioId) void api.detachLiveAudio!({ audioId }).catch(() => {});
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const fault = (message: string) => { if (closed) return; stop(); options.onFault(message); };
  try {
    options.signal.throwIfAborted(); if (document.hidden) throw new Error("Show the window before starting Live");
    stream.getTracks().forEach(track => { track.onended = () => fault("Microphone disconnected"); });
    context = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    if (context.sampleRate !== 16000) throw new Error("This device cannot provide 16 kHz Live audio");
    await context.audioWorklet.addModule(captureModule); options.signal.throwIfAborted();
    audioId = await options.attach();
    if (closed || options.signal.aborted) { await api.detachLiveAudio({ audioId }).catch(() => {}); options.signal.throwIfAborted(); throw new Error("Microphone capture ended"); }
    capture = new AudioWorkletNode(context, "omp-studio-live-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    let sequence = 0; let tail = Promise.resolve();
    capture.port.onmessage = event => {
      if (event.data?.error) { fault(String(event.data.error)); return; }
      const bytes = event.data?.bytes;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== 1280) { fault("Invalid audio frame"); return; }
      tail = tail.then(async () => {
        if (closed) return;
        const result = await api.appendLiveAudio!({ audioId: audioId!, sequence: sequence++, bytes });
        if (!result.ok) throw new Error(result.message ?? "Live audio detached");
        if (!closed) capture?.port.postMessage("ack");
      }).catch(cause => fault(cause instanceof Error ? cause.message : "Audio transport failed"));
    };
    capture.onprocessorerror = () => fault("Live audio processor stopped");
    source = context.createMediaStreamSource(stream); source.connect(capture); capture.connect(context.destination);
    await context.resume(); options.signal.throwIfAborted();
    return { audioId, stop };
  } catch (cause) { stop(); throw cause; }
}
