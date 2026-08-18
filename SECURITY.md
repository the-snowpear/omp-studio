# Security Policy

## Supported versions

OMP Studio is in public preview (`0.1.0`). Only the latest `main` commit and the latest tagged release receive security attention.

## What this project trusts

- The **Renderer never receives** bridge tokens, process handles, or native OMP session paths.
- Runtime artifacts are **Ed25519-signed**. The repository does not contain production signing private keys. Local keys live under the Host profile (`%APPDATA%\omp-studio\keys` on Windows) and are generated with `npm run omp:keys`.
- Unknown mutations **fail closed**. `accepted` is not success; only a terminal receipt commits an outcome.
- A lost Runtime fences the old epoch. Unresolved accepted work becomes `outcome_unknown`.
- PTY / terminal output is **not** a semantic control channel.

## Reporting a vulnerability

**Do not open a public issue** for a security vulnerability.

1. Open a [private GitHub security advisory](https://github.com/the-snowpear/omp-studio/security/advisories/new), or
2. Contact the maintainer through GitHub (@the-snowpear) with a brief description and a request for a private channel.

Please include:

- Affected version or commit SHA
- Impact (token leak, unsigned runtime accepted, path disclosure, RCE, etc.)
- Reproduction steps or a proof of concept you are willing to share privately
- Whether the issue is in Studio (this repo), the overlay/patches, or upstream [oh-my-pi](https://github.com/can1357/oh-my-pi)

Issues that belong in upstream OMP should be reported to [oh-my-pi security](https://github.com/can1357/oh-my-pi/blob/main/.github/SECURITY.md) as well.

## Response

Reports are handled on a best-effort basis. You can expect an initial acknowledgement within a few days. Please give us a reasonable window before any public disclosure.

## Secrets that must never land in git

- Runtime signing **private** keys (`signing-private.pem`)
- Provider API keys / `models.yml` secrets
- `.env` files, Host logs, session transcripts, AppData profiles

Public keys used to verify packaged runtimes may be copied into `packaging/runtime-keys/` at pack time; that directory is gitignored.
