# ADR-001: Target Harness Parity with Multiple OMP Channels

Status: Accepted for v3 baseline

## Context

OMP exposes different capabilities through RPC, slash commands, CLI, settings/config files, native definition files, collaboration internals and extension/runtime APIs. No single current public transport covers every desirable GUI management surface.

## Decision

OMP Studio targets OMP Harness parity and uses a Capability Broker to route each operation to the best semantics-preserving channel.

## Consequences

Positive:

- broader feature coverage,
- real OMP remains authoritative,
- gaps can be migrated to upstream RPC over time.

Negative:

- more adapters to test,
- capability probing is required,
- compatibility channels must be carefully quarantined.
