# OMP Studio 前端接入实施文档

> 状态：实施基线草案
>
> 当前交付平台：Windows Desktop + 本机 WebUI
>
> 延后平台：macOS Desktop
>
> 最后更新：2026-08-12

## 1. 文档目的

本文定义 OMP Studio 从现有后端基础接入产品前端的实施边界、目录结构、接口、阶段门、验收标准和平台约束。

当前阶段优先完成 Windows：

- Windows 桌面应用 `omp-studio.exe`；
- 由用户显式启用的本机 WebUI；
- 共用一套 Renderer、状态模型和语义 API；
- macOS 暂不开发、不进入当前发布门，但代码不得形成只能重写才能迁移的 Windows 耦合。

本文不是页面视觉规格。现有 [`ui_reference/ver1`](./ui_reference/ver1/) 继续作为布局、交互和视觉参考，真实产品前端应通过类型化 Client API 取代其中的 `window.OMP_DATA` mock。

## 2. 当前仓库事实

现有基础已经提供：

- [`packages/studio-protocol`](./packages/studio-protocol/)：权威协议类型、严格校验、canonical JSON 和长度前缀帧；
- [`packages/studio-host`](./packages/studio-host/)：Runtime 解析与生命周期、Bridge client、状态投影、命令账本、交互所有权、PTY ticket、Session catalog；
- [`packages/runtime-installer`](./packages/runtime-installer/)：签名校验、版本安装、激活、回滚和保留策略；
- [`omp-patch`](./omp-patch/)：固定上游 OMP 及 Studio Runtime patch；
- [`ui_reference/ver1`](./ui_reference/ver1/)：原生 JavaScript SPA 原型，当前完全由 mock 数据驱动。

当前缺少：

- 桌面壳、preload 和 Renderer 工程；
- 面向产品客户端的 Host API；
- Desktop IPC 传输；
- WebUI HTTP/WebSocket 传输及浏览器认证；
- 前端状态归约、重连和快照恢复；
- Windows 桌面打包、安装和端到端测试。

现有后端约束以 [`BACKEND_FOUNDATION.md`](./BACKEND_FOUNDATION.md) 为准，前端接入不得改变以下事实：

1. Renderer 只能调用 Host 语义 API，不能直接连接 OMP Runtime Bridge。
2. Renderer 永远不能获得 Bridge token、进程句柄或 OMP session 真实路径。
3. `accepted` 只表示请求被接受，不表示执行成功。
4. 只有 terminal receipt 才能提交最终结果。
5. Runtime 丢失后必须隔离旧 `runtimeEpoch`，未决请求显示为 `outcome_unknown`。
6. PTY 字节流不能作为业务成功或状态变更的语义来源。
7. 未知 mutation 必须 fail closed。

## 3. 本期范围

### 3.1 必须交付

- Windows x64 桌面应用；
- 本机 WebUI，默认关闭，仅绑定 loopback；
- Runtime 检测、安装状态、能力和诊断页面；
- Session 历史和基础 Thread 入口；
- Workbench 核心会话：prompt、steer、follow-up、abort；
- queue、retry、pause/resume；
- 流式消息、快照恢复、断线重连和 terminal receipt 展示；
- Plan/Goal/Loop 等能力按 Runtime manifest 渐进接入；
- Agent Hub 和 Jobs 按能力门渐进接入；
- Windows 打包、安装、升级和回滚验证。

### 3.2 暂不承诺

- macOS 可运行安装包；
- 远程公网 WebUI；
- 多用户协作服务；
- Live 音频完整链路；
- 未通过 capability manifest 声明的功能；
- 通过解析 TUI/PTY 文本模拟结构化能力。

### 3.3 WebUI 定义

本期 WebUI 是“本机 WebUI”：

- 仅在用户显式执行 serve/enable 操作后启动；
- 只绑定 `127.0.0.1` 和 `::1`；
- 通过一次性配对码换取短期浏览器 session；
- HTTP 承载 query/command，WebSocket 承载事件和流；
- 停止 Web listener 只撤销 Web session，不停止 Host 和 Runtime；
- 禁止以端口可达、loopback 来源或 `/health` 成功作为授权依据。

局域网或公网访问必须作为独立安全里程碑，加入 TLS、登录、授权范围、审计和速率限制后才可开放。

