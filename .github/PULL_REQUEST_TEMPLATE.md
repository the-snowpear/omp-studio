## What

<!-- User-visible change in one or two sentences. -->

## Why

<!-- Motivation, or `Fixes #N`. -->

## How

<!-- Only if the approach is not obvious from the diff. -->

## Testing

<!-- Commands you ran, or why tests are N/A. For localization, record the affected
     surface, preview/real modes, live zh → en → zh switching, and any unverified
     platform or Runtime/SSH path. See docs/localization.md. -->

---

- [ ] Preview **and** real Host paths updated, if this is a read surface
- [ ] Chinese **and** English UI copy covered, including empty/error states and accessibility labels, if copy changed
- [ ] Live language switching and affected cache/Runtime/SSH compatibility checked, if affected; user drafts and stored content preserved ([localization guide](https://github.com/the-snowpear/omp-studio/blob/HEAD/docs/localization.md))
- [ ] No secrets, logs, or dirty vendor gitlink
