/**
 * Live session only: the Host snapshot describes at most one resident
 * session. History rows without a matching session id stay honest-empty.
 */
export function threadRunningFromLive(input: {
  readonly sessionId?: string;
  readonly snapshotSessionId?: string;
  readonly streaming?: boolean;
  readonly compacting?: boolean;
}): boolean {
  const { sessionId, snapshotSessionId, streaming, compacting } = input;
  if (sessionId === undefined || snapshotSessionId === undefined) return false;
  if (sessionId !== snapshotSessionId) return false;
  return streaming === true || compacting === true;
}
