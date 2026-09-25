import type { ArtifactRecord } from "@omp-studio/studio-protocol";
export const MEDIA_UPLOAD_CHANNELS = { begin: "omp-studio:desktop:media-upload-begin", chunk: "omp-studio:desktop:media-upload-chunk", finish: "omp-studio:desktop:media-upload-finish", abort: "omp-studio:desktop:media-upload-abort" } as const;
export interface MediaUploadInput { kind: "image" | "video" | "audio"; name: string; mimeType: string; workspaceId?: string; sessionId?: string }
export type MediaUploadResult = { ok: true; uploadId?: string; artifact?: ArtifactRecord } | { ok: false; message: string };
