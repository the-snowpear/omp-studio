# 07. Upgrade and Compatibility CI

## 1. Patch stack 原则

为了降低 OMP 上游升级成本：

- 新代码集中在 `src/studio/`；
- 对现有文件只做 dependency injection 和 handler forwarding；
- 不无关格式化或重构；
- service extraction 保持原 TUI tests；
- 每个 patch 对应独立主题和 upstreamable commit；
- patchset version 与 upstream commit 写入 Runtime manifest。

## 2. 自动升级流水线

```text
detect upstream tag/commit
  -> create candidate branch
  -> apply/rebase patch stack
  -> install locked dependencies
  -> typecheck/lint/unit tests
  -> extract source surface manifests
  -> build Runtime for target OS
  -> run protocol/command/agent/job/UI tests
  -> compare capability and command manifests
  -> run packaging/signing smoke
  -> publish candidate
  -> staged rollout
```

如果上游没有触及相关能力，整个流程可以无人干预；如果任何 gate 失败，只阻止新 Runtime，不影响旧 Runtime 或 Desktop App。

## 3. Source surface extraction

CI 自动提取：

- RPC command/event union；
- ACP methods/modes；
- built-in command name/aliases/handle/handleTui；
- extension context/API surface；
- AgentRegistry/Lifecycle/Task/Job required symbols；
- settings schema/default changes；
- session entry/mode persistence shapes；
- Runtime package exports。

生成 normalized JSON 并与 approved baseline diff。

## 4. Contract suites

### Protocol

- hello/version/profile；
- auth；
- request/receipt correlation；
- idempotency conflict；
- snapshot/gap/reconnect；
- backpressure；
- graceful shutdown。

### Commands

- 所有 built-in manifest coverage；
- TUI 与 Bridge 调同一 service；
- argument validation；
- precondition；
- interaction；
- terminal receipt/postcondition；
- mode restore。

### Agent/Job

- list/get/events/transcript；
- send/steer/follow-up；
- spawn policy；
- kill/revive/release generation；
- job list/cancel；
- owner scope。

### Remote UI/TUI

- confirm/select/input/editor/approval；
- transfer；
- custom TUI manual path；
- PTY 断开不影响 Bridge；
- no ANSI semantic inference。

## 5. OS 矩阵

| Suite | Windows | macOS | Linux |
|---|---:|---:|---:|
| Bridge transport | 必须 | 必须 | 必须 |
| PTY/TUI | ConPTY | 必须 | 必须 |
| process containment | Job Object | process group | process group/cgroup optional |
| installer/update/rollback | 必须 | 必须 | 必须 |
| audio Live | 分阶段 | 分阶段 | 分阶段 |

## 6. Manifest diff policy

| Diff | Policy |
|---|---|
| 新 built-in command | 必须新增 route/test，否则 fail |
| command removed/renamed | migration/alias review，否则 fail |
| handle→handleTui | 能力退化，fail |
| schema/risk/effect 变化 | 人工审查 |
| required Agent/Job internal symbol 变化 | patch adapter + full suite |
| capability stable→experimental/unavailable | fail Full Parity release |
| only description text 变化 | snapshot update review |

## 7. Runtime 发布

- build reproducible；
- binary + manifest + checksums 签名；
- staged channel：canary → stable；
- Desktop 下载前验证签名；
- self-test 后原子激活；
- telemetry 只记录版本、错误 code 和兼容性，不记录 prompt/session content；
- rollback 保留最近至少两个 stable Runtime。

## 8. System OMP 分类 CI

维护 fixtures：

- 当前普通上游 OMP：预期 Limited；
- Managed Runtime：预期 Managed Full；
- compatible reference build：预期 Compatible Full；
- lying manifest build：预期 Rejected；
- protocol old/new build：预期 Limited/Rejection；
- partial Agent API build：预期 Limited。

