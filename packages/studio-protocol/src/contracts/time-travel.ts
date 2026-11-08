export interface TimeTravelCaptureRequest {
  readonly type: "timeTravel.capture.request";
  readonly requestId: string;
  readonly runtimeEpoch: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly leafId: string | null;
  readonly phase: "before" | "after";
}

export interface TimeTravelCaptureResult {
  readonly type: "timeTravel.capture.result";
  readonly requestId: string;
  readonly runtimeEpoch: number;
  readonly error?: string;
}
