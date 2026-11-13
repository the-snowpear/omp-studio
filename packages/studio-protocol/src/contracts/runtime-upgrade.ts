import type { BtwInjection } from "./btw.js";
export interface BtwImage { type: "image"; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml"; data: string }
/** Typed capabilities added with the OMP 18.2 migration. Kept wire-only. */
export type ForeignSource = "claude" | "codex";
export type RuntimeAuthProvider = "typesafe" | "exa" | "ollama-cloud";
export type UpgradeOperation =
 | { kind: "btw.history.list" }
 | { kind: "btw.images.resolve"; text: string }
 | { kind: "btw.history.read"; topicId: string }
 | { kind: "btw.followUp"; topicId: string; question: string; images?: BtwImage[] }
 | { kind: "session.models.mentions" }
 | { kind: "session.import.list"; source: ForeignSource }
 | { kind: "session.import.preview"; source: ForeignSource; sourceId: string }
 | { kind: "session.import.execute"; source: ForeignSource; sourceId: string; fallbackCwd?: string; fallbackWorkspaceId?: string }
 | { kind: "runtime.auth.get"; provider: RuntimeAuthProvider }
 | { kind: "runtime.auth.set"; provider: RuntimeAuthProvider; apiKey: string }
 | { kind: "runtime.auth.remove"; provider: RuntimeAuthProvider };
export const UPGRADE_OPERATION_KINDS = [
 "btw.history.list", "btw.history.read", "btw.followUp", "btw.images.resolve", "session.models.mentions",
 "session.import.list", "session.import.preview", "session.import.execute",
 "runtime.auth.get", "runtime.auth.set", "runtime.auth.remove",
] as const;
export function isUpgradeOperationKind(kind: string): kind is UpgradeOperation["kind"] {
 return (UPGRADE_OPERATION_KINDS as readonly string[]).includes(kind);
}
export interface BtwHistoryTurn {
  injection?: BtwInjection;
 images?: readonly BtwImage[];
 question: string; answer: string; status: "running" | "complete" | "cancelled" | "error" | "interrupted";
 createdAt: number; updatedAt: number; error?: string;
}
export interface BtwTopicSummary {
 topicId: string; question: string; title?: string; status: BtwHistoryTurn["status"]; updatedAt: number; turnCount: number;
}
export interface ForeignSessionSummary {
 source: ForeignSource; sourceId: string; title: string; directoryName: string; cwdExists: boolean;
 modifiedAt: string; messageCount?: number; firstMessage?: string;
}
export interface ModelMentionInfo { agent: string; selector: string; name: string; thinkingLevel?: string }
export interface UpgradeResultMap {
 "btw.images.resolve": { images: BtwImage[] };
 "btw.history.list": { sessionId: string; topics: BtwTopicSummary[] };
 "btw.history.read": { sessionId: string; topicId: string; turns: BtwHistoryTurn[] };
 "btw.followUp": { ephemeralId: string; status: "running" };
 "session.models.mentions": { sessionId: string; mentions: ModelMentionInfo[]; available: Array<{ selector: string; name: string; image: boolean; efforts?: Array<{ selector: string; name: string }> }>; activeModelImage: boolean };
 "session.import.list": { sessions: ForeignSessionSummary[] };
 "session.import.preview": { session: ForeignSessionSummary; preview: string };
 "session.import.execute": { imported: true; sessionId: string; workspaceId: string };
 "runtime.auth.get": { provider: RuntimeAuthProvider; configured: boolean; lastJudgment?: { purpose: string; provider: string; model: string } };
 "runtime.auth.set": { provider: RuntimeAuthProvider; configured: boolean; lastJudgment?: { purpose: string; provider: string; model: string } };
 "runtime.auth.remove": { provider: RuntimeAuthProvider; configured: boolean; lastJudgment?: { purpose: string; provider: string; model: string } };
}
