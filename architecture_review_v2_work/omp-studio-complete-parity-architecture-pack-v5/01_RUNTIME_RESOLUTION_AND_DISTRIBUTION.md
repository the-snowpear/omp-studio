# 01. Runtime Resolution and Distribution

## 1. 目标

Runtime Resolver 必须对每个候选可执行文件给出确定分类：

```ts
"managed" | "compatible-system" | "limited-system" | "rejected"
```

分类是 probe 结果，不是用户设置本身。

## 2. 用户策略

```ts
type RuntimePreference =
  | { kind: "managed" }
  | { kind: "system"; executable?: string; allowLimited: boolean }
  | { kind: "custom"; executable: string; allowLimited: boolean };
```

默认值：`{ kind: "managed" }`。

## 3. Resolver 算法

```text
resolveRuntime(preference)
  1. resolve absolute executable path
  2. validate file ownership/trust policy
  3. run `--version` with bounded timeout
  4. start isolated probe process with empty temporary workspace
  5. attempt Studio Hello
  6. validate protocol range
  7. validate required capability IDs and grades
  8. fetch and hash Command Manifest
  9. run no-side-effect smoke operations
 10. classify compatible-system or limited-system
 11. reject malformed, untrusted or protocol-lying runtime
```

Managed Runtime 不因为来源受信任就跳过 probe；它必须额外校验签名和发布 manifest。

## 4. Compatible gate

候选只有满足全部条件才是 Compatible：

- `studio.hello` 成功；
- protocol version 在 Host 支持范围；
- profile `full-parity-v1` 可用；
- required capabilities 全部为 `stable` 或允许的 `experimental`；
- command manifest 可解析且没有未分类 built-in；
- snapshot/receipt/event correlation smoke test 通过；
- agent/job API schema 与 Host 相容；
- Remote UI standard capability 可用；
- TUI manual compatibility 可用；
- process 能在 timeout 内优雅 shutdown。

任何一项不满足即为 Limited，除非存在安全/欺骗问题需要 Rejected。

## 5. Limited 行为

Limited Runtime 只能启用 probe 证实的 route。Host 为每个 capability 建立：

```ts
type LimitedRoute =
  | { transport: "rpc-ui"; command: string }
  | { transport: "acp"; method: string }
  | { transport: "admin-cli"; args: string[] }
  | { transport: "unavailable"; reason: string };
```

禁止 Limited Runtime：

- deep import Companion；
- PTY 自动输入 Slash；
- 与 Managed Runtime 共享 active session；
- 将不可用按钮隐藏成“已支持”；
- 用模型 prompt 合成 agent control。

## 6. 安装和激活

Managed Runtime manifest：

```json
{
  "runtimeVersion": "17.2.13-studio.1",
  "upstreamVersion": "17.2.13",
  "upstreamCommit": "<sha>",
  "patchsetVersion": "1.0.0",
  "studioProtocol": { "min": 1, "max": 1 },
  "profile": "full-parity-v1",
  "capabilityHash": "sha256:...",
  "commandManifestHash": "sha256:...",
  "platform": "win32-x64",
  "entrypoint": "omp.exe"
}
```

激活只修改 `current.json`，不覆盖旧目录。下载、解压、自检均在新目录完成。

## 7. Thread binding

Runtime 解析只在新建/显式恢复 Thread 时发生。Thread 一旦启动：

- 绑定 runtimeVersion、executable identity 和 runtimeEpoch；
- 不跟随 global default 热切换；
- Runtime 更新不会替换该 Thread 的进程；
- 删除 Runtime 前检查所有 binding；
- System OMP 被包管理器替换后，旧 Thread 必须重新 probe/rebind，不能假设二进制未变。

## 8. 失败处理

| 失败 | 结果 |
|---|---|
| Managed 签名错误 | Rejected，保留当前版本 |
| Studio Hello 超时 | Limited 或 Rejected，取决于用户是否允许 Limited |
| Capability 缺失 | Limited，显示精确缺失项 |
| Manifest hash 漂移 | 重新 fetch/probe；Managed 构建视为损坏 |
| 自检进程 crash | Rejected |
| 用户强制 System 且不允许 Limited | 阻止创建 Thread并建议切换 Managed |