## 4. 技术基线

本实施文档采用以下默认选型：

- Renderer：React + TypeScript；
- 构建：Vite；
- Desktop：Electron；
- Desktop 通信：窄类型 preload API + Electron IPC；
- Web 通信：loopback HTTP + WebSocket；
- 协议类型：直接复用 `@omp-studio/studio-protocol`；
- 测试：Node test 保留，新增 Vitest/React Testing Library 和 Playwright E2E；
- 包管理：沿用 npm workspaces。

P0 结束前可以更换 UI 框架，但不得改变 Host 权威、共享 Client contract 和双传输结构。不得让 React 组件直接调用 Electron、WebSocket 或 Node API。

## 5. 目标架构

```text
Shared Renderer
  React pages / components / view state
              |
              v
  @omp-studio/client (semantic client interface)
              |
       +------+------+
       |             |
       v             v
Desktop adapter    Web adapter
preload IPC        HTTP + WebSocket
       |             |
       +------+------+
              v
       Studio Host API
 command / query / subscription / stream
              |
              v
 Existing studio-host composition
 Runtime actor / bridge / ledger / projection
              |
              v
          omp Runtime
```

### 5.1 权威边界

Host 是唯一业务权威。Electron Main 只负责：

- 窗口和系统生命周期；
- 启动或连接 Host；
- 持有私有 Host client session；
- 将 preload 的白名单语义请求代理到 Host；
- Windows 原生能力和权限适配。

Renderer 只负责：

- 展示 Host read model；
- 维护路由、选中项、布局、草稿等临时 UI 状态；
- 发出类型化意图；
- 根据 snapshot、receipt、event 和 capability manifest 更新界面。

Renderer 不负责：

- 发现或启动 `omp.exe`；
- 生成 Bridge token；
- 读取 OMP session/config 文件；
- 决定 Runtime fallback 路径；
- 推断命令已经成功；
- 执行 Git、PTY、文件或进程操作。

## 6. 推荐目录结构

```text
apps/
  desktop/
    main/                 # Electron Main，仅 OS/窗口/Host 连接
    preload/              # 白名单、类型化 Renderer API
    resources/            # Windows 图标、manifest、打包资源
    package.json
  web/
    src/                  # Web 入口、配对和 Web transport bootstrap
    package.json
  renderer/
    src/
      app/
      pages/
      components/
      features/
      state/
      styles/
    package.json

packages/
  studio-protocol/        # 已有；Runtime Bridge 权威 contract
  studio-host/            # 已有；Host/Runtime 组合
  runtime-installer/      # 已有
  client-contract/        # 产品客户端语义 API 和 read models
  client/                 # 平台无关 client、reducer、重连逻辑
  transport-desktop/      # Electron Main/preload 两侧适配
  transport-web/          # HTTP/WS server 与 browser adapter
  platform/               # PlatformPort 接口与平台无关策略
  platform-win32/         # Windows ACL、Job Object、路径、打包实现
  testkit/                # fake Host、transport contract fixtures
```

`apps/renderer` 必须能在没有 Electron 全局对象的浏览器环境运行。桌面能力通过 `ClientTransport` 注入，不能用 `process.platform`、`require("electron")` 或 `window.electron` 散落在业务组件中。

## 7. 跨平台保留策略

macOS 本期不实现，但以下约束从第一阶段即为强制要求。

### 7.1 平台接口

所有 OS 差异集中在 `PlatformPort`：

```ts
export interface PlatformPort {
  readonly platform: "win32" | "darwin";
  appDataDirectory(): Promise<string>;
  runtimeExecutableName(): string;
  createPrivateEndpoint(profileDirectory: string): Promise<PrivateEndpoint>;
  createProcessContainment(): RuntimeContainmentPort;
  revealPath(handle: ResourceHandle): Promise<void>;
  openExternal(url: string): Promise<void>;
}
```

当前只实现 `Win32PlatformPort`。以后增加 `DarwinPlatformPort` 时，Renderer、Client API 和 Host domain service 不应修改。

### 7.2 禁止项

