# ADR-004: Allow an Optional Companion Extension for Missing Control Surfaces

Status: Accepted for v3 baseline (experimental when private imports are required)

## Decision

A narrow OMP Studio Companion Extension may bridge missing structured controls inside the real OMP runtime when no public RPC/CLI/config route exists.

## Constraints

- optional,
- deterministic local commands only,
- explicit protocol/version handshake,
- no second agent harness,
- private imports only behind exact-version guards,
- deprecate each command when native RPC gains parity.
