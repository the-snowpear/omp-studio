# ADR-002: One active HostAuthority per Environment

Status: accepted for v4

## Decision

Desktop, Local WebUI, and future remote clients attach to one active
`HostAuthority` for an Environment. Starting a new client must not start a
second Host that controls the same OMP sessions or workspace.

## Consequences

- Authority acquisition requires lock, process-start validation, fencing, and
  recovery of stale discovery records.
- Enabling WebUI adds a listener to the existing authority.
- Client control leases and workspace write leases remain distinct.

