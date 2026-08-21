# OMP Studio backend foundation

> **Historical.** Written before the renderer landed. Current architecture:
> [`docs/architecture.md`](../docs/architecture.md). User-facing history:
> [`CHANGELOG.md`](../CHANGELOG.md).

This repository implements the pre-frontend backend foundation described by the v5 architecture pack. It deliberately does not integrate the renderer. The pinned OMP source is present under `omp-patch/vendor/oh-my-pi`, and the Studio fork of it is carried in two layers: the Runtime sources upstream does not have live as ordinary files in `omp-patch/overlay/`, and the edits to upstream-owned files are four subsystem-grouped patches in `omp-patch/patches/`.

## Implemented boundary

- `packages/studio-protocol`: normative v5 contracts, strict boundary validators, canonical JSON, and length-prefixed frame codec.
- `packages/studio-host`: bridge authentication, durable command recovery, state projection, Runtime resolution and process lifecycle, graceful shutdown, relaunch/rebind, Thread binding persistence, reference-safe retention wiring, Job Object and opaque PTY seams, leases, interaction ownership, and destructive confirmation.
- `packages/runtime-installer`: Ed25519 artifact verification, checksum verification, stable/canary channels, versioned installation, atomic activation, rollback, uninstall protection, and reference-aware retention.
- `omp-patch`: pinned upstream identity plus the Studio fork covering `studio-host`, session-origin classification, authenticated Bridge transport, snapshot recovery, Runtime arbitration, shared session controls, loop/tree/fork modes, Remote InteractionPort Ask re-answer, Plan-role model transitions, remote agent/job operations, graceful shutdown, a fail-closed Live control plane, canonical command-manifest conformance, conversation/transcript projection, and session telemetry. See `omp-patch/README.md` for the overlay/seam split and the capability history.

The Windows artifacts keep separate names: `omp.exe` is the patched CLI/Runtime, while `omp-studio.exe` remains reserved for the future desktop application. No renderer, desktop shell, or GUI Pause Bar is integrated by this phase.

WP-013 is implemented on the Host side: generic request/receipt correlation, Runtime command-id rebinding, fsync-backed ledger recovery, terminal-receipt-tail reconciliation, Host `commitSeq` publications, automatic `outcome_unknown` fencing after disconnect/process exit, and a concrete Node child-process port with containment, readiness, and graceful-shutdown gates.

WP-014 and the backend half of WP-020 provide Host and Runtime control leases, generation-fenced interaction ownership, shared TUI/Bridge services, monotonic state epochs, Runtime-owned events, and accepted/terminal receipts. Session catalog entries preserve their OMP-native paths and carry an origin marker, so Studio can include or hide pre-existing CLI sessions without making native OMP lose visibility.

The Live backend exposes `live.start`/`live.stop`, lifecycle projection, shutdown ordering, and an injectable media-session boundary. Without the future desktop audio sideband, `live.start` fails closed with `CAPABILITY_UNAVAILABLE`; it never reports a fake active session. Tree Ask re-answer and Plan-role model switching are now stable Runtime capabilities. The Runtime remains truthfully graded `limited` only for frontend-owned Live media and the undefined Loop token-limit semantic; count/time Loop limits are supported.

Production artifacts must be regenerated with the release Ed25519 private key. Packaging now probes the just-built `omp.exe`, verifies its authenticated command manifest, snapshot smoke check, and graceful shutdown, and writes those live hashes into the signed installation manifest; stale or reconstructed command hashes fail closed. The repository intentionally contains no production signing key and will not accept unsigned artifacts.

The test runtime under `packages/studio-host/test/support` is only a protocol/host fixture. It must never be packaged or classified as a Full Parity Runtime.

## Commands

```bash
npm install
npm run check
npm run build
npm run omp:verify:patches   # overlay + seam patches from a clean vendor tree
npm run omp:overlay:apply    # leave the vendor tree forked for a build or dev loop
npm run omp:build:host
```

## Architecture invariants

- `contracts/` from the v5 pack are normative when prose and types disagree.
- The renderer may eventually call Host domain APIs only; it must never receive bridge tokens, process handles, or OMP session paths.
- Unknown mutations fail closed.
- `accepted` is not success; only terminal receipts commit terminal outcomes.
- A runtime loss fences the old epoch and changes unresolved accepted work to `outcome_unknown`.
- PTY output is never parsed as a semantic automation channel.
