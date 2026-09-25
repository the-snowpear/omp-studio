import type { ArtifactRecord } from "@omp-studio/studio-protocol";
const MAX_AUDIO_SECONDS = 600;
export async function uploadMediaBlob(blob: Blob, name: string, scope: { workspaceId?: string | undefined; sessionId?: string | undefined }, signal?: AbortSignal): Promise<ArtifactRecord> {
  const api = globalThis.ompStudioChrome;
  if (!api?.beginMediaUpload || !api.appendMediaUpload || !api.finishMediaUpload) throw new Error("Desktop media upload is unavailable");
  if (!blob.size || blob.size > 64 * 1024 * 1024) throw new Error("Choose a media file up to 64 MiB");
  const mimeType = blob.type.split(";")[0] ?? ""; const kind = mimeType.split("/")[0];
  if (kind !== "image" && kind !== "audio" && kind !== "video") throw new Error("Unsupported media type");
  signal?.throwIfAborted();
  const result = await api.beginMediaUpload({ name, mimeType, kind, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) });
  if (!result.ok || !result.uploadId) throw new Error(result.message ?? "Unable to begin media upload");
  const uploadId = result.uploadId;
  try {
    let sequence = 0;
    for (let offset = 0; offset < blob.size; offset += 262144) {
      signal?.throwIfAborted(); const bytes = await blob.slice(offset, offset + 262144).arrayBuffer(); signal?.throwIfAborted();
      const result = await api.appendMediaUpload({ uploadId, sequence: sequence++, bytes }); if (!result.ok) throw new Error(result.message ?? "Media chunk failed");
    }
    signal?.throwIfAborted(); const result = await api.finishMediaUpload({ uploadId }); if (!result.ok || !result.artifact) throw new Error(result.message ?? "Unable to save media"); return result.artifact;
  } catch (cause) { await api.abortMediaUpload?.({ uploadId }).catch(() => {}); throw cause; }
}
/** Metadata parsing does not allocate a fully decoded audio buffer. */
export function checkAudioDuration(blob: Blob, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const element = document.createElement("audio"); const url = URL.createObjectURL(blob);
    let seeking = false; let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      element.onloadedmetadata = element.ondurationchange = element.ontimeupdate = element.onerror = null;
      element.removeAttribute("src"); element.load(); URL.revokeObjectURL(url);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(new DOMException("Audio import cancelled", "AbortError"));
    const inspect = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        finish(element.duration > MAX_AUDIO_SECONDS ? new Error("Audio must be at most 10 minutes") : undefined);
      } else if (!seeking && element.readyState >= 1) {
        seeking = true; element.currentTime = Number.MAX_SAFE_INTEGER;
      }
    };
    const timer = setTimeout(() => finish(new Error("Cannot verify audio duration; import a WAV or seekable audio file")), 15000);
    signal?.addEventListener("abort", aborted, { once: true });
    element.preload = "metadata"; element.onloadedmetadata = element.ondurationchange = element.ontimeupdate = inspect;
    element.onerror = () => finish(new Error("Unsupported or damaged audio file")); element.src = url;
  });
}
/** Resample only after the compressed stream passes the duration preflight. */
export async function normalizeAudio(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  if (!blob.size || blob.size > 25 * 1024 * 1024) throw new Error("Audio import supports files up to 25 MiB and 10 minutes");
  signal?.throwIfAborted();
  await checkAudioDuration(blob, signal);
  signal?.throwIfAborted();
  const context = new OfflineAudioContext(1, 1, 16000);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  signal?.throwIfAborted();
  if (decoded.duration > MAX_AUDIO_SECONDS || decoded.numberOfChannels > 8 || decoded.sampleRate !== 16000) throw new Error("Audio must be at most 10 minutes and eight channels");
  const samples = decoded.length; const wav = new ArrayBuffer(44 + samples * 2); const view = new DataView(wav);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, samples * 2, true);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  for (let i = 0; i < samples; i++) { let sum = 0; for (const channel of channels) sum += channel[i] ?? 0; const value = Math.max(-1, Math.min(1, sum / channels.length)); view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true); }
  return new Blob([wav], { type: "audio/wav" });
}
