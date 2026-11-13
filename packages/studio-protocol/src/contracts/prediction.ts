/** Ephemeral query: never add this payload to a command ledger or telemetry. */
export interface PredictionQuery { sessionId: string; version: number; before: string; prefix: string }
export interface PredictionResult { version: number; suffix: string | null; engine: "ngram" | "smollm" | "off"; unavailable?: string }
export type PredictionControlAction = "status" | "clear" | "import" | "download" | "cancel";
export interface PredictionControlState { corpusCount:number; modelReady:boolean; download:{state:"idle"|"running"|"completed"|"cancelled"|"failed";loaded:number;total:number;error?:string} }
export type PredictionOperation = PredictionQuery & { kind: "prediction.query" };
