export interface StudioComputerTarget { id: string; kind: "display" | "window"; name: string; width: number; height: number; }
export interface StudioComputerStatus { enabled: boolean; available: boolean; backend: string; capturePermission: string; inputPermission: string; axPermission: string; running: number; targets: StudioComputerTarget[]; reason?: string; }
export interface StudioComputerCapture { captureId: string; sessionId: string; targetId: string; width: number; height: number; expiresAt: number; }
export type ComputerObservationOperation =
  | { kind: "computer.status"; sessionId: string }
  | { kind: "computer.configure"; sessionId: string; enabled: boolean }
  | { kind: "computer.capture"; sessionId: string; targetId: string }
  | { kind: "computer.stop"; sessionId: string }
  | { kind: "computer.observe.release"; sessionId: string };
export interface ComputerObservationResultMap {
  "computer.status": StudioComputerStatus;
  "computer.configure": { enabled: boolean };
  "computer.capture": StudioComputerCapture;
  "computer.stop": { stopped: true };
  "computer.observe.release": { released: true };
}
export const COMPUTER_OBSERVATION_KINDS = ["computer.status", "computer.configure", "computer.capture", "computer.stop", "computer.observe.release"] as const;
export function isComputerObservationKind(kind: string): kind is ComputerObservationOperation["kind"] { return (COMPUTER_OBSERVATION_KINDS as readonly string[]).includes(kind); }
