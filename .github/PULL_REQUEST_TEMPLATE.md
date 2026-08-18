## What

<!-- User-visible change in one or two sentences. -->

## Why

<!-- Motivation, or `Fixes #N`. -->

## How

<!-- Only if the approach is not obvious from the diff. -->

## Testing

<!-- Commands you ran, or why tests are N/A. -->

---

- [ ] `npm run check` (or a documented subset)
- [ ] Runtime / overlay change: `npm run omp:verify:patches`
- [ ] Preview **and** real Host paths updated, if this is a read surface
- [ ] `CHANGELOG.md` `[Unreleased]` updated when user-facing
- [ ] No secrets, `%APPDATA%` logs, `backup/`, or dirty vendor gitlink
