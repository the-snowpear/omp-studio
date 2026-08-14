# ADR-001: Managed Studio Host Runtime Is the Default

## Decision

OMP Studio 默认启动自己管理、验证和可回滚的 `studio-host` Runtime，而不是依赖用户全局 OMP。

## Consequences

- Full Parity 可以作为确定产品承诺；
- 上游升级先经过 CI；
- 用户全局 OMP 不被覆盖；
- Desktop 与 Runtime 可以独立升级；
- 增加 Runtime 分发、签名和维护成本。

## Alternatives rejected

- 仅支持系统 OMP：无法保证 TUI-only/Agent Hub 能力；
- 将 OMP 链接进 Electron：生命周期和升级耦合过重；
- 每次启动在线 patch：不可重现且不安全。

