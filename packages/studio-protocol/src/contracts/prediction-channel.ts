export type PredictionMethod = "off" | "auto" | "ngram" | "smollm" | "apple";
export interface PredictionSettings {
  method: PredictionMethod;
  effective: "off" | "ngram" | "smollm" | "apple";
  source: string;
  download: {
    state: "idle" | "downloading" | "ready" | "failed" | "cancelled";
    bytes: number;
    total: number;
    error?: string;
  };
}
export interface PredictionChannel {
  protocolVersion?: 2;
  channelId: string;
  sessionId: string;
  expiresAt: number;
}
export type PredictionChannelOperation =
  | { kind: "prediction.status"; sessionId: string }
  | {
      kind: "prediction.configure";
      sessionId: string;
      method: PredictionMethod;
      scope: "session" | "global";
    }
  | { kind: "prediction.clearOverride"; sessionId: string }
  | { kind: "prediction.download.cancel"; sessionId: string }
  | { kind: "prediction.prepare"; sessionId: string; protocolVersion?: 2 }
  | { kind: "prediction.release"; sessionId: string; channelId: string };
export interface PredictionResultMap {
  "prediction.status": PredictionSettings;
  "prediction.configure": PredictionSettings;
  "prediction.clearOverride": PredictionSettings;
  "prediction.download.cancel": PredictionSettings;
  "prediction.prepare": PredictionChannel;
  "prediction.release": { released: true };
}
export const PREDICTION_KINDS = [
  "prediction.status",
  "prediction.configure",
  "prediction.clearOverride",
  "prediction.download.cancel",
  "prediction.prepare",
  "prediction.release",
] as const;
export function isPredictionKind(
  kind: string,
): kind is PredictionChannelOperation["kind"] {
  return (PREDICTION_KINDS as readonly string[]).includes(kind);
}
export type PredictionInput =
  | { kind: "next"; revision: number; empty: boolean; text?: string }
  | { kind: "next.shown"; revision: number }
  | { kind: "next.accepted"; revision: number; rank: number }
  | { kind: "update"; revision: number; text: string; caret: number }
  | { kind: "feedback"; revision: number; accepted: boolean }
  | { kind: "ping" }
  | { kind: "import"; requestId: string; transferId: string };
export type PredictionEvent =
  | { kind: "next"; channelId: string; revision: number; suffix: string | null; choices?: readonly string[]; rank?: number }
  | {
      kind: "suggestion";
      channelId: string;
      revision: number;
      suffix: string | null;
    }
  | { kind: "error"; channelId: string; message: string; requestId?: string }
  | { kind: "closed"; channelId: string }
  | {
      kind: "imported";
      channelId: string;
      requestId: string;
      count: number;
      truncated: boolean;
    };
