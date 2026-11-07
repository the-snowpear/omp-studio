import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { openWebRtcCapture } from "./webrtcCapture";

const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia); else Reflect.deleteProperty(navigator, "mediaDevices"); });

function fixture() {
  let peer!: Peer;
  const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Peer {
    connectionState = "new"; iceGatheringState = "complete"; localDescription: { sdp: string } | null = null;
    onconnectionstatechange: (() => void) | null = null; ontrack: unknown;
    addTrack = vi.fn(); close = vi.fn(); createDataChannel = vi.fn();
    addEventListener = vi.fn(); removeEventListener = vi.fn();
    constructor() { peer = this; }
    createOffer = async () => ({ type: "offer", sdp: "browser-offer" });
    setLocalDescription = async (offer: { sdp: string }) => { this.localDescription = offer; };
    setRemoteDescription = vi.fn(async () => { this.connectionState = "connected"; });
  }
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("Audio", class { autoplay = false; srcObject: unknown; pause() {} play() { return Promise.resolve(); } });
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  const query = vi.fn<(kind: string, input?: unknown) => Promise<unknown>>(async kind => kind === "live.webrtc.connect" ? { audioId: "call", sdpAnswer: "runtime-answer", state: { available: true, attached: true, voice: "sol", phase: "listening", muted: false, inputLevel: 0, outputLevel: 0, transcripts: [] } } : {});
  const client = { query } as unknown as StudioClient;
  const controller = new AbortController(), fault = vi.fn();
  const options = { client, sessionId: "session", audioId: "call", voice: "sol", signal: controller.signal, onFault: fault };
  return { options, controller, fault, query, getUserMedia, track, stream, peer: () => peer };
}

it("owns microphone tracks in the browser and disables them on mute before releasing a disconnected peer", async () => {
  const f = fixture(); const capture = await openWebRtcCapture(f.options);
  expect(f.query).toHaveBeenCalledWith("live.webrtc.connect", { sessionId: "session", audioId: "call", voice: "sol", sdpOffer: "browser-offer" });
  expect(f.peer().setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "runtime-answer" });
  capture.setMuted(true); expect(f.track.enabled).toBe(false);
  capture.setMuted(false); expect(f.track.enabled).toBe(true);
  f.peer().connectionState = "disconnected"; f.peer().onconnectionstatechange?.(); capture.stop();
  expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.peer().close).toHaveBeenCalledOnce();
  expect(f.query.mock.calls.filter(([kind]) => kind === "live.webrtc.release")).toHaveLength(1);
  expect(f.fault).toHaveBeenCalledWith("Live audio disconnected");
});

it("late microphone consent after cancellation closes the tracks without signaling a Runtime", async () => {
  const f = fixture(); let grant!: (stream: typeof f.stream) => void;
  f.getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const pending = openWebRtcCapture(f.options); const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  f.controller.abort(); grant(f.stream); await rejected;
  expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.query).not.toHaveBeenCalled();
});

it("cancellation during SDP negotiation releases its allocated id and ignores the late answer", async () => {
  const f = fixture(); let answer!: (value: unknown) => void;
  f.query.mockImplementation(async kind => kind === "live.webrtc.connect" ? new Promise(resolve => { answer = resolve; }) : {});
  const pending = openWebRtcCapture(f.options); const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(answer).toBeTypeOf("function")); f.controller.abort();
  answer({ audioId: "call", sdpAnswer: "late", state: {} }); await rejected;
  expect(f.query).toHaveBeenCalledWith("live.webrtc.release", { sessionId: "session", audioId: "call" });
  expect(f.peer().setRemoteDescription).not.toHaveBeenCalled(); expect(f.track.stop).toHaveBeenCalledOnce();
});
