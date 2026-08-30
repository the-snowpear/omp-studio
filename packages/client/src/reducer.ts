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
 *      and the initial snapshot; an unavailable bootstrap (Runtime without
 *      a snapshot) still establishes authority, surface and manifests but
 *      keeps stateVersion/cursor null and entities.snapshot null until a
 *      snapshot event arrives;
 *   2. duplicate cursors are idempotent (the reducer returns the same state
 *      reference when nothing changed);
 *   3. stale authority/runtime epochs are ignored;
 *   4. cursor gaps force `resync_required`; the gapped event's payload is
 *      dropped and the cursor does not advance;
 *   5. while resync is required, sensitive mutations
 *      (runtime.install / session.drop / interaction.respond) reduce to a
 *      failed entry with RESYNC_REQUIRED;
 *   6. snapshot events clear resync only on matching authority; version
 *      monotonicity is scoped to one Runtime identity and epoch (either may
 *      restart from a smaller version);

 *   7. command accepted/interaction/terminal transitions never regress or
 *      duplicate; terminal states are final;
 *   8. runtime epoch changes (or runtime loss) mark in-flight commands
 *      outcome_unknown, which is terminal and never retried automatically.
 */

import type {
  AuthorityEpoch,
  AuthorityId,
  BtwSnapshot,
  ClientBootstrap,
  ClientCommandAccepted,
  ClientError,
  ClientEvent,
  ClientInteraction,
  ClientSelection,
  CommandName,
  CommandRequestId,
  CommandState,
  EventCursor,
  IdempotencyKey,
  RuntimeConnection,
  RuntimeEpoch,
  ResidentsReadModel,
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
  readonly telemetry: OperatorStateSnapshot["telemetry"] | null;
  /** Authority-level broker overview; survives Runtime epoch changes. */
  readonly residents: ResidentsReadModel | null;
  /**
   * Latest BTW side-channel snapshot. Sits beside `telemetry` rather than
   * inside `conversation` because a BTW turn is ephemeral: it never enters the
   * transcript and has no conversation item to attach to. Cleared whenever the
   * Runtime identity or the snapshot baseline is invalidated.
   */
  readonly btw: BtwSnapshot | null;
}

/**
 * Session-level interaction area. At most one pending interaction exists
 * (`interaction.required` always writes it; `interaction.resolved` clears
 * only the matching interactionId + leaseGeneration). A later snapshot that
 * still carries the same GUI prompt must keep this card — clearing it would
 * unmount the Renderer between every `state.changed`. Renderer reads the
 * pending card from here — never by scanning commands.
 */
export interface ClientInteractionState {
  readonly pending: ClientInteraction | null;
}

export interface ClientState {
  readonly connection: ClientConnectionState;
  readonly entities: ClientEntitiesState;
  readonly interaction: ClientInteractionState;
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
    entities: { snapshot: null, telemetry: null, btw: null, residents: null },
    interaction: { pending: null },
    commands: {},
    ui,
  };
}

/**
 * Mutations with external side effects; blocked while resync is required.
 *
 * The map is exhaustive over `CommandName` so a new command cannot silently
 * default to "safe"; the few commands that must stay usable during resync are
 * listed explicitly as `false`.
 */
