export const NATIVE_PREFERENCE_KEYS = [
  "advisor.enabled",
  "advisor.reviewMode",
  "advisor.reviewInterval",
  "advisor.syncBacklog",
  "advisor.immuneTurns",
  "advisor.maxNotesPerUpdate",
  "advisor.evictStaleResults",
  "advisor.continueSeverity",
  "lsp.requestTimeout",
  "sharpshooter.minPromptLength",
  "title.icons",
  "title.generator",
  "title.refreshOnReplan",
  "telemetry.otlpExportEnabled",
] as const;
export type NativePreferenceKey = (typeof NATIVE_PREFERENCE_KEYS)[number];
export type NativePreferenceValue = string | number | boolean;
export interface NativePreference {
  key: NativePreferenceKey;
  group: "advisor" | "tools" | "titles" | "diagnostics";
  label: string;
  description: string;
  value: NativePreferenceValue;
  effective: NativePreferenceValue;
  source: "env" | "default" | "runtime" | "overlay" | "project" | "global";
  type: "boolean" | "number" | "enum";
  choices?: NativePreferenceValue[];
  restartRequired: boolean;
}
export type NativePreferenceOperation =
  | { kind: "preferences.native.get"; sessionId: string }
  | {
      kind: "preferences.native.set";
      sessionId: string;
      key: NativePreferenceKey;
      value: NativePreferenceValue;
      scope: "session" | "global";
    }
  | {
      kind: "preferences.native.clearOverride";
      sessionId: string;
      key: NativePreferenceKey;
    };
export interface NativePreferenceResultMap {
  "preferences.native.get": { preferences: NativePreference[] };
  "preferences.native.set": NativePreference;
  "preferences.native.clearOverride": NativePreference;
}
export const NATIVE_PREFERENCE_KINDS = [
  "preferences.native.get",
  "preferences.native.set",
  "preferences.native.clearOverride",
] as const;
export function isNativePreferenceKind(
  kind: string,
): kind is NativePreferenceOperation["kind"] {
  return (NATIVE_PREFERENCE_KINDS as readonly string[]).includes(kind);
}