- 业务代码硬编码 `C:\\`、反斜杠或 `.exe`；
- Renderer 展示或持久化绝对路径；
- 在共享代码中直接调用 `icacls.exe`、`whoami.exe` 或 Job Object；
- 把 Windows Named Pipe 名称当作公共 client contract；
- 将打包格式、签名方式写进 Runtime/Host 业务逻辑；
- 依赖文件名大小写不敏感；
- 使用只有 Windows 支持的快捷键作为唯一操作入口。

### 7.3 macOS 后续适配点

后续 macOS 工作应只新增或替换：

- `DarwinPlatformPort`；
- Unix-domain socket 和 `0600/0700` 权限实现；
- macOS Runtime artifact（x64/arm64）；
- process group/信号式 containment；
- `.app`/DMG、codesign、notarization 和 entitlements；
- Keychain/权限提示等原生集成；
- macOS 平台 E2E runner。

## 8. Client contract

Renderer 不直接复用低层 `StudioBridgeClient`。应定义稳定的产品 Client 接口，并由 Desktop/Web adapter 分别实现。

建议最小接口：

```ts
export interface StudioClient {
  bootstrap(): Promise<ClientBootstrap>;
  query<TName extends QueryName>(
    name: TName,
    input: QueryInput<TName>,
  ): Promise<QueryResult<TName>>;
  command<TName extends CommandName>(
    name: TName,
    input: CommandInput<TName>,
  ): Promise<CommandHandle>;
  subscribe(
    scope: SubscriptionScope,
    listener: (event: ClientEvent) => void,
  ): Unsubscribe;
  close(): Promise<void>;
}
```

### 8.1 Bootstrap 输出

`ClientBootstrap` 至少包含：

- client contract version；
- Host authority identity/epoch 的公开部分；
- Runtime 连接状态和分类；
- capability manifest；
- command manifest hash；
- 当前 Thread/Session 的不透明 ID；
- 初始 read model snapshot；
- Web/Desktop 的 surface capability，例如 `terminalAttach`、`fileReveal`。

不得包含：

- Bridge token/token file；
- Host 私有 endpoint；
- Runtime PID/process handle；
- OMP session 文件路径；
- provider secret 或原始环境变量。

### 8.2 Command 生命周期

前端必须按以下状态展示 mutation：

```text
local_pending
  -> accepted
  -> interaction_required (可选)
  -> completed | failed | rejected | outcome_unknown
```

规则：

- 按钮点击后不能立即显示“成功”；
- `accepted` 只能显示“已接受/执行中”；
- `outcome_unknown` 必须单独展示，不能自动重试有外部副作用的操作；
- `runtimeEpoch`、`stateVersion` 或 generation 冲突应请求快照并让用户重新确认；
- destructive command 必须由 Host 签发、消费一次性 confirmation；
- 相同 idempotency key 只能对应相同语义输入。

### 8.3 事件和恢复

Client reducer 必须：

1. bootstrap/重连后先取得 snapshot；
2. 记录 authority/runtime epoch、state version、event/commit cursor；
3. 忽略旧 epoch 事件；
4. 对重复事件保持幂等；
5. 发现序号缺口立即进入 `resync_required`；
6. resync 完成前禁止依赖陈旧状态发出敏感 mutation；
7. 将 terminal receipts 与当前 snapshot 对账；
8. 浏览器刷新或 Renderer reload 不得停止 Runtime。

## 9. Desktop IPC

### 9.1 Preload API

preload 只暴露明确方法，不得暴露通用 `invoke(channel, payload)`：

```ts
export interface OmpStudioDesktopApi {
  bootstrap(): Promise<ClientBootstrap>;
  query(request: ClientQueryRequest): Promise<ClientQueryResponse>;
  command(request: ClientCommandRequest): Promise<ClientCommandAccepted>;
  subscribe(listener: (event: ClientEvent) => void): () => void;
  getSurfaceCapabilities(): Promise<SurfaceCapabilities>;
}
```

Electron 安全基线：

- `contextIsolation: true`；
- `nodeIntegration: false`；
- Renderer sandbox 开启；
- CSP 禁止 `unsafe-eval`；
- 禁止任意导航和未授权新窗口；
- 所有 IPC payload 在 Main 边界执行严格 schema validation；
- Main 根据窗口绑定 client identity，不信任 Renderer 自报 scope；
- Preview WebContents 不加载 Studio preload。

### 9.2 Windows Host/Runtime 启动

Windows 启动顺序：

