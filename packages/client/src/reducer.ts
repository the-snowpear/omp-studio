/**
 * Pure client state and reducer (FRONTEND_INTEGRATION.md §8.3, §11).
 *
 * State is split into four top-level areas:
 *   - connection: authority/runtime identity, epochs, state version, event
 *     cursor, resync flag (rebuilt from bootstrap and events);
 *   - entities: the authoritative operator snapshot (rebuilt from bootstrap
 *     and snapshot events);
 *   - commands: the local_pending -> accepted -> interaction_required ->
 *     terminal lifecycle, keyed by requestId;
 *   - ui: Renderer-owned; the reducer never reads or writes it.
 *
 * §8.3 invariants implemented here:
 *   1. bootstrap establishes authority/runtime epoch, stateVersion, cursor
 *      and the initial snapshot;
 *   2. duplicate cursors are idempotent (the reducer returns the same state
 *      reference when nothing changed);
 *   3. stale authority/runtime epochs are ignored;
 *   4. cursor gaps force `resync_required`; the gapped event's payload is
 *      dropped and the cursor does not advance;
 *   5. while resync is required, sensitive mutations
 *      (runtime.install / session.drop / interaction.respond) reduce to a
 *      failed entry with RESYNC_REQUIRED;
 *   6. snapshot events clear resync only on matching authority and
 *      non-regressing version;
 *   7. command accepted/interaction/terminal transitions never regress or
 *      duplicate; terminal states are final;
 *   8. runtime epoch changes (or runtime loss) mark in-flight commands
 *      outcome_unknown, which is terminal and never retried automatically.
 */

import type {
  AuthorityEpoch,
  AuthorityId,
  ClientBootstrap,
  ClientCommandAccepted,
  ClientError,
  ClientEvent,
  ClientSelection,
  CommandName,
  CommandRequestId,
  CommandState,
  EventCursor,
  IdempotencyKey,
  RuntimeConnection,
  RuntimeEpoch,
  StateVersion,
  SurfaceCapabilities,
} from "@omp-studio/client-contract";
import type { CapabilityManifest, OperatorStateSnapshot } from "@omp-studio/studio-protocol";

/** Renderer-owned area; the client reducer never reads or writes it. */
export type ClientUiState = Readonly<Record<string, unknown>>;

export interface ClientConnectionState {
  readonly phase: "initial" | "bootstrapped" | "closed";
  readonly authorityId: AuthorityId | null;
  readonly authorityEpoch: AuthorityEpoch | null;
  readonly runtime: RuntimeConnection | null;
  /** Runtime epoch tracked independently of the display connection. */
  readonly runtimeEpoch: RuntimeEpoch | null;
  readonly stateVersion: StateVersion | null;
  readonly cursor: EventCursor | null;
  readonly resyncRequired: boolean;
  readonly resyncReason: string | null;
  readonly surface: SurfaceCapabilities | null;
  readonly capabilityManifest: CapabilityManifest | null;
  readonly commandManifestHash: string | null;
  readonly selected: ClientSelection | null;
  readonly contractVersion: number | null;
}

export interface ClientEntitiesState {
  readonly snapshot: OperatorStateSnapshot | null;
}

export interface ClientState {
  readonly connection: ClientConnectionState;
  readonly entities: ClientEntitiesState;
  readonly commands: Readonly<Record<CommandRequestId, CommandState>>;
  readonly ui: ClientUiState;
}

export type ClientAction =
  | {
      readonly type: "bootstrap.set";
      readonly bootstrap: ClientBootstrap;
      /** Client-side observation time for outcome_unknown re-bootstrap marks. */
      readonly occurredAt: string;
    }
  | { readonly type: "event"; readonly event: ClientEvent }
  | {
      readonly type: "command.issue";
      readonly requestId: CommandRequestId;
      readonly commandName: CommandName;
      readonly idempotencyKey: IdempotencyKey;
      readonly issuedAt: string;
    }
  | {
      readonly type: "command.transportFailed";
      readonly requestId: CommandRequestId;
      readonly error: ClientError;
      readonly occurredAt: string;
    }
  | { readonly type: "close" };

