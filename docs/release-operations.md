# Release Operations

## Update-system migration

The `codex/incremental-updates` branch introduces the v2 updater described in [updates.md](updates.md) and the current section of [releasing.md](releasing.md). This branch does not itself publish a new application version. The v0.1.4/v0.1.5 publication records below remain historical facts; their old payload format is not the new release format.

On 2026-09-17, titles and descriptions of the five existing desktop releases were normalized with explicit installer links and attachment explanations. Asset names, bytes, tags and download links were retained. Original remote metadata and proposed descriptions were saved under `backup/2026-09-17/release-descriptions-2026-09-17T09-36-58-387Z/` before applying the edits.

## Signing Identity Established on 2026-09-06

- Repository: `the-snowpear/omp-studio`.
- GitHub Environment: `release`.
- Environment secret: `OMP_RUNTIME_SIGNING_KEY`.
- Active key ID: `omp-studio-release-2026b`.
- Algorithm: Ed25519.
- Public key: `packaging/keys/omp-studio-release-2026b.pem`.
- SHA-256 of DER SPKI public key:
  `7d3790c0a83e35d1b2f0ce3d7fc6455638ad50dc792d39c109d8b3b2a268e77a`.
- Local private key:
  `%APPDATA%\omp-studio\release-keys\omp-studio-release-2026b\signing-private.pem`.
- Local public key: `trusted-public.pem` in that same directory.

The key directory disables inherited permissions and grants access only to
the creating Windows user and SYSTEM. The private key was uploaded to the
named GitHub Environment secret through standard input. No private bytes
are stored in the repository, project backup, release assets, or this document.
Preserve this directory in a separately managed encrypted offline backup.
GitHub cannot return the plaintext secret later.

The previous public key `omp-studio-release-2026a` remains trusted. Its
matching private key was not available; the default local development key
did not match it. Consequently this is a full-Setup bootstrap of a new
release identity, not an old-key-signed rotation. Published v0.1.3 used the
legacy Setup updater. Installations already testing the old signed index
must manually install v0.1.4 Setup to acquire the new trust root.

## Release Procedure

Use [releasing.md](releasing.md) for artifact names, channels and gates.
The first indexed release is v0.1.4, targeting Windows x64. Keep the payload
and Runtime minimum Main versions at 0.1.4 for this migration. The release
contains the Setup, signed renderer/preload archive, signed update index,
and four signed Runtime files. The preview switch must remain disabled.

After all workspace package versions and the lockfile agree, push the
matching `vX.Y.Z` tag. Tag runs always build and sign Runtime. The workflow
checks the source, packages Setup, creates assets, verifies readiness, and
publishes a draft only after its assets have been uploaded. Manual workflow
runs support reuse only when all four matching Runtime assets already exist.

For a local build, set these PowerShell variables without printing the key:

```powershell
$env:OMP_RUNTIME_SIGNING_KEY_ID = 'omp-studio-release-2026b'
$env:OMP_RUNTIME_SIGNING_KEY = Join-Path $env:APPDATA 'omp-studio\release-keys\omp-studio-release-2026b\signing-private.pem'
npm run omp:overlay:apply
npm run pack:win
node scripts/build-update-assets.mjs
npm run p5:gate
```

Subsequent local releases must also provide `OMP_PREVIOUS_UPDATE_INDEX` for
the previous signed index from the same channel and architecture. Do not
reuse a sequence or change bytes under an existing published version.
Use a new application version and a new Runtime version for changed Runtime
content. Do not replace the release public key with an automatically
generated development key.

## Recovery and Rotation

An application payload failure can be bypassed using `OMP Studio.exe
--omp-baseline`. A failed Runtime session startup attempts to reactivate
the previous verified Runtime; diagnostics also provides explicit rollback.
Keep the previous Setup available for recovery.

For planned key rotation, distribute a full Setup containing the next
public key while still signing the update with the current private key.
Only switch signing identities after clients have acquired that Setup.
If the active private key is lost, existing clients cannot automatically
trust a replacement: a manually installed full Setup is required again.

## Verified Publication

Published on 2026-09-06:

