import type { ArtifactRecord, MediaDetail, MediaModelChoice } from "@omp-studio/studio-protocol";
export const PREVIEW_MEDIA_MODELS: MediaModelChoice[] = [
  { selector: "demo/image", name: "Image model", kind: "image", api: "openai-images", local: false, parameters: ["prompt", "inputArtifacts", "aspectRatio", "imageSize", "count"] },
  { selector: "demo/video", name: "Video model", kind: "video", api: "openrouter-video", local: false, parameters: ["prompt", "duration", "resolution", "aspectRatio", "size", "firstFrame", "lastFrame", "references", "generateAudio", "seed", "creativity", "upscaleFactor", "providerOptions"] },
  { selector: "demo/speech", name: "Speech model", kind: "speech", api: "openai-speech", local: false, parameters: ["text", "voice", "format", "speed", "instructions"], formats: ["mp3", "wav", "opus", "flac"] },
  { selector: "demo/transcription", name: "Transcription model", kind: "transcription", api: "openai-transcriptions", local: false, parameters: ["audioArtifact", "language", "prompt", "timestamps", "temperature"] },
];
export const PREVIEW_MEDIA_INPUTS: ArtifactRecord[] = [
  { artifactId: "11111111-1111-4111-8111-111111111111", name: "review-notes.wav", kind: "audio", mimeType: "audio/wav", bytes: 96000, createdAt: "2026-09-25T00:00:00Z", sha256: "0".repeat(64) },
  { artifactId: "22222222-2222-4222-8222-222222222222", name: "workspace-reference.png", kind: "image", mimeType: "image/png", bytes: 184320, createdAt: "2026-09-25T00:00:00Z", sha256: "0".repeat(64) },
];
export const PREVIEW_MEDIA_DETAIL: MediaDetail = {
  job: { id: "33333333-3333-4333-8333-333333333333", sessionId: "preview", type: "transcription", state: "completed", createdAt: 1, updatedAt: 2000, model: "demo/transcription", cost: 0.001, canResume: false, outputCount: 0 },
  request: { type: "transcription", model: "demo/transcription", audioArtifact: PREVIEW_MEDIA_INPUTS[0]!.artifactId }, outputs: [], text: "请检查服务配置保存后不会自动启动，并验证录音结束后麦克风已经释放。",
};
