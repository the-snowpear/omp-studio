# ADR-001: Domain-first Host; Capability Router is internal

Status: accepted for v4

## Decision

The public Studio architecture and API use stable Studio domain concepts.
`CapabilityRouter` lives inside `OmpRuntimeGateway` and is not a product-domain
service exposed to clients.

## Consequences

- UI and application services do not branch on OMP channels.
- Replacing a fallback with upstream RPC does not alter product entities.
- Studio still records selected routes in diagnostics and the Command Ledger.
- Domain projections must not become a second OMP runtime implementation.

