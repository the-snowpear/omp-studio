# Releasing

OMP Studio is versioned from the workspace root `package.json` (`0.1.0` at
the first public snapshot). Workspace packages share that version today.

## Checklist

1. **Changelog.** Move items from `## [Unreleased]` in `CHANGELOG.md` into a
   new `## [X.Y.Z] - YYYY-MM-DD` section. Keep `[Unreleased]` headings empty.
   Update the compare links at the bottom of the file.
2. **Version.** Bump `version` in the root `package.json` and in workspace
   `package.json` files that still hard-code the same number.
3. **Preview switch.** For a build you would give to end users, set
   `PREVIEW_MODE_SWITCH_ENABLED` in `apps/renderer/src/preview/mode.ts` to
   `false`.
4. **Gate.**

   ```powershell
   npm run check
   npm run omp:test:metadata
   npm run omp:verify:patches
   ```

5. **Commit** on `main` with a message such as `release: vX.Y.Z`.
6. **Tag** annotated: `git tag -a vX.Y.Z -m "OMP Studio vX.Y.Z"`.
7. **Push** `main` and the tag: `git push origin main --tags`.
8. **GitHub Release.** `gh release create vX.Y.Z --notes-file ...` (or paste
   the changelog section). Mark pre-1.0 tags as pre-release when the product
   is still a preview.

Do not put signing private keys, `%APPDATA%` logs, or `backup/` into the tag.

## Windows installer (optional artifact)

The NSIS path is a skeleton. It is **not** required for a source tag.

```powershell
npm run omp:build:host
npm run pack:win:prepare
npx electron-builder --config packaging/electron-builder.yml --win nsis
```

`pack:win:prepare` copies the **public** Runtime key into
`packaging/runtime-keys/` (gitignored) and fails if the signed artifact is
missing. Output lands in `outputs/installer/` (gitignored).

Attach the installer to the GitHub Release only after you have confirmed it
boots, verifies the Runtime signature, and does not embed the private key.

Details: [`packaging/README.md`](../packaging/README.md).

## What not to publish

- `signing-private.pem` or any `.pem` except a documented public key
- Session transcripts, `models.yml` with secrets, Host logs
- `architecture_review_v2_work/`, `ui_reference/test/`, `backup/`
- A dirty `omp-patch/vendor/oh-my-pi` gitlink
