# ADR-006: Do Not Mutate Active Session JSONL or `agent.db`

Status: Accepted for v3 baseline

## Decision

Studio will not obtain feature parity by directly changing OMP private state stores.

## Allowed

- read-only history/artifact indexing,
- official CLI/RPC auth/config flows,
- documented native config files.

## Forbidden

- editing active session JSONL,
- editing `agent.db` credentials,
- modifying registry artifacts to simulate agent control.
