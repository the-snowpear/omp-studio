# ADR-005: Fallback channels are expiring compatibility debt

Status: accepted for v4

## Decision

Every non-primary route has an owner, reason, stability grade, version guard,
risk, kill switch, upstream target, review date, and removal condition.

## Consequences

- Private routes are never advertised as stable.
- CI fails an experimental/private route without a debt entry.
- Capability UI remains stable while internal routes are removed.
- RPC coverage growth should reduce adapter count over time.

