# 执行计划 01：Desktop / Host 生产基线闭环

> 可并行：可与计划 02 同时开始
> 目标：在不依赖 transcript UI 的前提下，证明生产 Desktop 能启动真实 OMP Runtime、向 Renderer 发布真 manifest/snapshot，并完成一次 `core.prompt`。
> 文件 owner：`apps/desktop/**`；如确有必要可修改 `packages/studio-host/src/bridge-client.ts` 及其测试。不要修改 conversation contract、Renderer 或 vendor。

## 1. 开工检查

1. 阅读：
   - `apps/desktop/package.json`
   - `apps/desktop/src/runtime-session.ts`
   - `apps/desktop/src/host-factory.ts`
   - `apps/desktop/src/host-composition.ts`
   - `packages/studio-host/src/bridge-client.ts`
   - 对应 desktop/studio-host tests
2. 运行 `git status --short`，确认这些文件已有用户改动；不得覆盖。
3. 修改前建立规范备份，例如 `backup/2026-08-15/real-conversation-p01-HHmmss/`。
4. 先跑相关基线：

```bash
npm run typecheck -w @omp-studio/desktop
npm test -w @omp-studio/desktop
npm test -w @omp-studio/studio-host
```

若基线已有失败，记录在备份 README 或执行报告中，不得通过删除断言掩盖。

## 2. P0-1：修复 persisted workspace 的 Runtime 启动

### 当前问题

`DesktopRuntimeSession` 内部 workspace 初始为空；`start()` 在 workspace 为空时返回 undefined。生产 factory 虽恢复 `workspaceCwd`，却没有把 active workspace 注入 runtime session。重新打开同一个 active workspace又可能被 adapter 视为 no-op。

### 实现要求

1. 为 Runtime session 定义单一、明确的 workspace activation API。优先复用已有 `rebindWorkspace` 或为 `start()` 增加已解析 workspace 参数，不要再维护第二份 cwd 真相。
2. Host factory 在首次 `start()` 前，把 registry 中 active workspace 的 ID/路径送入 Runtime session。
3. 以下路径行为一致：
   - clean start + 已有 active workspace；
   - clean start + 无 workspace；
   - 首次选择 workspace；
   - 重复选择当前 workspace；
   - 从 workspace A 切换到 B；
   - workspace 已不存在或无权限。
4. 无 workspace 时保持诚实 read-only；不能偷偷使用 `process.cwd()` 作为项目。
5. 失败必须更新可观察 runtime connection/diagnostic，不能只打印日志。

### 先写测试

- persisted active workspace 在 composition 创建时启动一次 Runtime。
- 无 active workspace 不启动。
- 选择当前 workspace 在 Runtime 尚未启动时不得被 no-op 吞掉。
- A→B 导致旧 session 安全关闭并新 session 绑定 B。
- 无效路径不会启动到错误 cwd。

## 3. P0-2：把真实 Runtime manifests 接给 Facade

### 当前问题

Bridge hello 已带 `capabilityManifest` 和 `commandManifestHash`，Bridge 也能执行 `operator.manifest.get`；生产 composition 却给 Facade `undefined` provider，最终回退 neutral empty manifest，导致 Renderer 的 capability gate 禁用 `core.prompt`。

### 实现要求

1. `DesktopRuntimeSession` 在已认证 hello 后保存并只读暴露：
   - 已验证 `CapabilityManifest`
   - `commandManifestHash`
   - 通过 `bridge.requestCommandManifest()` 获取并验证 hash/upstream commit 的 `OperatorCommandManifest`
2. Facade 的 `capabilityManifest` 和 `commandManifest` provider 从当前 `sessionRef` 动态读取，不能在 composition 构造时捕获旧 session。
3. Runtime 未连接时才返回 neutral manifest；Runtime 已连接但 manifest 拉取失败时应降级并给 diagnostic，不可把假 full capability 暴露给 Renderer。
4. runtime epoch/rebind 后清空旧 cache并重新验证，禁止沿用上一 Runtime manifest。
5. 不把 Bridge token、endpoint、PID 等带入 public bootstrap。

### 测试

