export const COMPUTER_CAPTURE_CHANNEL = "omp-studio:desktop:computer-capture";
export interface ComputerCaptureRequest { captureId: string; sessionId: string; targetId: string }
export type ComputerCaptureResult = { ok: true; data: ArrayBuffer; width: number; height: number } | { ok: false; message: string };
