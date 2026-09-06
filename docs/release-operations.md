# Release Operations

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