- Release: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.4
- Successful workflow: https://github.com/the-snowpear/omp-studio/actions/runs/34030531515
- Release source/tag: `d068e47d9f0275f8b386b5f6a11aa869fa6ef3d5`.
- Windows x64 application: `0.1.4`; Runtime: `18.1.10-studio.2`.
- Index sequence: `1`; signing key: `omp-studio-release-2026b`.
- Eight public assets are present and the release is stable/latest.
- CI application/Runtime gates, installer audit and P5 readiness gate passed.
- Production download code verified the index signature and every asset digest.
- Downloaded Runtime passed real installation, activation and smoke test.
- Downloaded payload passed installation, repeated installation and startup
  compatibility selection against the 0.1.4 baseline.
- A 0.1.3 installed Main correctly receives a full-Setup plan; Runtime-only
  upgrade is blocked until the 0.1.4 Main baseline is installed.

Local evidence and downloaded files are in `outputs/published-v0.1.4/`,
including `verification.json`; these generated outputs are not committed.
The local network intermittently timed out on GitHub direct downloads. All
assets were successfully verified through `https://gh-proxy.com/`, which was
saved to the newly created `%APPDATA%\omp-studio\update-prefs.json`. No prior
preference file existed. The shipped default remains direct GitHub access;
the local mirror can be cleared from update settings. Mirrors do not replace
the Ed25519 trust check.

The Setup has no Windows Authenticode signature. The update index authenticates
its SHA-256 digest. A clean Windows GUI install/upgrade remains a separate
manual check; the automated Runtime install test does not claim to cover it.

Published on 2026-09-13:

- Release: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.5
- Successful workflow: https://github.com/the-snowpear/omp-studio/actions/runs/34705770704
- Release source/tag: `b60accb2a7b51ac5147fe7b3706747aadd6ecd54` (tag `v0.1.5`).
- Windows x64 application: `0.1.5`; Runtime: `18.1.18-studio.5` (upstream pin `00085d4e7dfdcfbf302c122fa2682b410a0f43d1`).
- Index sequence: `2`; signing key: `omp-studio-release-2026b`.
- Eight public assets are present and the release is stable/latest.
- CI application/Runtime gates, installer audit and P5 readiness gate passed.
- Minimum app version baseline: `minAppVersion` defaults to `0.1.5` for payload and Runtime, requiring full Setup upgrades for older Main baselines.

Published on 2026-09-20:

- Release: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.6
- Successful workflow: https://github.com/the-snowpear/omp-studio/actions/runs/35494692656
- Release source/tag: `2de617d77d83c6c91a39cbea157a5eb81d7b962b` (tag `v0.1.6`).
- Windows x64 + ARM64 application: `0.1.6`; Runtime: `18.2.5-studio.6` (upstream pin `37273117021129e96bd05d8277b140ec3fd61990`).
- First v2 desktop release: app sequence `1` and Runtime sequence `1` per channel/architecture; signing key `omp-studio-release-2026b`.
- Twelve public assets are present (both architectures' Setup, Runtime ZIP, blockmaps, `updates-win32-*.json`, plus the x64 v1 migration `update-index.json`/`.sig.json`) and the release is stable/latest.
- CI application/Runtime gates, installer audit and P5 readiness gate passed on both native Windows runners.
- The x64 migration index points long-offline v1 clients at this release's Setup; no v1 ARM64 feed ever existed, so ARM64 carries v2 catalogs only.
- Post-publication verification (`outputs/published-v0.1.6/verification.json`, not committed): 52 checks passed — both catalog Ed25519 signatures, every asset's size/SHA-256 against GitHub's stored digests, the migration feed signature and its Setup pointer, and a real end-to-end download of the x64 Setup matching the signed digest. Direct GitHub downloads were intermittently reset locally; verification completed through the documented `gh-proxy.com` mirror fallback. Mirrors do not replace the Ed25519 trust check.
- Release notes were curated after publication to include the full changelog section; the workflow-generated install/Runtime text was saved to `outputs/published-v0.1.6/release-notes-generated.md` first.
- Four earlier tag runs (35460227446, 35489322937, 35491181436, 35493227835) failed in test stages before any publication; the fixes (renderer animation-frame cleanup, host-arch-pinned update tests, Bun's 30s per-test timeout for all Runtime suites) are commits `a540c21`, `8f5a8d7`, `1194c12`, `8514c5d`, `2de617d`.
