export interface SessionTitleCard {
  code: string;
  emoji?: string;
  nf?: string;
}
export interface SessionTitleRow {
  sessionId: string;
  state: "available" | "missing" | "unavailable";
  title?: string;
  source?: "auto" | "user";
  card?: SessionTitleCard;
  reason?: string;
}
export interface SessionTitlesResult {
  rows: SessionTitleRow[];
}
export type SessionTitlesOperation = {
  kind: "session.titles.inspect";
  sessionId: string;
  targetSessionIds: string[];
};
export interface SessionTitlesResultMap {
  "session.titles.inspect": SessionTitlesResult;
}
export const SESSION_TITLES_KINDS = ["session.titles.inspect"] as const;
export function isSessionTitlesKind(
  kind: string,
): kind is SessionTitlesOperation["kind"] {
  return kind === "session.titles.inspect";
}
