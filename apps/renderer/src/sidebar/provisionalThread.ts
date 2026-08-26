import type { SessionHistoryEntry, SessionId, WorkspaceId } from "@omp-studio/client-contract";

export const PROVISIONAL_THREAD_TITLE_CODE_POINTS = 20;

/** Renderer-owned title lifecycle; the history contract supplies the value. */
export type SessionTitleState = "missing" | "stable";

export type ProvisionalSessionTitleEnsureSnapshot = {
  readonly sessionId: SessionId;
  readonly sessionTitle?: string;
  readonly sessionTitleSource?: "user" | "auto";
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
};

export type ProvisionalProjectThread = {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly title: string;
  readonly titleState: SessionTitleState;
  readonly running: boolean;
  /** An accepted prompt keeps its fallback title across Workbench switches. */
  readonly submitted: boolean;
};

export type ProvisionalProjectThreadCache = Readonly<Record<string, ProvisionalProjectThread>>;

export function provisionalSessionTitleEnsureKey(sessionId: SessionId): string {
  return String(sessionId);
}

/**
 * The Runtime may only be asked to synthesize a title once the accepted prompt
 * is idle and the live snapshot still represents the same session.  The
 * in-flight input is renderer-only bookkeeping; it prevents concurrent
 * duplicate commands while later authoritative Runtime state may retry.
 */
export function shouldEnsureProvisionalSessionTitle(input: {
  readonly preview: boolean;
  readonly runtimeConnected: boolean;
  readonly provisional: ProvisionalProjectThread | undefined;
  readonly snapshot: ProvisionalSessionTitleEnsureSnapshot | undefined;
  readonly inFlightSessionIds?: ReadonlySet<string>;
}): boolean {
  const thread = input.provisional;
  const snapshot = input.snapshot;
  if (input.preview || !input.runtimeConnected || thread === undefined || snapshot === undefined) return false;
  if (!thread.submitted || thread.titleState !== "missing") return false;
  if (thread.sessionId !== snapshot.sessionId) return false;
  // A title source without the value can be a legacy/native snapshot in the
  // middle of projection; do not race it with an automatic title command.
  if (snapshot.sessionTitle !== undefined || snapshot.sessionTitleSource !== undefined) return false;
  if (snapshot.isStreaming || snapshot.isCompacting) return false;
  const key = provisionalSessionTitleEnsureKey(thread.sessionId);
  if (input.inFlightSessionIds?.has(key) === true) return false;
  return true;
}

export type ProvisionalProjectThreadChange = {
  readonly sessionId?: SessionId;
  readonly workspaceId?: WorkspaceId;
  readonly visible: boolean;
  readonly title?: string;
  readonly running: boolean;
  readonly submitted: boolean;
};

export function buildProvisionalProjectThread(input: {
  readonly preview: boolean;
  readonly sessionCreating: boolean;
  readonly selectedHistoryId: string | null;
  readonly composer: {
    readonly visible: boolean;
    readonly title?: string;
    readonly running: boolean;
    readonly submitted: boolean;
  };
  readonly sessionId: SessionId | undefined;
  readonly workspaceId: WorkspaceId | undefined;
  readonly untitledTitle: string;
}): ProvisionalProjectThread | undefined {
  if (
    input.preview
    || input.sessionCreating
    || input.selectedHistoryId !== null
    || !input.composer.visible
    || input.sessionId === undefined
    || input.workspaceId === undefined
  ) {
    return undefined;
  }
  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    title: input.composer.title ?? input.untitledTitle,
    titleState: "missing",
    running: input.composer.running,
    submitted: input.composer.submitted,
  };
}

export function reconcileProvisionalProjectThread(
  current: ProvisionalProjectThreadCache,
  change: ProvisionalProjectThreadChange,
  context: {
    readonly preview: boolean;
    readonly sessionCreating: boolean;
    readonly selectedHistoryId: string | null;
    readonly untitledTitle: string;
    readonly excludedSessionIds?: ReadonlySet<string>;
  },
): ProvisionalProjectThreadCache {
  if (change.sessionId === undefined) return current;
  const key = String(change.sessionId);
  const removeCurrent = (): ProvisionalProjectThreadCache => {
    if (current[key] === undefined) return current;
    const next = { ...current };
    delete next[key];
    return next;
  };
  if (context.excludedSessionIds?.has(key) === true) return removeCurrent();
  if (!change.visible && current[key]?.submitted === true) return current;
  // Selecting a persisted history row briefly clears the Workbench-local
  // composer while Runtime selection catches up. Keep the provisional row so
  // its session-scoped draft can be selected and restored later.
  if (context.selectedHistoryId !== null) return current;
  if (!change.visible) return removeCurrent();
  const nextThread = buildProvisionalProjectThread({
    preview: context.preview,
    sessionCreating: context.sessionCreating,
    selectedHistoryId: context.selectedHistoryId,
    composer: change,
    sessionId: change.sessionId,
    workspaceId: change.workspaceId,
    untitledTitle: context.untitledTitle,
  });
  if (nextThread === undefined) return current;
  const previous = current[key];
  const nextWithTitleState = previous !== undefined
    && previous.workspaceId === nextThread.workspaceId
    && previous.sessionId === nextThread.sessionId
    ? {
      ...nextThread,
      ...(previous.titleState === "stable" ? { title: previous.title } : {}),
      titleState: previous.titleState,
    }
    : nextThread;
  if (
    previous !== undefined
    && previous.workspaceId === nextWithTitleState.workspaceId
    && previous.title === nextWithTitleState.title
    && previous.titleState === nextWithTitleState.titleState
    && previous.running === nextWithTitleState.running
    && previous.submitted === nextWithTitleState.submitted
  ) {
    return current;
  }
  return { ...current, [key]: nextWithTitleState };
}

/** Prompt-derived display fallback only. It never becomes Runtime sessionName,
 * so the existing LLM title generator remains the sole title authority. */
export function provisionalThreadTitle(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).slice(0, PROVISIONAL_THREAD_TITLE_CODE_POINTS).join("");
}

export function projectHasSession(
  entries: ReadonlyArray<SessionHistoryEntry>,
  sessionId: SessionId,
): boolean {
  return entries.some((entry) => entry.sessionId === sessionId);
}

/** A session title follows the session identity even while workspace selection
 * and history refreshes are temporarily out of sync. */
export function provisionalThreadForHistoryEntry(
  threads: ReadonlyArray<ProvisionalProjectThread>,
  entry: SessionHistoryEntry,
): ProvisionalProjectThread | undefined {
  if (entry.sessionId === undefined) return undefined;
  return threads.find((thread) => thread.sessionId === entry.sessionId);
}

/** Host uses its current value until OMP reports a stable title. */
export function resolveProvisionalHistoryTitle(
  thread: ProvisionalProjectThread,
  title: string,
): ProvisionalProjectThread {
  return { ...thread, title, titleState: "stable" };
}

export function sidebarThreadTitle(
  entry: SessionHistoryEntry,
  provisional: ProvisionalProjectThread | undefined,
  untitledTitle = "",
): string {
  if (
    provisional !== undefined
    && entry.sessionId === provisional.sessionId
    && entry.title === undefined
  ) {
    return provisional.title;
  }
  return entry.title ?? untitledTitle;
}
