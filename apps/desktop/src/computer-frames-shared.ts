export const COMPUTER_FRAME_CHANNELS = {
  read: "omp-studio:desktop:computer-frame-read",
  save: "omp-studio:desktop:computer-frame-save",
} as const;

/** A frame belongs to a local Runtime scope, never to the currently focused tab implicitly. */
export interface ComputerFrameRequest {
  scopeSessionId: string;
  frameId: string;
  origin: "local";
}

export type ComputerFrameReadResult =
  | { ok: true; data: ArrayBuffer; width: number; height: number; mimeType: "image/png"; artifactId?: string }
  | { ok: false; message: string };
export type ComputerFrameSaveResult =
  | { ok: true; artifactId: string }
  | { ok: false; message: string };
