# ADR-002: Use `omp --mode rpc-ui` as Primary Active Runtime

Status: Accepted for v3 baseline

## Decision

Every active Thread runs the real installed OMP CLI in RPC UI mode. Native RPC is the preferred channel for all active-session operations and events.

## Rationale

- preserves CLI harness behavior,
- richest public headless surface,
- supports Extension UI and Host Tools,
- supports subagent observation,
- avoids SDK/runtime duplication.
