export interface PortableAsset { artifactId: string; kind: "export"; name: string; mimeType: string; bytes: number; sha256: string }
export interface PortableExport { id: string; format: "pack" | "anonymous"; asset: PortableAsset; warnings: string[]; members: number }
export interface SessionImportPreview { token: string; expiresAt: number; sourceSessionId: string; title: string; sourceDirectory: string; destinationDirectory: string; upstreamVersion: string; messages: number; artifacts: number; blobs: number; conflicts: boolean }
export interface SessionPortabilityStatus { phase: "idle" | "preparing" | "exporting" | "importing" | "complete" | "failed"; preview?: SessionImportPreview; exported?: PortableExport; imported?: { sessionId: string; mode: "created" | "forked"; workspaceId?: string; cwd?: string }; error?: string }
export type SessionPortabilityOperation =
  | { kind: "session.portability.pack"; sessionId: string; targetSessionId: string }
  | { kind: "session.portability.anonymize"; sessionId: string; targetSessionId: string }
  | { kind: "session.portability.prepare"; sessionId: string; artifactId: string; targetWorkspaceId?: string; targetCwd?: string; inputTransfers?: Array<{ artifactId: string; transferId: string }> }
  | { kind: "session.portability.import"; sessionId: string; token: string }
  | { kind: "session.portability.cancel"; sessionId: string; token: string }
  | { kind: "session.portability.moved"; sessionId: string; targetSessionId: string; label: string }
  | { kind: "session.portability.status"; sessionId: string };
export interface SessionPortabilityResultMap {
  "session.portability.pack": PortableExport;
  "session.portability.anonymize": PortableExport;
  "session.portability.prepare": SessionImportPreview;
  "session.portability.import": { sessionId: string; mode: "created" | "forked"; workspaceId?: string; cwd?: string };
  "session.portability.cancel": { cancelled: true };
  "session.portability.moved": { marked: true };
  "session.portability.status": SessionPortabilityStatus;
}
export const SESSION_PORTABILITY_KINDS = ["session.portability.pack", "session.portability.anonymize", "session.portability.prepare", "session.portability.import", "session.portability.cancel", "session.portability.moved", "session.portability.status"] as const;
export function isSessionPortabilityKind(kind: string): kind is SessionPortabilityOperation["kind"] { return (SESSION_PORTABILITY_KINDS as readonly string[]).includes(kind); }
