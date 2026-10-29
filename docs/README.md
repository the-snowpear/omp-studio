# Docs

Public documentation for OMP Studio.

| Document | Audience |
|---|---|
| [../README.md](../README.md) | 中文总览 |
| [../README.en.md](../README.en.md) | English overview |
| [getting-started.md](getting-started.md) | Run from source |
| [ssh-workspaces.md](ssh-workspaces.md) | SSH 工作区开发预览：连接、远端 Runtime、终端与当前限制 |
| [../doc/ssh-workspace-test-prompt.md](../doc/ssh-workspace-test-prompt.md) | SSH 与账密功能的独立测试交接提示词 |
| [model-adaptation.md](model-adaptation.md) | Model parameter recommendations, provenance and catalog maintenance |
| [workbench-docking.md](workbench-docking.md) | 工具停靠、浮窗、会话布局和预设 |
| [dock-delivery-2026-10-29.md](dock-delivery-2026-10-29.md) | 停靠工作台实现与验收记录、未验证边界 |
| [fonts.md](fonts.md) | Independent interface, terminal and output font preferences |
| [releases/v0.1.11.md](releases/v0.1.11.md) | 0.1.11 发布页文案、三平台下载与升级说明 |
| [releases/v0.1.10.md](releases/v0.1.10.md) | 0.1.10 发布页文案、三平台下载与升级说明 |
| [migrations/omp-18.13.2.md](migrations/omp-18.13.2.md) | 18.12.6 → 18.13.2 正式版本变化、完整 Runtime / GUI 迁移与无付费验收 |
| [migrations/omp-18.12.6.md](migrations/omp-18.12.6.md) | 18.10.4 → 18.12.6 版本概览、Runtime 适配与新功能 GUI 入口 |
| [migrations/omp-18.10.4.md](migrations/omp-18.10.4.md) | 18.8.0 → 18.10.4 完整版本概览、GUI 入口与验收 |
| [migrations/omp-18.8.0.md](migrations/omp-18.8.0.md) | Studio 0.1.9 / OMP 18.8.0 changes, compatibility and acceptance boundaries |
| [gui-18.4.4.md](gui-18.4.4.md) | OMP 18.4.4 GUI 使用说明 |
| [migrations/omp-18.4.4.md](migrations/omp-18.4.4.md) | Upstream changes and Runtime migration |
| [migrations/omp-18.4.4-gui.md](migrations/omp-18.4.4-gui.md) | Complete GUI scope and local delivery evidence |
| [development.md](development.md) | Inner loop, tests, overlay |
| [performance.md](performance.md) | Streaming budgets, local counters, rollback and repeatable benchmarks |
| [performance-2026-10-29.md](performance-2026-10-29.md) | 启动、整壳性能与包体优化；开源方案对比、实测及覆盖限制 |
| [performance-audit-2026-10-29.md](performance-audit-2026-10-29.md) | 启动/运行/GPU/低配独立审查、量化基线与 P0/P1/P2 路线 |
| [architecture.md](architecture.md) | Packages, Bridge, data rules |
| [releasing.md](releasing.md) | Version, changelog, tag, Windows installer, macOS build |
| [updates.md](updates.md) | In-app updates on Windows and macOS: storage, trust, recovery |
| [migrations/omp-18.3.0.md](migrations/omp-18.3.0.md) | OMP v18.3.0 upgrade, Studio features, verification and external acceptance decisions |
| [migrations/omp-18.2.5.md](migrations/omp-18.2.5.md) | OMP v18.2.5 changes, selected GUI features, verification and rollback |
| [migrations/omp-18.1.18.md](migrations/omp-18.1.18.md) | OMP v18.1.18 changes, adaptation, verification and rollback |
| [../CHANGELOG.md](../CHANGELOG.md) | User-facing history |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to send a change |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reports |
| [../doc/feature-index.md](../doc/feature-index.md) | Feature → file map for contributors |

`../doc/` also holds historical design notes (`BACKEND_FOUNDATION.md`,
`FRONTEND_INTEGRATION.md`, `real-conversation/`). Treat those as archaeology
when they disagree with `architecture.md` or the TypeScript contracts.

- [OMP 18.4.4 与 macOS 整合、修复和验收](integration-18.4.4-macos.md)