const EMPTY_UI: ClientUiState = Object.freeze({});

export function createInitialClientState(ui: ClientUiState = EMPTY_UI): ClientState {
  return {
    connection: {
      phase: "initial",
      authorityId: null,
      authorityEpoch: null,
      runtime: null,
      runtimeEpoch: null,
      stateVersion: null,
      cursor: null,
      resyncRequired: false,
      resyncReason: null,
      surface: null,
      capabilityManifest: null,
      commandManifestHash: null,
      selected: null,
      contractVersion: null,
    },
    entities: { snapshot: null },
    commands: {},
    ui,
  };
}

/** Mutations with external side effects; blocked while resync is required. */
const SENSITIVE_COMMANDS: Readonly<Record<CommandName, true>> = {
  "runtime.install": true,
  "session.resume": true,
  "session.drop": true,
  "interaction.respond": true,
};

export function isSensitiveCommand(name: CommandName): boolean {
  return SENSITIVE_COMMANDS[name] === true;
}

export const RESYNC_REQUIRED_ERROR: ClientError = Object.freeze({
  code: "RESYNC_REQUIRED",
  message: "resync required; sensitive mutations are blocked until a fresh snapshot is received",
});

const TERMINAL_STATUSES: Readonly<Partial<Record<CommandState["status"], true>>> = {
  completed: true,
  failed: true,
  rejected: true,
  outcome_unknown: true,
};

function isTerminal(status: CommandState["status"]): boolean {
  return TERMINAL_STATUSES[status] === true;
}

/**
 * Cursor semantics are deterministic:
 * - canonical decimal cursors ("0", "1", "42", no leading zeros) compare as
 *   expected successor (last + 1);
 * - opaque cursors only support equality; any different cursor is
 *   unverifiable and counts as a gap.
 */
const CANONICAL_DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

function parseNumericCursor(cursor: EventCursor): number | null {
  return CANONICAL_DECIMAL_RE.test(cursor) ? Number(cursor) : null;
}

type CursorRelation = "duplicate" | "next" | "gap" | "behind";

function cursorRelation(last: EventCursor, current: EventCursor): CursorRelation {
  if (current === last) {
    return "duplicate";
  }
  const lastNum = parseNumericCursor(last);
  const currentNum = parseNumericCursor(current);
  if (lastNum === null || currentNum === null) {
    return "gap";
  }
  if (currentNum === lastNum + 1) {
    return "next";
  }
  if (currentNum > lastNum + 1) {
    return "gap";
  }
  return "behind";
}

/** Advance cursor and state version (monotonic, never regresses) for a stream-valid event. */
function advanceConnection(connection: ClientConnectionState, event: ClientEvent): ClientConnectionState {
  const current = connection.stateVersion;
  return {
    ...connection,
    cursor: event.cursor,
    stateVersion: current === null || event.stateVersion > current ? event.stateVersion : current,
  };
}

/**
 * Mark every non-terminal command outcome_unknown (runtime epoch change,
 * runtime loss, re-bootstrap). Terminal states are never regressed. Returns
 * the same map reference when nothing changed.
 */
function markPendingOutcomeUnknown(
  commands: Readonly<Record<CommandRequestId, CommandState>>,
  reason: string,
  observedAt: string,
): Readonly<Record<CommandRequestId, CommandState>> {
  let changed = false;
  const next: Record<CommandRequestId, CommandState> = {};
  for (const key of Object.keys(commands)) {
    const requestId = key as CommandRequestId;
    const command = commands[requestId];
    if (command === undefined) {
      continue;
    }
    if (isTerminal(command.status)) {
      next[requestId] = command;
    } else {
      next[requestId] = {
        requestId: command.requestId,
        commandName: command.commandName,
        status: "outcome_unknown",
        reason,
        observedAt,
      };
      changed = true;
    }
  }
  return changed ? next : commands;
}

