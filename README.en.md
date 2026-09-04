<p align="center">
  <img src="icon.png" width="96" height="96" alt="OMP Studio">
</p>

<h1 align="center">OMP Studio</h1>

<p align="center">
  <strong>Desktop console for OMP Runtime</strong><br>
  Typed Studio Bridge · Electron workbench · Windows first
</p>

<p align="center">
  <a href="README.md">中文</a>
  ·
  <a href="docs/README.md">Docs</a>
  ·
  <a href="CHANGELOG.md">Changelog</a>
  ·
  <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>
</p>

<p align="center">
  <a href="https://github.com/the-snowpear/omp-studio/actions/workflows/ci.yml"><img src="https://github.com/the-snowpear/omp-studio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.3-informational.svg" alt="0.1.3"></a>
  <a href="docs/getting-started.md"><img src="https://img.shields.io/badge/platform-Windows-0078D4.svg" alt="Windows"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-339933.svg" alt="Node 22+"></a>
</p>

OMP Studio is a desktop shell for [oh-my-pi](https://github.com/can1357/oh-my-pi) (OMP). Sessions, approvals, Agent Hub, and the workspace are driven through a typed Studio Bridge — not by scraping TUI text, ANSI, or key macros.

<p align="center">
  <img src="docs/images/workbench.png" alt="OMP Studio workbench: new conversation welcome, activity heatmap, and composer" width="920">
</p>

## Why this workbench

Skills, usage, providers, capabilities, and Git live in one window — no hopping between a TUI and a pile of web pages.

### 1. Fast-select Skills sidebar

Open the Skills & Plugins drawer from the left rail. Skills are grouped by project / global / built-in. Click **Add** to drop a skill into the current draft; `/skill:` capsules in the transcript show what you already used.

<p align="center">
  <img src="docs/images/skills.png" alt="Skills sidebar grouped by project, global, and built-in" width="920">
</p>

### 2. Usage and stats that are actually readable

The home page has Token charts you can switch by year / month / week / day, plus a heatmap. The conversation header opens turn cost, cache hits, TPS, and sub-agent spend; Agent Hub repeats the same numbers per child.

<p align="center">
  <img src="docs/images/home.png" alt="Home page Token chart and heatmap" width="432">
  &nbsp;
  <img src="docs/images/telemetry.png" alt="Conversation Token usage popover" width="432">
</p>

### 3. Unified provider management

The model-config page keeps Anthropic, OpenAI, OpenRouter, local LM Studio, and friends in one list — toggles, endpoints, and `modelProviderOrder` on the same screen. The Roles tab assigns models and thinking to `@default` / `@plan` / `@task`.

<p align="center">
  <img src="docs/images/models.png" alt="Model config: unified provider list" width="432">
  &nbsp;
  <img src="docs/images/roles.png" alt="Role config: models per task" width="432">
</p>

### 4. Capabilities center

Skills, Plugins, MCP, and Slash Commands share one page for toggles, probes, and folders. Agent Hub watches the main session and every sub-agent’s status, cost, and context window.

<p align="center">
  <img src="docs/images/capabilities.png" alt="Capabilities center: Skills, Plugins, MCP, Slash" width="432">
  &nbsp;
  <img src="docs/images/hub.png" alt="Agent Hub: sub-agent list and usage" width="432">
</p>

### 5. Git, in the same window

The right-hand Git panel stages, diffs, and commits next to the conversation. Fetch / Pull / Push and the commit graph stay beside the thread.

<p align="center">
  <img src="docs/images/git.png" alt="Workbench Git panel: diff, commit, and graph" width="920">
</p>

> [!TIP]
> **Installation & Getting Started:** Windows users can download the latest installer (`OMP-Studio-Setup-0.1.3-win-x64.exe`) directly from [GitHub Releases](https://github.com/the-snowpear/omp-studio/releases), or run from source following the instructions below. Please file any bugs or suggestions as [Issues](https://github.com/the-snowpear/omp-studio/issues).

## What it does

- **Conversation workbench** — composer (chips, `@` mentions, slash commands, images), tool cards, session changes, subagents, Plan / Vibe / approvals.
- **Sessions and projects** — local workspace registry, history, archive. The renderer sees opaque ids, never native absolute paths.
- **Agent Hub / Skills / models** — inventory and config go through the Host. Surfaces without a read model stay disabled instead of filling with fake data.
- **Desktop capabilities** — Git, file tree, terminal PTY, notifications, open-in-browser. The control plane stays semantic commands, not glued-together shell.
- **Managed Runtime** — pinned oh-my-pi submodule + overlay + four seam patches; `omp --mode studio-host`. Artifacts are Ed25519-verified.

## Quick start

Node.js 22+ is required. Full steps: [docs/getting-started.md](docs/getting-started.md).

```powershell
git clone --recurse-submodules https://github.com/the-snowpear/omp-studio.git
cd omp-studio
npm install
npm run preview
```

Or double-click `preview.cmd` at the repo root.

Attach a real Runtime (slow the first time):

```powershell
npm run omp:install-deps
npm run omp:overlay:apply
npm run omp:keys
npm run omp:build:host
npm run preview
```

Models and login use OMP’s `models.yml` / `omp login`. This repository does not ship provider secrets.

## Layout

```
apps/desktop          Electron main process
apps/renderer         Vite + React workbench
packages/             protocol, Host, client, transports, platform
omp-patch/overlay     Studio-owned Runtime sources
omp-patch/patches     seam patches on upstream files (do not hand-edit)
omp-patch/vendor      oh-my-pi submodule (commit the gitlink only)
packaging/            Windows NSIS installer skeleton
ui_reference/ver1     visual reference, not product code
docs/                 user and contributor docs
```

When changing a product surface, jump from [doc/feature-index.md](doc/feature-index.md) instead of searching the whole tree.

## Architecture

```
Renderer → StudioClient → Desktop IPC → Host facade
                                    ├─ local: session catalog / Git / workspace
                                    └─ Bridge → omp --mode studio-host
```

Invariants (see [docs/architecture.md](docs/architecture.md)):

- When prose and types disagree, `studio-protocol` and `client-contract` win.
- The renderer must never receive bridge tokens, process handles, or OMP session paths.
- Unknown mutations fail closed; `accepted` is not success.
- Runtime loss fences the old epoch and maps unresolved accepted work to `outcome_unknown`.

## Documentation

| | |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Run from source |
| [docs/development.md](docs/development.md) | Inner loop, preview mode, patch regen |
| [docs/architecture.md](docs/architecture.md) | Packages and invariants |
| [docs/releasing.md](docs/releasing.md) | Version, tag, installer |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to open a PR |
| [SECURITY.md](SECURITY.md) | Vulnerability disclosure |
| [CHANGELOG.md](CHANGELOG.md) | User-facing history |
| [omp-patch/README.md](omp-patch/README.md) | Overlay / seam patches |

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Do not file security issues publicly. Follow [SECURITY.md](SECURITY.md).

Defects in upstream OMP belong in [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). This repository only maintains the overlay and four seam patches.

## License

[MIT](LICENSE). Third-party notices: [NOTICE](NOTICE).

The pinned Runtime is [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT; Pi by Mario Zechner, omp by Can Bölük). Studio’s overlay and seam patches are independent work in this repository, also MIT.