```text
Electron Main
  -> 获取当前用户 profile/state 目录
  -> 获取单实例/Host authority lock
  -> 初始化 HostBackend
  -> 解析或安装受信 Runtime
  -> 创建 current-user-only Named Pipe/bootstrap token
  -> 启动 omp.exe studio-host
  -> hello + challenge proof
  -> snapshot
  -> 建立 renderer client session
  -> 创建 BrowserWindow
```

失败时必须停在可信状态：

- Runtime 不受信：进入环境检查，不执行它；
- Host/Runtime 未 ready：不打开可写 Workbench；
- manifest/hash 不匹配：拒绝 Full 能力并给出诊断；
- 已有 Host authority：连接现有 authority 或明确失败，不能启动第二个 owner；
- Renderer 崩溃：保持 Host/Runtime，允许重新加载；
- Main 退出：先请求优雅关闭，再使用 Windows containment 清理残留进程。

## 10. Web transport

Host Web adapter 至少提供：

```text
POST /api/v1/pair
POST /api/v1/query
POST /api/v1/command
POST /api/v1/session/revoke
GET  /api/v1/bootstrap
GET  /api/v1/events       (WebSocket upgrade)
GET  /health              (无敏感细节)
```

具体 URL 可以调整，但 Desktop 和 Web 必须映射到同一 Client contract，而不是实现两套业务 API。

Web 安全要求：

- 精确 Origin allowlist；
- pairing code 短期、一次性；
- session cookie 使用 HttpOnly、SameSite=Strict；
- mutation 需要 CSRF 防护；
- WebSocket 建连时校验 Origin、session 和 scope；
- 每 client 限制 outstanding command、帧大小和事件队列；
- 慢消费者断开并要求 snapshot/resync；
- secret、绝对路径、token 和进程信息不得进入响应、URL、日志；
- 默认不开 Terminal、Preview 输入和任意文件操作，必须按 surface grant 开放。

## 11. 前端状态组织

建议拆为四类状态：

1. `connection`：Host/Runtime 状态、epoch、cursor、重连和 resync；
2. `entities`：由 Host snapshot/read model 驱动的 Thread、message、agent、job；
3. `commands`：request/command receipt 生命周期和 interaction；
4. `ui`：路由、面板、主题、草稿、选中项、尺寸。

只有第 4 类可以完全由 Renderer 持有。前 3 类必须能由 Host snapshot 重建。

禁止以 localStorage 保存：

- Host/Bridge token；
- approval/confirmation token；
- 绝对 session/workspace 路径；
- provider secret；
- 可跨 Runtime epoch 重放的 mutation payload。

## 12. 页面接入顺序

### 12.1 第一批：只读地基

| 页面 | 数据来源 | 目标 |
|---|---|---|
| 环境检查 | Runtime resolver/installer/self-check | 显示安装、签名、版本、平台和可运行状态 |
| 能力中心 | capability/command manifest | 显示 stable/limited/unavailable 及证据 |
| 诊断中心 | Host/Runtime structured diagnostics | 提供可复制、已脱敏的诊断 |
| 会话历史 | SessionCatalog + Studio Thread metadata | 只暴露 opaque ID 和安全摘要 |
| 项目主页 | Host read model | 展示最近 Thread 和 Runtime 状态 |

完成后，对应页面不得再读取 `OMP_DATA`。

### 12.2 第二批：Workbench 核心切片

接入：

- snapshot 和 transcript cursor；
- prompt/steer/follow-up/abort；
- streaming 状态和增量内容；
- queue、retry、pause/resume；
- accepted/terminal receipt；
- offline/reconnecting/stale/resync/outcome_unknown UI；
- 长 transcript 虚拟化。

### 12.3 第三批：模式与交互

- Plan/Plan Review；
- Goal/Vibe/Loop；
- Session tree/fork；
- confirm/select/input/editor/approval；
- GUI 与 TUI interaction transfer；
- manifest 驱动的 generic command form。

### 12.4 第四批：Agent Hub 和 Jobs

- agent list/transcript；
- send/spawn；
- kill/revive/release；
- job list/get/cancel/subscribe；
- generation conflict、advisor read-only 和 owner scope。

### 12.5 最后接入

- Terminal/PTY；
- Preview；
- 配置持久化；
- Live audio sideband。

