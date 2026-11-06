export const FLOAT_WINDOW_CHANNELS = {
  prepare: "omp-studio:float:prepare",
  control: "omp-studio:float:control",
  changed: "omp-studio:float:changed",
} as const;
export type FloatWindowRect = { x: number; y: number; width: number; height: number };
export type FloatWindowPrepare = { id: string; title: string; topmost: boolean; minWidth?: number; minHeight?: number; rect?: FloatWindowRect; sourceRect?: FloatWindowRect; minimized: boolean; maximized: boolean };
export type FloatWindowTicket = { key: string; url: string };
export type FloatWindowControl = { key: string; action: "ready" | "focus" | "minimize" | "maximize" | "close" | "topmost" | "showMain"; topmost?: boolean };
export type FloatWindowEvent = { key: string; id: string } & (
  | { kind: "close-request" }
  | { kind: "closed" }
  | { kind: "state"; rect: FloatWindowRect; minimized: boolean; maximized: boolean; visible: boolean }
);