- Runtime ready 时 bootstrap 的 capability manifest 包含 `core.prompt`，hash 与 hello 一致。
- `commands.getManifest` 返回 Runtime 的完整 manifest，hash 一致。
- Runtime 不可用时仍是 neutral/limited。
- rebind 到不同 epoch 后不复用旧 manifest。
- manifest hash 不匹配时 fail closed。

## 4. P0-3：统一 Runtime publication forwarder

### 当前问题

composition 创建闭包中的 `publicationListeners` 与 `DesktopHostCompositionImpl.#publicationListeners` 是两个 Set。Facade 订阅前者，session attach 发布到后者，导致 prompt 后 snapshot/state 更新不能可靠到达 Facade。

### 实现要求

1. 只保留一个 publication channel，生命周期归 `DesktopHostCompositionImpl` 或一个显式 forwarder 对象管理。
2. `FacadeContext.publications.subscribe` 必须订阅同一 channel。
3. `#attachSession()`：
   - 先取消旧 session listener；
   - 绑定新 session；
   - 重放新 session 当前 publication 一次；
   - 不重放旧 session publication。
4. `reload()` 创建新 Facade 后，新 Facade 立即收到当前 publication；不能要求 Runtime 再变化一次。
5. `rebindWorkspace()`/runtime loss/close 时取消正确 listener，避免重复发布和内存泄漏。
6. listener 异常需要隔离；一个 UI consumer 抛错不能破坏 Bridge socket 处理。

### 测试

- `stateVersion` 增长后 Facade 发 `state.changed`。
- prompt 开始/结束时 `isStreaming` 可通过 `session.state` 或 snapshot 观察。
- reload 后只收到一次当前 publication。
- rebind 后旧 session 的迟到 publication 被忽略。
- subscriber 抛异常不会阻断其他 subscriber。

## 5. P0-4：处理 Host accepted 与 Runtime terminal receipt

该计划不改 Renderer，但要确保底层 receipt 可观察、相关性正确：

1. 对一次 `core.prompt`，验证 provisional requestId → Runtime commandId 的 ledger rebind。
2. accepted 不能被当 terminal completed。
3. completed/failed/rejected/outcome_unknown 均必须通过 Facade client event 到达现有 reducer。
4. Runtime loss 时未决命令进入 outcome_unknown。
5. 不重复发 terminal receipt。

如果现有代码已满足，只补覆盖生产 composition 的测试，不做无关重构。

## 6. Clean install 的边界

`runtime.install` seam 缺失会让全新机器无法自举。该项可以作为本计划 P1，不能为了对话 MVP 扩大成完整安装器重写：

- 若项目已有 runtime installer service，正确注入 composition并补一个 smoke test。
- 若需要产品决策或大范围 UI，记录为 blocker，MVP 验收环境明确要求“已有受信 managed/compatible Runtime”。
- 不伪造 ready 状态。

## 7. 贯通测试

新增一条不依赖 Renderer 的 Desktop composition 集成测试：

1. 伪 Runtime hello 返回 `core.prompt` capability 和 command manifest。
2. composition bootstrap 得到真 manifest 和初始 snapshot。
3. 发出 `core.prompt`。
4. 收到 accepted。
5. Runtime publication 依次将 `isStreaming` 变为 true/false。
6. 收到 completed receipt。

有真 Runtime fixture 时再增加一条脚本级 smoke；测试不得调用用户真实 OMP 配置或写项目文件。

## 8. 验收命令

```bash
npm run typecheck -w @omp-studio/studio-host
npm test -w @omp-studio/studio-host
npm run typecheck -w @omp-studio/desktop
npm test -w @omp-studio/desktop
npm run build -w @omp-studio/client-contract
npm run typecheck -w @omp-studio/renderer
```

## 9. 完成条件

- [ ] persisted workspace 能启动 Runtime。
- [ ] Runtime manifest 进入 Facade/bootstrap/query。
- [ ] Renderer 所依赖的 `core.prompt` capability 为真。
- [ ] publication 使用单一 forwarder。
- [ ] prompt 的 accepted、streaming snapshot、terminal receipt 全可观察。
- [ ] reload/rebind 不重放旧 session。
- [ ] 未修改 preview、conversation contract 或无关 UI。
- [ ] 交付报告列出测试结果、备份路径和仍存在的 clean-install 限制。