export function reduceClientState(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "bootstrap.set":
      return reduceBootstrap(state, action.bootstrap, action.occurredAt);
    case "event":
      return reduceEvent(state, action.event);
    case "command.issue":
      return reduceCommandIssue(state, action);
    case "command.transportFailed":
      return reduceTransportFailed(state, action);
    case "close":
      return state.connection.phase === "closed"
        ? state
        : { ...state, connection: { ...state.connection, phase: "closed" } };
    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

function reduceBootstrap(state: ClientState, bootstrap: ClientBootstrap, occurredAt: string): ClientState {
  const connection: ClientConnectionState = {
    phase: "bootstrapped",
    authorityId: bootstrap.authority.authorityId,
    authorityEpoch: bootstrap.authority.authorityEpoch,
    runtime: bootstrap.runtime,
    runtimeEpoch: bootstrap.runtime.runtimeEpoch ?? null,
    stateVersion: bootstrap.stateVersion,
    cursor: bootstrap.cursor,
    resyncRequired: false,
    resyncReason: null,
    surface: bootstrap.surface,
    capabilityManifest: bootstrap.capabilityManifest,
    commandManifestHash: bootstrap.commandManifestHash,
    selected: bootstrap.selected,
    contractVersion: bootstrap.contractVersion,
  };
  // In-flight commands from a previous bootstrap cannot be reconciled
  // against the fresh snapshot; they become outcome_unknown, never retried.
  const commands = markPendingOutcomeUnknown(state.commands, "client re-bootstrapped; outcome unknown", occurredAt);
  return { ...state, connection, entities: { snapshot: bootstrap.snapshot }, commands };
}

function reduceEvent(state: ClientState, event: ClientEvent): ClientState {
  // 1) Authority epoch: stale events are ignored; a newer epoch invalidates
  //    all prior state (authority epochs are monotonic generations).
  const authorityEpoch = state.connection.authorityEpoch;
  if (authorityEpoch !== null) {
    if (event.authorityEpoch < authorityEpoch) {
      return state;
    }
    if (event.authorityEpoch > authorityEpoch) {
      state = resetForNewAuthority(state, event);
    }
  } else {
    state = { ...state, connection: { ...state.connection, authorityEpoch: event.authorityEpoch } };
  }

  // 2) Runtime epoch filtering for events whose epoch comes from the
  //    envelope or a snapshot. `runtime.changed` carries its own connection
  //    and is handled entirely in reduceRuntimeChanged.
  const eventRuntimeEpoch = event.kind === "runtime.changed" ? undefined : runtimeEpochOf(event);
  if (eventRuntimeEpoch !== undefined) {
    const runtimeEpoch = state.connection.runtimeEpoch;
    if (runtimeEpoch !== null) {
      if (eventRuntimeEpoch < runtimeEpoch) {
        return state;
      }
      if (eventRuntimeEpoch > runtimeEpoch) {
        state = {
          ...state,
          connection: { ...state.connection, runtimeEpoch: eventRuntimeEpoch },
          commands: markPendingOutcomeUnknown(state.commands, "runtime epoch changed; outcome unknown", event.occurredAt),
        };
      }
    } else {
      state = { ...state, connection: { ...state.connection, runtimeEpoch: eventRuntimeEpoch } };
    }
  }

  // 3) Cursor continuity. Duplicates and behind-cursors are idempotent. A
  //    gap forces resync_required; the gapped event's payload is dropped and
  //    the cursor stays put. Snapshot events bypass the gap rule because a
  //    snapshot IS the resync mechanism (it carries its own baseline), but
  //    they still dedupe on their own cursor.
  const cursor = state.connection.cursor;
  if (cursor !== null) {
    const relation = cursorRelation(cursor, event.cursor);
    if (relation === "duplicate" || relation === "behind") {
      return state;
    }
    if (relation === "gap" && event.kind !== "snapshot") {
      if (state.connection.resyncRequired) {
        return state;
      }
      return {
        ...state,
        connection: {
          ...state.connection,
          resyncRequired: true,
          resyncReason: `cursor gap at ${event.cursor}`,
        },
      };
    }
  }

  switch (event.kind) {
    case "snapshot":
      return reduceSnapshot(state, event);
    case "state.changed":
    case "diagnostics.changed":
      return { ...state, connection: advanceConnection(state.connection, event) };
    case "command.accepted":
      return reduceCommandAccepted(state, event);
    case "command.interactionRequired":
      return reduceInteractionRequired(state, event);
    case "command.receipt":
      return reduceCommandReceipt(state, event);
    case "runtime.changed":
      return reduceRuntimeChanged(state, event);
    case "resync.required":
      return {
        ...state,
        connection: {
          ...advanceConnection(state.connection, event),
          resyncRequired: true,
          resyncReason: event.reason,
        },
      };
    default: {
      const _exhaustive: never = event;
      return state;
    }
  }
}

function resetForNewAuthority(state: ClientState, event: ClientEvent): ClientState {
  // A new authority generation invalidates all prior state; the event
  // establishes the new baseline. Snapshot payloads still apply below.
  const fresh = createInitialClientState(state.ui);
  return {
    ...fresh,
    connection: {
      ...fresh.connection,
      phase: state.connection.phase === "closed" ? "closed" : "bootstrapped",
      authorityEpoch: event.authorityEpoch,
    },
  };
}

function runtimeEpochOf(event: ClientEvent): RuntimeEpoch | undefined {
  if (event.kind === "snapshot") {
    return event.snapshot.runtimeEpoch;
  }
  return event.runtimeEpoch;
}

function reduceSnapshot(state: ClientState, event: Extract<ClientEvent, { readonly kind: "snapshot" }>): ClientState {
  const snapshot = event.snapshot;
  // Non-regressing version only; an older snapshot is never applied.
  const currentVersion = state.connection.stateVersion;
  if (currentVersion !== null && snapshot.stateVersion < currentVersion) {
    return state;
  }
  // Duplicate or behind-cursor snapshots are idempotent.
  const cursor = state.connection.cursor;
  if (cursor !== null) {
    const relation = cursorRelation(cursor, event.cursor);
    if (relation === "duplicate" || relation === "behind") {
      return state;
    }
  }
  return {
    ...state,
    connection: {
      ...state.connection,
      runtimeEpoch: snapshot.runtimeEpoch,
      stateVersion: snapshot.stateVersion,
      cursor: event.cursor,
      resyncRequired: false,
      resyncReason: null,
    },
    entities: { snapshot },
  };
}

function reduceCommandAccepted(state: ClientState, event: Extract<ClientEvent, { readonly kind: "command.accepted" }>): ClientState {
  const accepted: ClientCommandAccepted = event.accepted;
  const requestId = accepted.requestId;
  const connection = advanceConnection(state.connection, event);
  const existing = state.commands[requestId];
  if (existing === undefined) {
    // Unknown to this client (e.g. after a reload): record the host-side
    // fact so later receipts can land.
    return {
      ...state,
      connection,
      commands: {
        ...state.commands,
        [requestId]: {
          requestId,
          commandName: accepted.commandName,
          status: "accepted",
          acceptedAt: accepted.acceptedAt,
        },
      },
    };
  }
  if (existing.status === "local_pending") {
    return {
      ...state,
      connection,
      commands: {
        ...state.commands,
        [requestId]: {
          requestId: existing.requestId,
          commandName: existing.commandName,
          status: "accepted",
          acceptedAt: accepted.acceptedAt,
        },
      },
    };
  }
  // Accepted after accepted (duplicate ack), after interaction_required, or
  // after a terminal state (regression): the cursor advances, the payload is
  // a no-op.
  return { ...state, connection };
}

function reduceInteractionRequired(state: ClientState, event: Extract<ClientEvent, { readonly kind: "command.interactionRequired" }>): ClientState {
  const interaction = event.interaction;
  const requestId = interaction.requestId;
  const connection = advanceConnection(state.connection, event);
  const existing = state.commands[requestId];
  if (existing === undefined) {
    // Without a tracked command there is no commandName to attach; the
    // interaction is dropped (deterministic).
    return { ...state, connection };
  }
  if (existing.status === "local_pending" || existing.status === "accepted") {
    return {
      ...state,
      connection,
      commands: {
        ...state.commands,
        [requestId]: {
          requestId: existing.requestId,
          commandName: existing.commandName,
          status: "interaction_required",
          interaction,
        },
      },
    };
  }
  if (existing.status === "interaction_required") {
    if (existing.interaction.interactionId === interaction.interactionId) {
      return { ...state, connection };
    }
    // Host re-issued the prompt with a fresh interaction id.
    return {
      ...state,
      connection,
      commands: {
        ...state.commands,
        [requestId]: {
          requestId: existing.requestId,
          commandName: existing.commandName,
          status: "interaction_required",
          interaction,
        },
      },
    };
  }
  // Terminal: no regression.
  return { ...state, connection };
}

function reduceCommandReceipt(state: ClientState, event: Extract<ClientEvent, { readonly kind: "command.receipt" }>): ClientState {
  const receipt = event.receipt;
  const requestId = receipt.requestId;
  const connection = advanceConnection(state.connection, event);
  const existing = state.commands[requestId];
  if (existing !== undefined && isTerminal(existing.status)) {
    // Terminal is final: no regression (e.g. completed after outcome_unknown)
    // and no duplicate receipt mutation.
    return { ...state, connection };
  }
  return {
    ...state,
    connection,
    commands: { ...state.commands, [requestId]: receipt },
  };
}

function reduceRuntimeChanged(state: ClientState, event: Extract<ClientEvent, { readonly kind: "runtime.changed" }>): ClientState {
  const cursor = state.connection.cursor;
  if (cursor !== null) {
    const relation = cursorRelation(cursor, event.cursor);
    if (relation === "duplicate" || relation === "behind") {
      return state;
    }
    if (relation === "gap") {
      if (state.connection.resyncRequired) {
        return state;
      }
      return {
        ...state,
        connection: {
          ...state.connection,
          resyncRequired: true,
          resyncReason: `cursor gap at ${event.cursor}`,
        },
      };
    }
  }
  const connection = event.connection;
  const nextRuntimeEpoch = connection.runtimeEpoch ?? null;
  const prevRuntimeEpoch = state.connection.runtimeEpoch;
  const wasDisconnected = state.connection.runtime?.status === "disconnected";
  const lost = connection.status === "disconnected" && !wasDisconnected;
  const epochChanged = nextRuntimeEpoch !== prevRuntimeEpoch;
  let commands = state.commands;
  if (epochChanged || lost) {
    commands = markPendingOutcomeUnknown(commands, "runtime changed; outcome unknown", event.occurredAt);
  }
  return {
    ...state,
    connection: {
      ...advanceConnection(state.connection, event),
      runtime: connection,
      runtimeEpoch: nextRuntimeEpoch,
    },
    commands,
  };
}

interface CommandIssueAction {
  readonly type: "command.issue";
  readonly requestId: CommandRequestId;
  readonly commandName: CommandName;
  readonly idempotencyKey: IdempotencyKey;
  readonly issuedAt: string;
}

function reduceCommandIssue(state: ClientState, action: CommandIssueAction): ClientState {
  const blocked = state.connection.resyncRequired && isSensitiveCommand(action.commandName);
  const entry: CommandState = blocked
    ? {
        requestId: action.requestId,
        commandName: action.commandName,
        status: "failed",
        error: RESYNC_REQUIRED_ERROR,
        observedAt: action.issuedAt,
      }
    : {
        requestId: action.requestId,
        commandName: action.commandName,
        status: "local_pending",
        idempotencyKey: action.idempotencyKey,
        issuedAt: action.issuedAt,
      };
  return { ...state, commands: { ...state.commands, [action.requestId]: entry } };
}

interface TransportFailedAction {
  readonly type: "command.transportFailed";
  readonly requestId: CommandRequestId;
  readonly error: ClientError;
  readonly occurredAt: string;
}

function reduceTransportFailed(state: ClientState, action: TransportFailedAction): ClientState {
  const existing = state.commands[action.requestId];
  if (existing === undefined || isTerminal(existing.status)) {
    return state;
  }
  return {
    ...state,
    commands: {
      ...state.commands,
      [action.requestId]: {
        requestId: existing.requestId,
        commandName: existing.commandName,
        status: "failed",
        error: action.error,
        observedAt: action.occurredAt,
      },
    },
  };
}
