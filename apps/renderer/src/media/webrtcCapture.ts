import type { StudioClient } from "@omp-studio/client-contract";
import type { LiveAudioState } from "@omp-studio/studio-protocol";

export interface WebRtcCapture {
  audioId: string;
  state: LiveAudioState;
  setMuted(muted: boolean): void;
  stop(): void;
}

function waitForPeer(peer: RTCPeerConnection, event: "icegatheringstatechange" | "connectionstatechange", ready: () => boolean, signal: AbortSignal): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => { clearTimeout(timer); peer.removeEventListener(event, changed); signal.removeEventListener("abort", aborted); error ? reject(error) : resolve(); };
    const changed = () => { if (ready()) finish(); else if (["failed", "closed", "disconnected"].includes(peer.connectionState)) finish(new Error("Live audio connection failed")); };
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("Live audio connection timed out")), 30000);
    peer.addEventListener(event, changed); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted(); else changed();
  });
}

/** The browser owns both audio tracks; Runtime owns credentials and the Live task session. */
export async function openWebRtcCapture(options: {
  client: StudioClient;
  sessionId: string;
  audioId: string;
  voice: string;
  deviceId?: string;
  signal: AbortSignal;
  onFault(message: string): void;
}): Promise<WebRtcCapture> {
  const peer = new RTCPeerConnection();
  const speaker = new Audio(); speaker.autoplay = true;
  let input: MediaStream | undefined, closed = false, signaled = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    input?.getTracks().forEach(track => track.stop());
    peer.close(); speaker.pause(); speaker.srcObject = null;
    options.signal.removeEventListener("abort", stop);
    if (signaled) void options.client.query("live.webrtc.release", { sessionId: options.sessionId, audioId: options.audioId }).catch(() => {});
  };
  options.signal.addEventListener("abort", stop, { once: true });
  peer.ontrack = event => {
    if (closed) return;
    speaker.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void speaker.play().catch(() => { options.onFault("Audio playback could not start"); stop(); });
  };
  peer.onconnectionstatechange = () => {
    if (!closed && ["failed", "disconnected", "closed"].includes(peer.connectionState)) {
      options.onFault("Live audio disconnected"); stop();
    }
  };
  try {
    options.signal.throwIfAborted();
    input = await navigator.mediaDevices.getUserMedia({ audio: { ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (closed || options.signal.aborted) { input.getTracks().forEach(track => track.stop()); options.signal.throwIfAborted(); throw new Error("Live audio cancelled"); }
    for (const track of input.getAudioTracks()) {
      track.addEventListener("ended", () => { if (!closed) { options.onFault("Microphone disconnected"); stop(); } }, { once: true });
      peer.addTrack(track, input);
    }
    peer.createDataChannel("oai-events");
    await peer.setLocalDescription(await peer.createOffer());
    await waitForPeer(peer, "icegatheringstatechange", () => peer.iceGatheringState === "complete", options.signal);
    options.signal.throwIfAborted();
    signaled = true;
    const result = await options.client.query("live.webrtc.connect", { sessionId: options.sessionId, audioId: options.audioId, voice: options.voice, sdpOffer: peer.localDescription!.sdp });
    options.signal.throwIfAborted();
    await peer.setRemoteDescription({ type: "answer", sdp: result.sdpAnswer });
    await waitForPeer(peer, "connectionstatechange", () => peer.connectionState === "connected", options.signal);
    return { audioId: result.audioId, state: result.state, stop, setMuted: muted => input?.getAudioTracks().forEach(track => { track.enabled = !muted; }) };
  } catch (error) { stop(); throw error; }
}
