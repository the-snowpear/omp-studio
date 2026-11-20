import type { SessionHistoryEntry, SessionId, WorkspaceId } from "@omp-studio/client-contract";

export const PROVISIONAL_THREAD_TITLE_CODE_POINTS = 20;

const DEFAULT_SESSION_TITLES = new Set(["未命名会话", "untitled session"]);

/** Runtime/catalog placeholders are not authoritative auto-generated titles. */
export function isPlaceholderSessionTitle(title: string | undefined): boolean {
  const normalized = title?.replace(/\s+/gu, " ").trim();
  if (normalized === undefined || normalized.length === 0) return true;
  return DEFAULT_SESSION_TITLES.has(normalized.toLocaleLowerCase());
}

/** Renderer-owned title lifecycle; the history contract supplies the value. */
export type SessionTitleState = "missing" | "stable";

export type ProvisionalProjectThread = {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly title: string;
  readonly titleState: SessionTitleState;
  readonly running: boolean;
  /** An accepted prompt keeps its fallback title across Workbench switches. */
  readonly submitted: boolean;
  /** Set once a ready history.list for this workspace has observed sessionId. */
  readonly persistedSeen?: boolean;
};

export type ProvisionalProjectThreadCache = Readonly<Record<string, ProvisionalProjectThread>>;

export class ProvisionalThreadStore {
  cache: ProvisionalProjectThreadCache = {};
  excludedSessionIds: ReadonlySet<string> = new Set();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.cache;
  setCache = (
    action:
      | ProvisionalProjectThreadCache
      | ((previous: ProvisionalProjectThreadCache) => ProvisionalProjectThreadCache),
  ) => {
    const next = typeof action === "function" ? action(this.cache) : action;
    if (next === this.cache) return;
    this.cache = next;
    for (const listener of this.listeners) listener();
  };
  exclude(sessionId: string): void {
    if (this.excludedSessionIds.has(sessionId)) return;
    this.excludedSessionIds = new Set([...this.excludedSessionIds, sessionId]);
  }
  unexclude(sessionId: string): void {
    if (!this.excludedSessionIds.has(sessionId)) return;
    const next = new Set(this.excludedSessionIds);
    next.delete(sessionId);
    this.excludedSessionIds = next;
  }
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
  readonly selectedTitleIsPlaceholder?: boolean | undefined;
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
  const allowSelectedUntitledSubmit =
    input.selectedHistoryId !== null
    && input.selectedTitleIsPlaceholder === true
    && input.composer.submitted
    && !isPlaceholderSessionTitle(input.composer.title);
  if (
    input.preview
    || input.sessionCreating
    || (input.selectedHistoryId !== null && !allowSelectedUntitledSubmit)
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
    readonly selectedTitleIsPlaceholder?: boolean | undefined;
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
  // its session-scoped draft can be selected and restored later; only allow
  // updates when a prompt is actively submitted for an untitled history row
  // or for an already-tracked provisional session.
  const canUpdateSelected =
    context.selectedHistoryId === null
    || (context.selectedTitleIsPlaceholder === true && (change.submitted || current[key] !== undefined));
  if (!canUpdateSelected) return current;
  if (!change.visible) return context.selectedHistoryId !== null ? current : removeCurrent();
  const nextThread = buildProvisionalProjectThread({
    preview: context.preview,
    sessionCreating: context.sessionCreating,
    selectedHistoryId: current[key] !== undefined ? null : context.selectedHistoryId,
    selectedTitleIsPlaceholder: context.selectedTitleIsPlaceholder,
    composer: change,
    sessionId: change.sessionId,
    // The session decides its own workspace. During a project switch the shell
    // already reports the incoming project while `composerOwner` still names the
    // session just left, so a re-emitted report must not move the row.
    workspaceId: current[key]?.workspaceId ?? change.workspaceId,
    untitledTitle: context.untitledTitle,
  });
  if (nextThread === undefined) return current;
  const previous = current[key];
  const sameSession = previous !== undefined
    && previous.workspaceId === nextThread.workspaceId
    && previous.sessionId === nextThread.sessionId;
  const freezePreviousPromptTitle = sameSession
    && previous.titleState === "missing"
    && !isPlaceholderSessionTitle(previous.title)
    && (previous.submitted || nextThread.submitted);
  const nextWithTitleState = sameSession
    ? {
      ...nextThread,
      ...(previous.titleState === "stable" || freezePreviousPromptTitle ? { title: previous.title } : {}),
      titleState: previous.titleState,
      submitted: previous.submitted || nextThread.submitted,
      ...(previous.persistedSeen ? { persistedSeen: true } : {}),
    }
    : nextThread;
  if (
    previous !== undefined
    && previous.workspaceId === nextWithTitleState.workspaceId
    && previous.title === nextWithTitleState.title
    && previous.titleState === nextWithTitleState.titleState
    && previous.running === nextWithTitleState.running
    && previous.submitted === nextWithTitleState.submitted
    && previous.persistedSeen === nextWithTitleState.persistedSeen
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
  liveTitle?: string | undefined,
): string {
  const trimmedLive = liveTitle?.trim();
  if (trimmedLive && !isPlaceholderSessionTitle(trimmedLive)) {
    return trimmedLive;
  }
  if (!isPlaceholderSessionTitle(entry.title)) {
    return entry.title!;
  }
  if (
    provisional !== undefined
    && entry.sessionId === provisional.sessionId
    && !isPlaceholderSessionTitle(provisional.title)
  ) {
    return provisional.title;
  }
  if (provisional !== undefined && entry.sessionId === provisional.sessionId) {
    return provisional.title;
  }
  return entry.title ?? untitledTitle;
}
