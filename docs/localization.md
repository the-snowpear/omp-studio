# Localization

OMP Studio owns a Chinese and English interface. A translated dictionary alone
does not establish a complete English mode: mounted views, cached read models,
desktop services and running Runtime processes must also use the current
language. Apply this guide to the surfaces affected by a change.

Start from the **界面语言与跨进程同步** row in
[`doc/feature-index.md`](../doc/feature-index.md) for the implementation map.
[`AGENTS.md`](../AGENTS.md) defines the collaboration rules;
[`development.md`](development.md) describes the normal development checks.

## What to translate

Add or update Chinese and English copy in the same change. Review the entire
affected interaction, including states that are not visible on its happy path.

| Content | Treatment |
|---|---|
| Studio buttons, menus, headings, placeholders, tooltips and accessibility labels | Localize in both languages |
| Studio empty/loading states, status descriptions, validation messages, errors and disabled reasons | Localize at the layer that owns the message |
| Desktop dialogs, tray menus, notifications and Studio-owned Host/Runtime descriptions | Use the existing locale helper in that layer |
| Preview UI labels and Studio-authored demo descriptions | Cover both languages, including `marks=off` |
| User text, model responses, file contents, terminal output and raw third-party errors or metadata | Preserve the original content; localize Studio's surrounding explanation |
| Paths, IDs, command names, configuration keys and stored formats | Preserve their stable values |

Use the existing renderer `t()` dictionaries for reusable interface copy. An
existing inline bilingual helper can remain in its owning surface; it must
evaluate the current locale when used. Do not migrate unrelated copy merely
to make a patch uniform.

Keep dictionary keys and interpolation names aligned between `zh.ts` and
`en.ts`. Translation fallback helps an incomplete interface stay usable; it
does not count as completed translation. The existing dictionary test checks
key parity, placeholder parity and unexpected Chinese characters in English
values. The Chinese language autonym (`settings.general.langZh`) is an
intentional exception. Any new exception needs a specific reason in the review,
not a broader exemption to hide missing translations.

## Read the current language

`AppLanguage` is the preference (`system`, `zh` or `en`); `resolvedLanguage` is
the active `zh` or `en` locale. Renderer components read it through `useI18n()`.
Pass that value, or its corresponding `zh` boolean, into helpers that build
localized display values. This also keeps a forced-language test or preview
consistent with its Provider instead of silently reading global preferences.

For example, the existing slash catalog helper accepts an explicit language:

```tsx
const { resolvedLanguage } = useI18n();
const catalog = useMemo(
  () => mergeSlashCatalogWithManifest(manifest, resolvedLanguage === "zh"),
  [manifest, resolvedLanguage],
);
```

Do not compute translated module constants once with `isZh()` or
`pickLocale()`. Build localized fixtures, menu entries and search descriptions
when the current language is known. Memo and effect dependencies must include
the locale or the locale-dependent `t` function when they produce translated
values. Desktop services use `desktopText`, in-process Host adapters use
`hostText`, and Studio Runtime sources use `runtimeText`.

## Refresh localized values across layers

Caches that contain translated values need a locale-aware key or invalidation
on language change. Reuse the existing cache mechanism and ensure that a read
started under the previous locale cannot repopulate the current locale's cache.
Raw data caches need no language dimension when translation happens at render
time. Release language subscriptions with their owning view, service or Worker.

Changing Main's `process.env.OMP_STUDIO_LOCALE` affects in-process helpers and
future children. It does **not** update a Runtime process that is already
running. Reuse the existing Renderer → Main → Runtime/SSH language path:

- Initial connection, live switching and reconnect must use the latest locale.
  Synchronize it before the localized reads that depend on it.
- Send the Runtime private `studio.locale` frame only after authentication and
  negotiation, when its advertised capability is available. SSH control uses
  `desktop.language.set` only when the Host advertises `desktop.language`;
  observers and the network side channel do not set that preference.
- A legacy endpoint without the capability must remain connected and receive
  no unknown locale frame or method. Record any language limitation of that
  endpoint in the validation result.
- Language synchronization is a display preference. It must not create command
  receipts, advance conversation event sequences or replay user actions.

Preserve the single validation boundary described in `AGENTS.md`; adding
localization does not require another result/event validator or a duplicate
preload/facade input check. Runtime source edits follow the existing
[`overlay and seam workflow`](../omp-patch/README.md).

## Preserve drafts and stored content

A language switch updates display labels without rewriting user content or
attachment identity. The existing image convention illustrates the boundary:
show `图N` in Chinese and `ImgN` in English, keep the canonical copy/serialization
marker `[图N]`, and accept both `[图N]` and `[ImgN]` when reading references.
Stored Composer documents need localized display labels too, not just messages
parsed from plain text. Match thumbnails by their existing identity; changing
labels must not remap disk and clipboard images.

Keep the same draft, selected images and user operation state while updating
the view. Do not remount a whole workspace, clear an editor or restart Runtime
as a way to apply language. UI language also does not select the language of
user prompts or model responses.

## Review and validation

Review the changed surface in Chinese and English with **both preview and real
data paths**. Include the affected menus, empty/error/disabled states and
tooltips/ARIA labels; fixture-only screenshots cannot establish real Host
coverage. Check that longer English labels remain usable at the supported
window sizes. Search results and command descriptions must update too.

Switch `zh → en → zh` on the **same mounted view**, with its relevant state
already present. Depending on the change, that may mean an open menu, a populated
cache, a draft with images, a saved message or a connected Runtime. Review only
the relevant rows below:

| Changed behavior | Acceptance evidence |
|---|---|
| Dictionaries or UI copy | Both language versions, matching placeholders, affected non-happy-path states and usable English layout |
| Derived catalogs, fixtures or menus | Current copy after live switching; no page reload required |
| Localized read cache | A previously read surface changes language; late old reads cannot restore stale copy |
| Composer or message image labels | Draft and saved labels change both ways; text, IDs, bytes and reference mapping stay intact |
| Runtime/SSH synchronization | Initial/live/reconnect language on a capable endpoint; legacy endpoints stay connected without new messages |

Use the existing check entry point and choose suites for the changed behavior.
These are scoped alternatives, not a checklist to run for every copy edit:

```powershell
# Dictionary changes: parity and existing Provider behavior.
npm run check -- --only renderer --suite i18n.test

# Draft/saved image display changes.
npm run check -- --only renderer --suite ChipComposer.test --suite UserMessageBody.test

# Localized shared reads or Bridge synchronization changes.
npm run check -- --only host-client-api --suite shared-reads.test
npm run check -- --only studio-host --suite host-foundation.test

# SSH control language changes.
npm run check -- --only desktop --suite remote-host.test --suite remote-transport.test
```

The default core list lives in `scripts/core-suites.mjs`; it does not currently
include `i18n.test.ts`. Run that suite explicitly for dictionary changes.
Follow the normal `npm run check -- --production` PR gate and the relevant
Runtime checks when applicable. Documentation-only changes need no source tests.

For new regressions, test observable language switching, cache freshness,
connection compatibility or preserved draft/image state. Reuse existing suites;
do not add a test per label, source-text greps or a global Chinese-character ban
over user/Host content.

In the PR, record the affected surface, preview/real coverage, switching scenario,
commands and results. State which platforms and real Runtime/SSH connections
were exercised; socket fixtures or test doubles alone do not establish macOS
device or real SSH acceptance. Document an unverified path explicitly rather
than claiming complete coverage from dictionary tests.