这些能力涉及 OS 权限、XSS/RCE 边界、secret 和平台差异，不能与普通页面数据替换混为一个阶段。

## 13. 分阶段实施与 Gate

### P0：契约与骨架

工作：

- 新建 apps/packages 前端目录；
- 建立 React/Vite/TypeScript 基线；
- 定义 Client contract、read model 和 transport contract；
- 建立 `PlatformPort` 与 `Win32PlatformPort`；
- 将 ver1 页面列为迁移清单，标记 mock 字段来源。

Gate：

- Renderer 可在纯浏览器测试环境启动；
- Renderer 无 Node/Electron 直接依赖；
- Desktop/Web adapter 通过同一 contract test；
- 共享代码中无 Windows 路径和 `.exe` 硬编码。

### P1：Host Client API 与 Windows Desktop

工作：

- 组合 `HostBackend`、Runtime actor/session controller；
- 实现 query/command/subscription；
- 实现 Electron Main/preload；
- 完成 Windows authority、Named Pipe 和 ACL 流程；
- 打通 bootstrap、snapshot 和环境检查页。

Gate：

- Windows 非管理员账户可启动；
- Renderer 无法获得 Bridge token/path/PID；
- 第二实例不能成为同一 Environment 的第二 owner；
- Renderer reload 不杀 Runtime；
- `npm run check` 和新增 Desktop contract tests 通过。

### P2：本机 WebUI

工作：

- 实现 loopback HTTP/WS adapter；
- 实现 pairing、session、Origin/CSRF 和 revoke；
- Web 入口复用共享 Renderer；
- 建立 Desktop/Web transport parity tests。

Gate：

- 默认无监听端口；
- 不绑定 `0.0.0.0`；
- 未配对浏览器不能读取资源存在性；
- 停止 listener 不影响 Host/Runtime；
- Desktop 与 Web 对相同 fixture 得到相同 read model/receipt。

### P3：只读页面和核心 Workbench

工作：

- 依次替换环境、能力、诊断、历史、主页 mock；
- 打通核心对话和恢复状态机；
- 加 transcript 虚拟化及流式性能测试。

Gate：

- 核心页面无对应 `OMP_DATA` 依赖；
- event gap 触发 resync；
- Runtime crash 后未决 accepted command 变为 `outcome_unknown`；
- 乱序/重复事件不产生重复消息或重复成功提示；
- Windows Desktop 与 WebUI 完成同一核心旅程。

### P4：模式、交互、Agent 和 Jobs

工作按第 12 节顺序进行，每项由 capability manifest 单独放行。

Gate：

- stale interaction/generation 被拒绝；
- destructive operation 有一次性确认；
- advisor mutation 被拒绝；
- Runtime Limited 时 UI 明确禁用并解释原因；
- TUI/GUI 使用相同 Runtime primitive 和 postcondition。

### P5：高风险能力与 Windows 发布

工作：

- PTY/Terminal 独立 stream；
- Windows 安装包、升级和卸载；
- Runtime artifact 签名和打包；
- 崩溃恢复、安全和性能 E2E；
- 形成 macOS readiness 报告。

Gate：

- PTY ticket 过期、重放和越权测试通过；
- 生产包不含测试 Runtime 和私钥；
- 安装、升级、回滚、卸载不破坏受引用 Runtime；
- Windows 签名产物通过干净机器 E2E；
- 第 16 节 macOS readiness checklist 全部满足后，才允许宣布“可快速适配 macOS”。

## 14. 测试策略

### 14.1 单元测试

- Client reducer：epoch、cursor、duplicate、gap、resync；
- command 状态机：accepted、interaction、terminal、unknown；
- capability routing 和 disabled reason；
- PlatformPort contract；
- IPC/HTTP payload validation；
- secret/path redaction。

### 14.2 Contract tests

同一测试集必须分别运行：

- in-memory transport；
- Electron IPC adapter；
- HTTP/WebSocket adapter。

测试断言的是语义结果，不是底层 channel 名称或 URL。

### 14.3 E2E

Windows 首期至少覆盖：

