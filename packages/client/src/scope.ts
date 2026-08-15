/**
 * Exact subscription scope filtering, shared by the in-process memory
 * transport and the StudioClientImpl listener fan-out so both agree on
 * which events a scope receives.
 */

import type { ClientEvent, SubscriptionScope } from "@omp-studio/client-contract";

export function eventMatchesScope(event: ClientEvent, scope: SubscriptionScope): boolean {
  switch (scope.scope) {
    case "all":
      return true;
    case "runtime":
      // Every event carrying a runtime epoch is runtime-scoped — including
      // command events that carry one. Events without an epoch (e.g.
      // authority-level diagnostics) are excluded.
      return event.runtimeEpoch !== undefined;
    case "thread":
      // Events carry no thread identity: snapshots expose a sessionId, and
      // SessionId and ThreadId are distinct identities. Comparing them or
      // inventing a session→thread relationship would fabricate matches, so
      // a thread-scoped subscription matches nothing until the contract
      // binds events to a thread.
      return false;
    case "command":
      switch (event.kind) {
        case "command.accepted":
          return event.accepted.requestId === scope.requestId;
        case "interaction.required":
          // Command-correlated interactions match; standalone interactions
          // (no requestId) are invisible to command-scoped subscriptions.
          return event.interaction.requestId === scope.requestId;
        case "command.receipt":
          return event.receipt.requestId === scope.requestId;
        default:
          return false;
      }
  }
}
