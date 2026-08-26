import type { ResidentsReadModel, ResidentSessionRow } from "@omp-studio/client-contract";

export type ResidentRows = ReadonlyArray<ResidentSessionRow> | ResidentsReadModel | null | undefined;

export function residentRowsOf(residents: ResidentRows): ReadonlyArray<ResidentSessionRow> | undefined {
  if (residents === undefined || residents === null) return undefined;
  return "residents" in residents ? residents.residents : residents;
}

export function residentForSession(
  residents: ResidentRows,
  sessionId: string | undefined,
): ResidentSessionRow | undefined {
  if (sessionId === undefined) return undefined;
  return residentRowsOf(residents)?.find((resident) => resident.sessionId === sessionId);
}

export function residentIsRunning(resident: ResidentSessionRow | undefined): boolean {
  return resident?.phase === "running" || resident?.phase === "compacting";
}

/**
 * Live session only: the Host snapshot describes at most one resident
 * session. When the authority-level resident list is available, it is the
 * source of truth for every resident worker. History rows without a matching
 * session id stay honest-empty.
 */
export function threadRunningFromLive(input: {
  readonly sessionId?: string;
  readonly snapshotSessionId?: string;
  readonly streaming?: boolean;
  readonly compacting?: boolean;
  readonly resident?: ResidentSessionRow;
  readonly residents?: ResidentRows;
}): boolean {
  const { sessionId, snapshotSessionId, streaming, compacting, resident, residents } = input;
  if (resident !== undefined || residents !== undefined) {
    return residentIsRunning(resident ?? residentForSession(residents, sessionId));
  }
  if (sessionId === undefined || snapshotSessionId === undefined) return false;
  if (sessionId !== snapshotSessionId) return false;
  return streaming === true || compacting === true;
}
