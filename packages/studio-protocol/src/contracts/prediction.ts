/** Ephemeral query: never add this payload to a command ledger or telemetry. */
export interface PredictionQuery { sessionId: string; version: number; before: string; prefix: string }
export interface PredictionResult { version: number; suffix: string | null; engine: "ngram" | "smollm" | "off"; unavailable?: string }
export type PredictionControlAction = "status" | "clear" | "import" | "download" | "cancel";
export interface PredictionControlState { corpusCount:number; modelReady:boolean; download:{state:"idle"|"running"|"completed"|"cancelled"|"failed";loaded:number;total:number;error?:string} }
export type PredictionOperation = PredictionQuery & { kind: "prediction.query" };
export function validatePredictionQuery(value:unknown):asserts value is PredictionQuery {
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid prediction query");const v=value as Record<string,unknown>;
 if(Object.keys(v).some(key=>!["sessionId","version","before","prefix"].includes(key)))throw Error("Unknown prediction field");
 if(typeof v.sessionId!=="string"||!v.sessionId||v.sessionId.length>512||!Number.isSafeInteger(v.version)||(v.version as number)<0)throw Error("Invalid prediction identity");
 for(const [key,max] of [["before",8192],["prefix",256]] as const)if(typeof v[key]!=="string"||v[key].length>max||v[key].includes("\0"))throw Error("Invalid prediction text");
}
export function validatePredictionResult(value:unknown):asserts value is PredictionResult {
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid prediction result");const v=value as Record<string,unknown>;
 if(Object.keys(v).some(key=>!["version","suffix","engine","unavailable"].includes(key))||!Number.isSafeInteger(v.version)||(v.version as number)<0||!["off","ngram","smollm"].includes(v.engine as string))throw Error("Invalid prediction result");
 if(v.suffix!==null&&(typeof v.suffix!=="string"||v.suffix.length>256||/[\r\n\0]/.test(v.suffix)))throw Error("Invalid prediction suffix");
 if(v.unavailable!==undefined&&(typeof v.unavailable!=="string"||v.unavailable.length>512))throw Error("Invalid prediction availability");
}
