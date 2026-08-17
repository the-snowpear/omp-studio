# @omp-studio/runtime-installer

Ed25519-signed, checksum-verified, versioned installation of managed OMP
Studio Runtimes with atomic activation, a pre-activation self-check, rollback,
channel metadata, and reference-safe retention.

## Artifact contract (WP-002)

`scripts/runtime-artifact.mjs` (run by `npm run omp:build:host` after the
`omp.exe` build and `--smoke-test` succeed, or standalone via
`npm run omp:artifact`) emits a complete installable artifact per build into
`packages/runtime-installer/dist/artifacts/<platform>/<runtimeVersion>/`:

- the built entrypoint binary (`omp.exe`);

- `runtime-manifest.json` — `RuntimeInstallationManifest` fields from
  `@omp-studio/studio-protocol`: `runtimeVersion`, `upstreamVersion`,
  `upstreamCommit`, `patchsetVersion`, `studioProtocol`, `profile`,
  `capabilityHash`, `commandManifestHash`, `platform`, `entrypoint`.
  The `channel` field is either `stable` or `canary`.
  `platform` is `<os>-<arch>` (for example `win32-x64`); the contract has no
  separate `arch` field. The managed Runtime CLI is always `omp.exe`;
  `omp-studio.exe` is rejected because it is reserved for the desktop app.
- `checksums.json` — `sha256` digests covering every artifact file
  (`omp.exe` and `runtime-manifest.json`).
- `runtime-signature.json` — Ed25519 signature over the exact manifest bytes,
  a NUL separator, and the exact checksum bytes. The checksum manifest is thus
  signed without creating a circular checksum for the signature file.

All values come from the real pin (`omp-patch/upstream.json`), the real patch
series (`omp-patch/patches/series.json`), the pinned vendor package version,
and the real built binary. `runtimeVersion` is
`<upstreamVersion>-<patchsetVersion>`, where `patchsetVersion` is the
`studio.<n>` value recorded in the series file. It is recorded rather than
derived from the patch count so that consolidating patches cannot move the
version backwards onto an already-installed directory name; `omp:patches:regen`
advances it whenever the fork's content digest changes.
Emitted JSON is deterministic: no timestamps, no absolute paths, fixed key
order — two builds over identical inputs produce byte-identical files.

Artifact provenance (returned by the generator, not written into the manifest)
covers both layers of the fork: `patchHashes` for the seam patches and
`overlayHash` for `omp-patch/overlay/`, which holds the bulk of the Studio
Runtime source. See `omp-patch/README.md` for the layer split.

### Limited capability/command hashes

The current managed build is not yet Full Parity. Its installation manifest is
therefore marked `limited`, and `capabilityHash` / `commandManifestHash` use the
same deterministic algorithm and verified operation set as the live Runtime
hello: runtime pause/resume/snapshot, queue enqueue, clear context, drop,
retry, prompt, steer, follow-up, and abort. `session.drop` remains limited and
fails closed until InteractionPort approval is available. Adding a service
requires changing both sides plus compatibility tests; the installer must
never label this subset as Full Parity.

## Activation self-check (WP-003)

`install()` verifies checksums and copies the candidate into
`versions/<runtimeVersion>/` without executing anything. `activate()` then
runs an injectable `SelfCheckRunner` against the installed entrypoint before
`current.json` is written; the default runner executes
`<entrypoint> --smoke-test` with a timeout and a hidden window. If the
self-check fails:

- `current.json` is not changed (the previous active Runtime stays active);
- the candidate is moved to `versions/.quarantine-<version>-<random>/` so it
  leaves the installable set but remains recoverable for inspection;
- the error is rethrown with the quarantine location.

Tests inject fake runners/spawn functions and never execute untrusted files.
An opt-in real end-to-end check is `npm run omp:e2e:install` (requires a
generated artifact and the built package; runs the real `omp.exe
--smoke-test`).

Artifact generation requires `OMP_RUNTIME_SIGNING_KEY` (a PEM/DER Ed25519
private-key file) and `OMP_RUNTIME_SIGNING_KEY_ID`. Installation/E2E requires
the matching `OMP_RUNTIME_TRUSTED_PUBLIC_KEY` plus the same key id. Private
keys must remain outside the repository. `uninstall()` refuses current,
previous, and active Thread-referenced versions; `prune()` retains at least
the two newest stable versions and all referenced versions.

## Commands

```bash
npm run typecheck -w @omp-studio/runtime-installer
npm test -w @omp-studio/runtime-installer
npm run omp:test:metadata        # light metadata tests for scripts/runtime-artifact.mjs
npm run omp:build:host           # build omp.exe + smoke + generate artifact metadata
npm run omp:e2e:install          # opt-in real E2E (install + activate + real self-check)
```