const SENSITIVE_COMMANDS: Readonly<Record<CommandName, boolean>> = {
  "core.prompt": true,
  "core.steer": true,
  "core.followUp": true,
  "core.abort": true,
  "queue.enqueue": true,
  "runtime.pause": true,
  "runtime.resume": true,
  "runtime.settings.get": false,
  "runtime.settings.set": true,
  "turn.retry": true,
  "runtime.install": true,
  "runtime.ensure": true,
  "session.create": true,
  "session.resume": true,
  "session.drop": true,
  "session.archive": true,
  "session.unarchive": true,
  "session.delete": true,
  "interaction.respond": true,
  "permissions.mode.set": true,
  "models.provider.upsert": true,
  "models.provider.delete": true,
  "models.provider.setEnabled": true,
  "models.roles.set": true,
  "models.roles.write": true,
  "models.roles.create": true,
  "models.roles.delete": true,
  "models.roleStorage.set": true,
  "models.fallback.set": true,
  "models.providerOrder.set": true,
  "models.yml.write": true,
  "models.login.start": true,
  "models.login.logout": true,
  "models.provider.test": true,
  "models.provider.probe": true,
  "models.discovery.refresh": true,
  "models.cycleOrder.set": true,
  "models.webSearch.set": true,
  "plugins.setEnabled": true,
  "skills.setEnabled": true,
  "skills.reveal": true,
  "skills.revealRoot": true,
  "mcp.setEnabled": true,
  "mcp.refresh": true,
  "mcp.test": true,
  "agents.definition.upsert": true,
  "agents.definition.delete": true,
  "agents.definition.configure": true,
  "workspace.open": true,
  "workspace.pick": true,
  "workspace.file.create": true,
  "workspace.directory.create": true,
  "usage.openDashboard": true,
  "git.execute": true,
  "github.execute": true,
  "mode.plan.enter": true,
  "mode.plan.exit": true,
  "mode.plan.review.open": true,
  "mode.plan.review.respond": true,
  "mode.plan.review.saveAndQuit": true,
  "mode.vibe.enter": true,
  "mode.vibe.exit": true,
  "goal.create": true,
  "goal.replace": true,
  "goal.show": true,
  "goal.setBudget": true,
  "goal.pause": true,
  "goal.resume": true,
  "goal.drop": true,
  "goal.guided.start": true,
  "loop.enable": true,
  "loop.pause": true,
  "loop.disable": true,
  "session.fast.set": true,
  "session.prewalk.arm": true,
  "session.prewalk.disarm": true,
  "session.clearContext": true,
  "session.fork": true,
  "session.handoff": true,
  "session.model.set": true,
  "session.thinking.set": true,
  "session.tree.get": true,
  "session.tree.navigate": true,
  "session.tree.branch": true,
  "operator.invoke": true,
  "btw.ask": true,
  // Cancelling an in-flight side question is a safety valve, not a mutation
  // that can drift from a stale snapshot: it must work during resync too.
  "btw.abort": false,
  "btw.branch": true,
  "tan.start": true,
  "omfg.generate": true,
  "agent.spawn": true,
  "agent.send": true,
  "agent.kill": true,
  "agent.revive": true,
  "agent.release": true,
  "job.cancel": true,
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
 * Bound retained receipts. In-flight commands are never dropped; oldest
 * terminal rows go first. A long Studio session otherwise keeps every
 * prompt/steer/follow-up receipt for the process lifetime.
 */
export const COMMAND_STATE_TERMINAL_CAP = 100;

function capTerminalCommands(
  commands: Readonly<Record<CommandRequestId, CommandState>>,
): Readonly<Record<CommandRequestId, CommandState>> {
  const keys = Object.keys(commands) as CommandRequestId[];
  let terminalCount = 0;
  for (const key of keys) {
    const command = commands[key];
    if (command !== undefined && isTerminal(command.status)) terminalCount += 1;
  }
  const extra = terminalCount - COMMAND_STATE_TERMINAL_CAP;
  if (extra <= 0) return commands;
  const next: Record<string, CommandState> = { ...commands };
  let dropped = 0;
  for (const key of keys) {
    if (dropped >= extra) break;
    const command = next[key];
    if (command === undefined || !isTerminal(command.status)) continue;
    delete next[key];
    dropped += 1;
  }
  return next;
}

/**
 * Cursor semantics are deterministic:
 * - canonical decimal cursors ("0", "1", "42", no leading zeros) compare as
 *   expected successor (last + 1);
 * - opaque cursors only support equality; any different cursor is
 *   unverifiable and counts as a gap.
 */
const CANONICAL_DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

function parseNumericCursor(cursor: EventCursor): bigint | null {
  return CANONICAL_DECIMAL_RE.test(cursor) ? BigInt(cursor) : null;
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
  if (currentNum === lastNum + 1n) {
    return "next";
  }
  if (currentNum > lastNum + 1n) {
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
  preserve?: (command: CommandState) => boolean,
): Readonly<Record<CommandRequestId, CommandState>> {
  let changed = false;
  const next: Record<CommandRequestId, CommandState> = {};
  for (const key of Object.keys(commands)) {
    const requestId = key as CommandRequestId;
    const command = commands[requestId];
    if (command === undefined) {
      continue;
    }
    if (isTerminal(command.status) || preserve?.(command) === true) {
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

/** Workspace commands are handled by the Host workspace adapter, not by the
 * Runtime session. A workspace switch can therefore change the Runtime epoch
 * while `workspace.open`/`workspace.pick` is still completing. */
function preserveWorkspaceCommand(command: CommandState): boolean {
  return command.commandName === "workspace.open" || command.commandName === "workspace.pick";
}

export function reduceClientState(state: ClientState, action: ClientAction): ClientState {
  const next = reduceClientStateCore(state, action);
  if (next.commands === state.commands) return next;
  const commands = capTerminalCommands(next.commands);
  return commands === next.commands ? next : { ...next, commands };
}

function reduceClientStateCore(state: ClientState, action: ClientAction): ClientState {
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
    // Snapshot, stateVersion and cursor are all-or-none: an unavailable
    // bootstrap (Runtime without a snapshot) leaves both null until a
    // snapshot event establishes Runtime state.
    stateVersion: bootstrap.stateVersion ?? null,
    cursor: bootstrap.cursor ?? null,
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
  // Bootstrap restores the pending interaction from the Runtime snapshot
  // (rule 1.4.5); when the Runtime has no pending, the old Client pending is
  // cleared (rule 1.4.6).
  const interaction = { pending: bootstrap.pendingInteraction ?? null };
  return {
    ...state,
    connection,
    entities: {
      snapshot: bootstrap.snapshot ?? null,
      telemetry: bootstrap.snapshot?.telemetry ?? null,
      btw: null,
      residents: bootstrap.residents ?? null,
    },
    interaction,
    commands,
  };
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
          connection: { ...state.connection, runtimeEpoch: eventRuntimeEpoch, stateVersion: null },
          entities: { ...state.entities, snapshot: null, telemetry: null, btw: null },
          interaction: { pending: null },
          commands: markPendingOutcomeUnknown(
            state.commands,
            "runtime epoch changed; outcome unknown",
            event.occurredAt,
            (command) => preserveWorkspaceCommand(command)
              || command.commandName === "session.resume"
              || command.commandName === "session.create",
          ),
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
    case "operation.progress":
    case "git.repository.changed":
      return { ...state, connection: advanceConnection(state.connection, event) };
    case "residents.changed":
      return {
        ...state,
        connection: advanceConnection(state.connection, event),
        entities: { ...state.entities, residents: event.residents },
      };
    case "telemetry.changed": {
      if (state.entities.snapshot?.sessionId !== event.sessionId) {
        // The Host cursor is global to the event stream. Ignore a delayed
        // telemetry payload for another session, but still consume its
        // cursor so the next valid event does not look like a gap.
        return { ...state, connection: advanceConnection(state.connection, event) };
      }
      const snapshot = state.entities.snapshot;
      return {
        ...state,
        connection: advanceConnection(state.connection, event),
        entities: {
          ...state.entities,
          snapshot: snapshot === null ? null : { ...snapshot, telemetry: event.telemetry },
          telemetry: event.telemetry,
        },
      };
    }
    case "command.accepted":
      return reduceCommandAccepted(state, event);
    case "interaction.required":
      return reduceInteractionRequired(state, event);
    case "interaction.resolved":
      return reduceInteractionResolved(state, event);
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
        entities: { ...state.entities, telemetry: null, btw: null },
      };
    case "conversation.changed":
      // Conversation payloads are consumed by the bounded, target-scoped
      // renderer store. The global client reducer advances transport identity
      // only; retaining full transcripts here duplicated memory and woke every
      // shell listener for each token.
      return { ...state, connection: advanceConnection(state.connection, event) };
    case "btw.changed": {
      if (state.entities.snapshot?.sessionId !== event.sessionId) {
        // Same global-cursor caveat as telemetry: consume the cursor so the
        // next valid event does not look like a gap, but do not attribute a
        // late side-channel delta to whichever session is current now.
        return { ...state, connection: advanceConnection(state.connection, event) };
      }
      return {
        ...state,
        connection: advanceConnection(state.connection, event),
        entities: { ...state.entities, btw: event.snapshot },
      };
    }
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
  // Residents are an authority-level broker view and terminal receipts can
  // arrive from a background resident. Their envelope runtimeEpoch is not a
  // freshness fence; cursor order remains authoritative for both events.
  if (event.kind === "command.receipt" || event.kind === "residents.changed") {
    return undefined;
  }
  return event.runtimeEpoch;
}

/**
 * Snapshots are operator state, not a second copy of the mapped Client card.
 * Keep the live pending card when the snapshot still names the same GUI
 * prompt; drop it when the Runtime no longer has a GUI-owned interaction
 * (or the session identity changed). A reconnect that has snapshot pending
 * but no Client card stays empty here — the facade follows with
 * `interaction.required` carrying the mapped ClientInteraction.
 */
function pendingAfterSnapshot(
  current: ClientInteraction | null,
  snapshot: OperatorStateSnapshot,
  sessionChanged: boolean,
): ClientInteraction | null {
  if (sessionChanged) {
    return null;
  }
  const pending = snapshot.pendingInteraction;
  if (pending === undefined || pending.owner !== "gui") {
    return null;
  }
  if (
    current !== null &&
    current.interactionId === pending.request.interactionId &&
    current.leaseGeneration === pending.leaseGeneration
  ) {
    return current;
  }
  return current;
}

function reduceSnapshot(state: ClientState, event: Extract<ClientEvent, { readonly kind: "snapshot" }>): ClientState {
  const snapshot = event.snapshot;
  // Version is monotonic only inside one Runtime identity and epoch. A
  // different resident Worker may use the same epoch with a smaller version.
  const currentVersion = state.connection.stateVersion;
  const currentSnapshot = state.entities.snapshot;
  if (
    currentVersion !== null &&
    snapshot.stateVersion < currentVersion &&
    snapshot.runtimeId === currentSnapshot?.runtimeId &&
    snapshot.runtimeEpoch === currentSnapshot.runtimeEpoch
  ) {
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
  const sessionChanged =
    state.entities.snapshot !== null && state.entities.snapshot.sessionId !== snapshot.sessionId;
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
    entities: {
      snapshot,
      telemetry: snapshot.telemetry ?? null,
      // A snapshot for a different session invalidates the side-channel; the
      // Runtime has no replay entry for an in-flight BTW, so the panel starts
      // empty rather than showing the previous session's answer.
      btw: sessionChanged ? null : state.entities.btw,
      residents: state.entities.residents,
    },
    interaction: {
      pending: pendingAfterSnapshot(state.interaction.pending, snapshot, sessionChanged),
    },
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

function reduceInteractionRequired(
  state: ClientState,
  event: Extract<ClientEvent, { readonly kind: "interaction.required" }>,
): ClientState {
  const interaction = event.interaction;
  const connection = advanceConnection(state.connection, event);
  // Always write state.interaction.pending (rule 1.3): a same-id +
  // same-generation prompt is idempotent; anything else replaces the card.
  const pending = state.interaction.pending;
  const interactionState =
    pending !== null && pending.interactionId === interaction.interactionId
      ? pending.leaseGeneration === interaction.leaseGeneration
        ? state.interaction
        : { pending: interaction }
      : { pending: interaction };
  // Optional command correlation: with a requestId and a still-accepted
  // command, attach the interaction to the original command state.
  let commands = state.commands;
  if (interaction.requestId !== undefined) {
    const existing = commands[interaction.requestId];
    if (existing !== undefined && (existing.status === "local_pending" || existing.status === "accepted")) {
      commands = {
        ...commands,
        [interaction.requestId]: {
          requestId: existing.requestId,
          commandName: existing.commandName,
          status: "interaction_required",
          interaction,
        },
      };
    } else if (existing !== undefined && existing.status === "interaction_required") {
      if (existing.interaction.interactionId !== interaction.interactionId) {
        commands = {
          ...commands,
          [interaction.requestId]: {
            requestId: existing.requestId,
            commandName: existing.commandName,
            status: "interaction_required",
            interaction,
          },
        };
      }
    }
  }
  return { ...state, connection, interaction: interactionState, commands };
}

function reduceInteractionResolved(
  state: ClientState,
  event: Extract<ClientEvent, { readonly kind: "interaction.resolved" }>,
): ClientState {
  const connection = advanceConnection(state.connection, event);
  // Only the matching interactionId + leaseGeneration clears the pending
  // card; late generations and duplicates are idempotent no-ops. The
  // original command's terminal receipt stays the only completion evidence.
  const pending = state.interaction.pending;
  if (
    pending === null ||
    pending.interactionId !== event.interactionId ||
    pending.leaseGeneration !== event.leaseGeneration
  ) {
    return { ...state, connection };
  }
  return { ...state, connection, interaction: { pending: null } };
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
  const runtimeIdChanged = connection.runtimeId !== state.connection.runtime?.runtimeId;
  const wasDisconnected = state.connection.runtime?.status === "disconnected";
  const lost = connection.status === "disconnected" && !wasDisconnected;
  const epochChanged = nextRuntimeEpoch !== prevRuntimeEpoch;
  const identityChanged = runtimeIdChanged || epochChanged;
  let commands = state.commands;
  if (identityChanged || lost) {
    commands = markPendingOutcomeUnknown(
      commands,
      "runtime changed; outcome unknown",
      event.occurredAt,
      (command) => preserveWorkspaceCommand(command)
        || (identityChanged && !lost && connection.status === "connected"
          && (command.commandName === "session.resume" || command.commandName === "session.create")),
    );
  }
  const interaction = identityChanged || lost ? { pending: null } : state.interaction;
  const advanced = advanceConnection(state.connection, event);
  return {
    ...state,
    connection: {
      ...advanced,
      runtime: connection,
      runtimeEpoch: nextRuntimeEpoch,
      ...(identityChanged || lost ? { stateVersion: null } : {}),
    },
    ...(identityChanged || lost
      ? { entities: { ...state.entities, snapshot: null, telemetry: null, btw: null } }
      : {}),
    interaction,
    commands,
  };
}

export function selectSessionTelemetry(state: ClientState): OperatorStateSnapshot["telemetry"] | null {
  return state.entities.telemetry;
}

export function selectBtwSnapshot(state: ClientState): BtwSnapshot | null {
  return state.entities.btw;
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
