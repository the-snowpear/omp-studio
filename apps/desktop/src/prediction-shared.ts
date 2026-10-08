import type {
  PredictionChannel,
  PredictionEvent,
  PredictionInput,
} from "@omp-studio/studio-protocol";
export const PREDICTION_CHANNELS = {
  attach: "omp-studio:desktop:prediction-attach",
  input: "omp-studio:desktop:prediction-input",
  detach: "omp-studio:desktop:prediction-detach",
  import: "omp-studio:desktop:prediction-import",
  event: "omp-studio:desktop:prediction-event",
} as const;
export interface PredictionResult {
  ok: boolean;
  cancelled?: boolean;
  message?: string;
  count?: number;
  truncated?: boolean;
}
export type PredictionAttach = PredictionChannel;
export type PredictionControl = {
  channelId: string;
  input: Exclude<PredictionInput, { kind: "import" }>;
};
export type { PredictionEvent };
