# ADR-005: Keep OMP Collab as Experimental Compatibility Only

Status: Accepted for v3 baseline

## Context

OMP Collab already exposes host-authoritative Agent Hub chat/kill/revive/transcript through `agent-cmd`, which is richer than current native RPC control.

## Decision

Do not make Collab a core Studio backend. It may be used behind a feature flag as an experimental compatibility adapter while upstream/native controls are missing.

## Rationale

The protocol is designed for collaboration, not first-party local GUI IPC. Depending on it long-term would couple Studio to an internal transport for the wrong purpose.