1. 首次启动，无 Runtime；
2. 安装/发现 Runtime；
3. 创建或恢复 Thread；
4. 发送 prompt 并收到 terminal outcome；
5. streaming 时 steer/abort；
6. pause/resume；
7. Renderer reload 后恢复；
8. Runtime crash 后显示 `outcome_unknown`；
9. WebUI 配对、操作、刷新和撤销；
10. 安装包升级与 Runtime 回滚。

### 14.4 安全测试

- Renderer 尝试调用未暴露 IPC；
- schema pollution/unknown fields；
- 恶意 Markdown/XSS 触发 mutation；
- Web Origin/CSRF/session replay；
- token/path/secret 日志扫描；
- stale epoch/generation/interaction replay；
- oversized frame 和慢消费者；
- PTY ticket 重放和跨 scope 使用。

## 15. CI 与发布

Windows 主线 CI 建议：

```text
lint/typecheck
  -> protocol/host/installer tests
  -> client + transport contract tests
  -> renderer unit/component tests
  -> build Host + Runtime artifact
  -> verify manifest/signature/hash
  -> package Windows Desktop
  -> Windows clean-run E2E
  -> WebUI E2E
  -> security smoke
```

当前开发构建可以使用非生产测试签名链，但生产发布：

- 必须使用发布 Ed25519 私钥重新生成 Runtime artifact；
- 私钥不得进入仓库、Renderer、日志或安装包；
- 刚构建的 `omp.exe` 必须通过 manifest、snapshot 和 graceful shutdown probe；
- `omp-studio.exe` 与 `omp.exe` 保持不同产物身份；
- 测试 Runtime 不得被打包或标记 Full Parity。

## 16. macOS Readiness Checklist

本期不要求 macOS 运行，但 Windows 发布前应检查：

- [ ] Renderer 可在普通浏览器环境独立运行；
- [ ] Client contract 不包含 Named Pipe、SID、Job Object 或 `.exe`；
- [ ] 所有绝对路径只存在于 Host/platform 实现；
- [ ] Runtime 名称由 `PlatformPort.runtimeExecutableName()` 提供；
- [ ] 私有 endpoint 创建走平台接口；
- [ ] containment 通过 `RuntimeContainmentPort` 注入；
- [ ] 安装 manifest 使用 `platform-arch`，不假定 `win32-x64`；
- [ ] artifact 下载/激活逻辑不依赖 MSI/EXE；
- [ ] 路径测试包含 `/Users/...`、空格、Unicode 和大小写敏感场景；
- [ ] 快捷键通过 command mapping，不把 Ctrl 作为唯一入口；
- [ ] Desktop/Web 业务代码不导入 `platform-win32`；
- [ ] 打包/签名是独立 pipeline stage；
- [ ] CI 配置预留 `darwin-x64` 和 `darwin-arm64` matrix；
- [ ] macOS 待办只涉及平台实现、Runtime artifact、签名公证和 E2E，不要求重写 Renderer/Host API。

若任何一项不满足，应记录为跨平台架构债务，不能以“以后简单改一下”关闭。

## 17. 完成定义

Windows 前端接入只有同时满足以下条件才算完成：

- Windows Desktop 和本机 WebUI 共用 Renderer 与 Client contract；
- Renderer 无法直接访问 Runtime Bridge 和敏感 Host 资源；
- 核心页面已移除对应 mock 数据依赖；
- command、receipt、snapshot、event、reconnect 和 resync 行为可验证；
- Limited/Unavailable 能力诚实降级；
- 安全关键测试无失败；
- Windows 安装、启动、升级、回滚和卸载通过；
- 生产 Runtime artifact 的签名、hash 和 live probe 通过；
- macOS readiness checklist 已审核，无必须重写共享层的阻塞项。

## 18. 第一轮建议工单

1. `FE-001`：创建 `apps/renderer` React/Vite workspace；
2. `FE-002`：定义 `packages/client-contract`；
3. `FE-003`：实现 Client reducer 和 in-memory contract test；
4. `FE-004`：定义 `PlatformPort` 和 Windows 实现；
5. `FE-005`：建立 Host query/command/subscription facade；
6. `FE-006`：创建 Electron Main/preload 安全基线；
7. `FE-007`：打通 Desktop bootstrap/snapshot vertical slice；
8. `FE-008`：接入环境检查页，移除对应 mock；
9. `FE-009`：实现 loopback Web adapter 与 pairing；
10. `FE-010`：建立 Desktop/Web transport parity E2E。

