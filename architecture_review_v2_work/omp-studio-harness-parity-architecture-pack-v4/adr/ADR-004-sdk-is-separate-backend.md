# ADR-004: OMP SDK is a separate RuntimeBackend

Status: accepted for v4

## Decision

An SDK-created AgentSession is a distinct runtime binding. SDK must never be
selected as a fallback to mutate or control an existing rpc-ui Thread.

## Consequences

- Backend is selected when a Thread/runtime binding is created.
- SDK and RPC runtimes have distinct runtime epochs and process ownership.
- Cross-backend resume requires an explicit supported migration contract.