第一轮完成后再拆 Workbench 和 Agent Hub 工单，避免在 Client/Host 边界尚未稳定时并行改造大量页面。

## 19. 实施记录：ver1 Workbench 迁移（2026-08-12）

本节是已落地实现的状态记录，不修改上文架构与计划章节。

### 19.1 已实现的共享 Renderer 表面

- React/Electron 共享 Renderer 已提供 ver1 Workbench chrome：`app-shell`、`sidebar`（品牌、项目与会话导航、新建对话、Runtime 状态）、`topbar`（面包屑、Runtime 状态、client contract 版本）、`workbench-shell` 主列（`convo-wrap`/`convo-scroll`/`convo-doc` 对话区、`minimap-rail`、`composer-region`、`ctx-strip`/`run-strip`）、`side-panel`、`bottom-panel`。
- 路由仍为 `home | history | workbench`，无 router 依赖；bootstrap/query/subscription/reducer/Home/History 既有流程保持不变。
- Renderer 仍由 StudioClient 驱动，无 Electron/Node 直接依赖。
- 视觉基线：ver1 浅色中性表面、`#6e56cf` 强调色、272px 侧栏、44–48px topbar、文档最大宽度 768px、扁平边框与焦点微光；`<=900px` 时侧栏收窄、隐藏次要 explorer、side panel 隐藏，无横向溢出，composer 保持可用。
- 侧栏折叠开关（sidebar 顶部与 topbar 菜单按钮，含 `aria-expanded`）与跳转对话区的 skip link（`#convoScroll`）可用。

### 19.2 Composer 语义命令

已接线且唯一允许的 composer mutation：

```text
core.prompt({ text })
core.steer({ text })
core.followUp({ text })
queue.enqueue({ text })
core.abort({})
runtime.pause({})
runtime.resume({ expectedPauseEpoch })
turn.retry({})
```

`interaction.respond` 保持可用，用于 confirm/select/input 类交互。命令均为异步接受，绝不乐观声称完成。

Enter 发送带 IME 组合防护：组合输入中的 Enter 不触发发送；仅在可发送时拦截 Enter（被门控时 Enter 正常换行），Shift+Enter 始终换行。命令仅在被接受后清空输入框，被拒绝或发送失败时保留输入文本。

### 19.3 生命周期与门控

- 生命周期：`local_pending -> accepted -> (interaction_required) -> completed | failed | rejected | outcome_unknown`；`accepted` 只表示已接受，terminal receipt 才是完成证据。
- busy、`resyncRequired` 或 Runtime 不可用时，敏感 mutation 一律禁用；resync 横幅展示期间同样禁止。
- Plan/Goal/Loop/Session tree 等高级控制按 capability manifest 门控，Runtime Limited 时明确禁用并说明原因。
- composer 与命令条的每条 mutation 按 capability manifest 逐命令门控：manifest 缺失 entry 或 grade `unavailable` 一律禁用，Runtime `limited-system` 分类下禁用；`interaction.respond` 的响应控件（含 Cancel）在 busy / resync / runtime 不可用 / 无 capability 时同样禁用。

### 19.4 Transcript 边界与无 mock 内容

- 虚拟化语义 ClientEvent 渲染在底部 Activity 面板；对话 transcript 区只显示不可用空态或 interaction 提示，绝不虚构消息内容。当前 Host contract 未暴露 message transcript，因此不做任何回填或模拟对话。
- ver1 的 `OMP_DATA`/`mock-data.js` 未迁入 Renderer；缺少对应 read model 的 surface（文件树、Git 状态、Preview、telemetry、绝对路径）一律不展示。

### 19.5 暂缓与诚实禁用壳

- 未接入的 capability surface 以禁用态壳呈现并附原因说明。视觉存在永远不等于 Host 能力存在，也不构成对 ver1 或任何 Host 能力的 Full Parity 声明。

### 19.6 验证与验收

- 命令：`npm run typecheck -w @omp-studio/renderer`、`npm run build -w @omp-studio/renderer`（完整门为根目录 `npm run check`）。
- 验收：workbench 路由可见完整 ver1 chrome 且 composer 可输入；unsupported surface 为诚实禁用壳；本文档记录迁移与暂缓范围。
