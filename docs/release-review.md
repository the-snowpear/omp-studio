# 发布前审查与历史故障防坑指南

准备桌面版（`v<version>`）或独立 Runtime（`runtime-v<Runtime version>`）发版、编写发布前审查记录（`docs/reviews/*-release-review.md`），或改动发布工作流与打包/更新脚本时，**必须在审查开始时读取本文档**，并配合 [`releasing.md`](releasing.md) 执行。

- 流水线机制、缓存作用域、构建产物表与密钥轮换见 [`releasing.md`](releasing.md) 与 [`release-operations.md`](release-operations.md)。
- 本文档聚焦 **`v0.1.4`–`v0.2.2` 真实 GitHub Actions 发布事故复盘**与**每次发布审查必查的硬防线**，避免在 20～50 分钟的跨平台原生构建末尾重复踩坑，或把「Actions 全绿但安装包带病」的回归放到线上。

---

## 一、历史发布盘点与核心规律（`v0.1.4`–`v0.2.2`）

自 `v0.1.4`（2026-09-06 首次接入自动化 [`release.yml`](../.github/workflows/release.yml)）至 `v0.2.2`（2026-11-16），仓库共发布 **18 个正式 Tag**，累计触发 **39 次 Release 运行**（含早期归档的 2 次失败记录）：

- **一次跑通**：16 次；**单 Job 重试后跑通（`attempt=2`）**：1 次（`v0.2.2`）。
- **直接失败（`failure`）**：9 次；另有 1 次 `Warm release caches` 在 `npm ci` 秒挂。
- **手动取消（`cancelled`）**：13 次——其中 **7 次实质是单平台先失败后的人工止损**（因矩阵 `fail-fast: false`，某一平台报错后为避免慢速 `windows-11-arm` / `macos-15-intel` 空跑而手动取消整轮）。
- **守住的底线**：**历史 0 次残缺资产上线**。`publish` 全局屏障与 `updates:verify` 的 Ed25519 签名 + SHA-256 摘要双检拦截了所有半截失败的构建，从未污染已公开的 Release。
- **真正造成返工的两类风险**：
  1. **流水线末尾晚失败**：原生编译跑完几十分钟，在最后一步身份哈希校验、打包审计或目录拉取时才报错；或因锁文件/平台开关疏漏反复重打 Tag。
  2. **「构建绿灯、安装即挂」逃逸**：如 `v0.1.12`→`v0.1.14`、`v0.1.16`→`v0.1.17` 连续热修，Actions 绿灯但产物丢失执行权限或沙箱 preload 加载失败。

---

## 二、七道历史故障防线（审查必查）

### 1. Workspace 升版严禁手改或全文替换 `package-lock.json`

- **历史事故**：
  - **`v0.1.16`（Run `40816423724`）**：9 个构建 Job 在 `npm ci` 全军覆没，报 `404 Not Found - GET https://registry.npmjs.org/@omp-studio%2fclient@0.1.15`。原因是只改了各子包自身的 `version`，漏改内部依赖声明的 `"@omp-studio/*": "0.1.15"`，导致 `npm ci` 放弃本地软链转而请求公网（修复：`a65a5e5`）。
  - **`v0.1.17`（Run `40904653806`）**：批量替换版本号时，误将 `package-lock.json` 中第三方依赖 `apps/renderer/node_modules/fflate` 的 `"version": "0.8.3"` 改写为 `"0.1.17"`，8 个预热与构建任务再次秒挂于 `npm ci`（修复：`4e2cdc7`）。
- **审查防线**：
  - 升版必须用脚本精确更新根 `package.json`、`apps/*`、`packages/*` 的 `version` 与全部 `@omp-studio/*` 内部依赖版本，随后执行 `npm install --package-lock-only` 重生成锁文件，**严禁对 `package-lock.json` 做全文查找替换**。
  - 审查 `git diff -- package-lock.json`：只允许根包与 workspace 条目的版本字段变化，不得触碰 `node_modules/*` 第三方包条目。
  - 核对根目录与 `apps/renderer` 的 `mermaid` 镜像版本保持一致（保证 npm 11 应用根级 `katex` override）。

### 2. 构建末尾 fail-closed 的「双源元数据」必须在源码阶段秒级对齐

- **历史事故**：
  - **`v0.2.0`（Run `43369344614`）**：6 个平台编译 12～48 分钟后，全部死在最后一步 `assertRuntimeIdentity`：`Runtime identity capability hash does not match the packaged capability definition`。根因是 [`scripts/runtime-artifact.mjs`](../scripts/runtime-artifact.mjs) 的 `IMPLEMENTED_CAPABILITIES` 与 Runtime 握手实际暴露的能力列表顺序/条目漂移（修复：`5d2426f`）。
  - **同类重演**：`v0.1.4`（`15e243a` 上游 commit 身份不对齐）、`7e6209c`（漏登 `timeTravel.capture`）、`v0.2.1`（`0272db6` `--signing-key` 被解析为连字符属性而读取驼峰字段，静默回退开发密钥；同版还发现改了 Runtime 源码却沿用旧 `studio.1` 版本号）、`v0.2.2` 前夕（`57fd986` 漏登 `studio.locale`）。
- **审查防线**：
  - 凡触碰 `omp-patch/`（无论 `overlay/` 还是 `patches/`），必须确认已按标准流程执行 `npm run omp:overlay:apply` → 修改 → `npm run omp:patches:regen`，**四份 `.patch` 无手工编辑痕迹**，且检查完后 `omp-patch/vendor/oh-my-pi` 子模块 gitlink 状态干净、与 [`omp-patch/upstream.json`](../omp-patch/upstream.json) 一致。
  - 只要本次相对上一已发布版本改动了 Runtime 源码或补丁，**必须递增 `studio.N` 构建号**（如 `bridge-server.ts` 与关联清单），既避免复用旧签名产物漏掉新代码，也避免与已发布同版本号冲突。
  - 触碰协议能力、Runtime 打包脚本或签名工具时，发布审查必须运行 `npm run test:tooling`（覆盖 `IMPLEMENTED_CAPABILITIES` 顺序/哈希对齐与 CLI 签名参数映射）。

### 3. 严守「测试归 CI、打包归 Release」，杜绝环境与日历假设

- **历史事故**：
  - **跨架构与路径别名假设**：`v0.1.6` 连挂 4 次（Runs `35460227446`–`35493227835`，首次引入 `windows-11-arm` 时测试夹具硬编码 `win32-x64` 且 Bun 默认 5s 超时不足）；`v0.1.7` 连挂 2 次（Runs `36095067128`、`36098132661`，Windows Runner `RUNNER~1` 8.3 短路径未过 `realpath`）；`v0.1.10` 单日连挂 5 次（Runs `38592561039`–`38610246996`，macOS `/private/var` 软链、Windows Server 缺失 Known Folders、ASAR 写入未 `await` 即开始审计）。
  - **真实日历炸弹**：`v0.1.8`（Run `36742730020`，重试 `attempt=2` 仍挂）于 10 月 1 日凌晨发版，`HomePage.test.tsx` 使用真实系统时钟渲染月度趋势图，每月 1 号仅 1 个数据点导致悬停翻转断言必败（修复：`e16fabb`）。
- **审查防线**：
  - **禁止把源码单测、全量 patch 重放或 GUI E2E 重新塞回 `release*.yml` / `runtime-*.yml`**（`fa31f23` 剥离后此类发版失败降为 0）。源码回归必须在打 Tag 前通过本地门禁与 `main` CI 完成。
  - 审查新增打包/审计脚本时：临时目录与路径包含性比对一律经 `realpath` 规范化；异步归档/落盘必须等待句柄关闭后再做文件审计；任何涉及时间窗的测试必须固定时钟并考虑月初/跨年边界。

### 4. 跨 Job 传输损耗与「开发态全绿、打包/沙箱态白屏」审查

- **历史事故**：
  - **`actions/upload-artifact` 剥离 POSIX 执行位（`0755`）**：`v0.1.10`（`4fbd8bd`）与 `v0.1.16`（[#18](https://github.com/the-snowpear/omp-studio/issues/18)，`v0.1.17` 修复）两次踩中——macOS / Linux 二进制经 Artifact 上传再下载后丢失 `+x` 权限，打包进 DMG 后用户首次启动激活失败。
  - **Artifact 目录层级漂移**：`v0.1.12`（Run `40536208522`）桌面包全过但 6 个 `build-remote` 全挂，因上游产物迁入 `<runtimeVersion>/` 子目录而下游远端打包脚本仍按旧层级读取（修复：`a72f7f4`）。
  - **沙箱 Preload 打包逃逸**：`v0.1.12` 逃逸出 [#8](https://github.com/the-snowpear/omp-studio/issues/8)（`v0.1.13` 修复），preload 链路间接引入 `node:child_process`，Node 环境单测无感，但正式安装包 `sandbox: true` 下拒绝加载桥接脚本导致界面报 `Studio client unavailable`。
- **审查防线**：
  - 发布前**必跑 `npm run check -- --production`**（不仅编译类型和跑核心测试，还会实际构建 Vite 生产包、远端 Host bundle 并校验沙箱 preload 无外部 Node/Host 依赖泄露）。
  - 若改动了 `.github/workflows/` Artifact 传递、[`scripts/pack-mac.mjs`](../scripts/pack-mac.mjs)、[`scripts/pack-linux.mjs`](../scripts/pack-linux.mjs)、[`scripts/pack-win.mjs`](../scripts/pack-win.mjs) 或远端环境打包：必须确认**消费端下载后显式 `chmod 0755` 恢复全部可执行文件权限**（改权限位不改文件字节，不影响 Ed25519 签名校验），且对应 `audit-*` 覆盖了目标 CPU 架构头（PE / Mach-O / ELF）、执行位与原生子进程 helper（如 `winpty-agent.exe`、`omp-deb-update`）。

### 5. 触发方式同构与 `prepare` 阶段 10 秒前移预检

- **历史事故**：
  - **`v0.1.11`（Runs `40320843281`、`40321107734`）**：两次推 Tag 发现 `build-macos` 被跳过而紧急取消，改用手动 `workflow_dispatch` 重发。原因是 `include_macos` 当时只读 `inputs.include_macos`，`push` 事件下为空；早期还曾因 `docs/releases/v<version>.md` 漏列构建平台下载链接而被迫重推。
- **审查防线**：
  - 修改 [`release.yml`](../.github/workflows/release.yml) 或 [`scripts/release-plan.mjs`](../scripts/release-plan.mjs) 时，确保 `push` Tag 与手动 `workflow_dispatch` 走同一套矩阵推导，桌面正式版固定包含 **Windows x64、Windows ARM64、macOS Apple Silicon（`darwin-arm64`）、Linux x64** 四个桌面目标及全部 **6 个 SSH 远端环境**。
  - 打 Tag 前在本地核对 `prepare` 阶段同款元数据约束：
    1. [`apps/renderer/src/preview/mode.ts`](../apps/renderer/src/preview/mode.ts) 中 `PREVIEW_MODE_SWITCH_ENABLED` 必须为 `false`；
    2. 桌面版 `version` 不含 `-` 预发布后缀，且远端 GitHub Releases 中不存在同名非草稿 Tag；
    3. 若提供 `docs/releases/v<version>.md`，其下载链接必须完整覆盖四个桌面平台的实际产物名（由 `assertReleaseNotePlatforms` 强制校验）；
    4. `CHANGELOG.md`、`README.md`、`README.en.md` 与 `docs/README.md` 中的当前版本号、最新修复口径及文档入口已同步，不留上一版的过期提示。

### 6. 编译缓存预热与正式签名工件严格隔离

- **历史事故**：
  - `0.1.16` 前夕引入 [`release-cache.yml`](../.github/workflows/release-cache.yml) 时，早期逻辑允许预热任务在未命中时顺手签出替代 Runtime；随后由 `e051d71` 紧急收口。此外 GitHub Actions Cache 受分支作用域隔离，写在旧 Tag 上的缓存无法被新 Tag 命中。
- **审查防线**：
  - 预热工作流（`Warm release caches`）只准在 `main` 分支写共享下载缓存、桌面原生缓存、Bazel action cache 与已编译 `.node` 工件，**绝不签发替代正式发布的 Runtime，也绝不发布 Release**。
  - 本机实测若使用一次性测试密钥（`omp:keys`），测试产物与报告只留本地忽略目录（如 `outputs/`），严禁将开发公钥写入 [`packaging/keys/trusted-keys.json`](../packaging/keys/trusted-keys.json) 或提交私钥、日志与 `backup/`。

### 7. 错峰等待预热完成，避免并发打爆托管 macOS 槽位

- **历史事故**：
  - **`v0.2.2`（Run `43873316174` `attempt=2`）**：`13:06:53Z` 推送 `main` 触发 `Warm release caches`（Run `43872690266`），仅隔 **4 分钟**（`13:10:51Z`）在同一提交上推送 `v0.2.2` Tag。两套大矩阵同时冷跑并争抢 GitHub 托管 `macos-15` 的有限并发槽位，导致 `Release` 中的 `build-remote (darwin-arm64, macos-15)` 排队 15 分钟未分到机器（`runner_name: ""`）被平台直接 `cancelled`，`publish` 被跳过，最终靠 `Re-run failed jobs` 才完成发版。
- **审查与操作防线**：
  - **先等预热绿灯、再推版本 Tag**：当合入 `main` 的提交涉及原生源码/补丁、依赖锁文件或打包脚本时，先观察 `main` 上的 `CI` 与 `Warm release caches` 完成，再推送 `v<version>` Tag（既直接复用刚热好的 `.node` / 缓存，又避免双倍抢占 macOS 槽位）。纯版本号 bump 提交会自动跳过重复预热，可直接按序推进。
  - **瞬态排队/网络抖动只做原位重试**：若 Release 因单个托管 Runner 排队超时或瞬态网络错误而取消/失败，直接在原 Actions Run 点击 **`Re-run failed jobs`**（幂等复用其余平台已签名的候选工件），**严禁删除或强推已公开引用的 Tag**。

---

## 三、标准发布审查执行清单

每次执行发布前审查并撰写审查结论（或 `docs/reviews/v<version>-release-review.md`）时，按以下三步逐项核验：

### 第 1 步：源码、版本与元数据静态核验（必查）

- [ ] **发布基线明确**：确认当前分支、目标 commit、上游 `omp-patch/upstream.json` 固定提交，未混入尚未准备发布的半成品特性或脏工作区改动。
- [ ] **版本号与锁文件对齐**：根 `package.json`、`apps/*`、`packages/*` 版本及内部 `@omp-studio/*` 依赖一致；`package-lock.json` 由 `npm install --package-lock-only` 生成，无第三方包版本误改；根与 `apps/renderer` 的 `mermaid` 版本一致。
- [ ] **预览开关关闭**：`apps/renderer/src/preview/mode.ts` 中 `PREVIEW_MODE_SWITCH_ENABLED === false`。
- [ ] **Runtime 身份与补丁干净**（改过 `omp-patch/` 时）：已跑 `omp:patches:regen`，无手改 `.patch`，`studio.N` 已递增，vendor 子模块无未提交脏状态。
- [ ] **多语言与文案完整**（改过界面文案时）：按 [`localization.md`](localization.md) 核对中英文键值、占位符与实时切换，无单语硬编码回退。
- [ ] **发布文档与链接完整**：`CHANGELOG.md` 已落版；`docs/releases/v<version>.md` 下载链接与四桌面平台产物名完全一致；`README.md` / `README.en.md` 版本说明不过期；对尚未根因确认的用户反馈诚实标注未修复，不夸大覆盖范围。

### 第 2 步：按改动面执行验证门禁（精准选跑）

| 改动范围 | 发布审查必跑命令 / 动作 | 拦截的目标故障 |
|---|---|---|
| 所有桌面版发布（必跑基线） | `npm run check -- --production` | 架构分层、选择器/动效规则、全包类型、核心测试、Renderer 生产包、远端 Host 产物、**沙箱 preload 外部依赖泄露** |
| 触碰打包 / 更新 / 签名 / Release 脚本或协议能力 | `npm run test:tooling` | `release-plan`、`release-assets`、**`IMPLEMENTED_CAPABILITIES` 哈希对齐**、CLI 签名参数映射、差分目录校验 |
| 触碰 `omp-patch/` 或升级上游 OMP | `npm run runtime:verify-source` 与 `npm run omp:verify:patches` | 上游固定 commit 漂移、overlay/接缝补丁应用失败、Runtime 类型与 smoke 回归 |
| 触碰多语言字典或跨进程语言同步 | `npm run check -- --only renderer --suite i18n.test`（及对应缓存/同步套件） | 中英文缺键、占位符失配、切换语言后旧缓存回填 |
| 触碰安装包脚本、权限、更新器或启动链路 | 本机隔离目录打包/Electron 实测；必要时触发 CI 手动切片 `macos-package` / `linux-package` | 安装向导、沙箱桥接挂载、首次启动 Runtime 激活、Linux AppImage/deb 权限与数据保留 |

### 第 3 步：打 Tag 时序、发版监控与发布后核验

1. **确认 `main` 状态**：确认候选基线的 `CI` 已绿；若触发了 `Warm release caches`，等待其完成后再推送 Tag。
2. **推送 Tag 或触发工作流**：确认 `prepare` Job 在十余秒内通过版本唯一性与发布页平台链接校验；监控矩阵构建，遇托管机器排队取消时使用 `Re-run failed jobs`。
3. **发布后闭环核验**：
   - 核对 GitHub Release 公开状态（桌面版为 `Latest`，独立 Runtime 不抢 `Latest`，canary 为 `prerelease`）。
   - 核对公开资产齐全（四桌面平台安装包/Runtime/blockmap/签名清单 + 六平台 `remote-environment-*` 清单与归档 + Windows v1 迁移索引），签名清单记录的大小与 SHA-256 同 GitHub 已上传附件一致。
   - 在审查记录中**明确写出验证边界**（例如哪些平台做了真实安装/GUI 实测，哪些仅由跨平台 CI 打包审计覆盖而未做真机 Gatekeeper/UAC/SSH 验收）。

---

## 四、附录：历史典型失败运行速查表

排障遇到相似报错时，可直接对照历史 Run 与修复提交：

| 日期 | 目标版本 / 工作流 | Run ID | 失败阶段与核心报错 | 根因归类 | 修复提交 |
|---|---|---|---|---|---|
| 2026-09-06 | `v0.1.4` Release | `34025418127` / `34025917534` | Runtime 源与身份校验失败 | 上游 commit 固定值与打包脚本身份不一致 | `15e243a` |
| 2026-09-18 | `v0.1.6` Release（连挂 4 次） | `35460227446`–`35493227835` | `windows-11-arm` 首次构建跑源码测试超时/断言失败 | 测试夹具硬编码 `win32-x64` + Bun 默认 5s 超时过短 | `8514c5d`、`0af57f9` |
| 2026-09-24 | `v0.1.7` Release（连挂 2 次） | `36095067128` / `36098132661` | Windows 路径包含性测试失败 | GitHub Runner `RUNNER~1` 8.3 短路径未过 `realpath` | `2c07600` |
| 2026-09-30 | `v0.1.8` Release（含 `attempt=2`） | `36742730020` | `HomePage.test.tsx` 悬停卡片翻转断言失败 | 北京时间 10 月 1 日凌晨真实时钟月度图仅 1 个点 | `e16fabb` |
| 2026-10-16 | `v0.1.10` Release（连挂 5 次） | `38592561039`–`38610246996` | macOS `/private/var`、Windows Known Folders、ASAR 审计与执行位报错 | 发布流程混跑脆弱测试 + 跨平台路径别名 + 归档未 `await` + Artifact 丢 `+x` | `6c2e320`、`78c8bd4`、`4fbd8bd`、`91df708`、`2cfd817` |
| 2026-10-25 | `v0.1.11` Release（取消 2 次） | `40320843281` / `40321107734` | 推 Tag 后 `build-macos` 被 `[skipped]` | `include_macos` 仅绑定 `workflow_dispatch` 输入，`push` 事件为空 | `a0eab26` 收口至 `release-plan.mjs` |
| 2026-10-27 | `v0.1.12` Release | `40536208522` | 6 个 `build-remote` 找不到已构建 Runtime | Runtime 工件迁入 `<runtimeVersion>/` 子目录，远端脚本未同步；同版逃逸出沙箱 preload `#8` | `a72f7f4`、`2f28d88` |
| 2026-10-29 | `v0.1.16` Release | `40816423724` | 9 个 Job 在 `npm ci` 报 `@omp-studio/client@0.1.15` 404 | 升版漏改 workspace 内部依赖版本；同版逃逸出 DMG 丢 `+x` `#18` | `a65a5e5`、`449ef2d` |
| 2026-10-30 | `v0.1.17` Warm / Release | `40904653806` / `40904692368` | 8 个 Job 在 `npm ci` 找不到 `fflate@0.1.17` | 全文替换版本号误改 `package-lock.json` 内第三方包版本 | `4e2cdc7` |
| 2026-11-12 | `v0.2.0` Release | `43369344614` | 6 个原生平台编译完后报 `capability hash does not match` | `runtime-artifact.mjs` 的 `IMPLEMENTED_CAPABILITIES` 与 Runtime 握手漂移 | `5d2426f`（及后续 `7e6209c`、`57fd986`） |
| 2026-11-14 | `v0.2.1` 发布前审查拦截 | 发版前本地发现 | CLI `--signing-key` 回退默认密钥；Runtime 改源码仍为 `studio.1` | 连字符参数名未映射驼峰属性；漏跑 regen 与递增 `studio.2` | `0272db6` |
| 2026-11-16 | `v0.2.2` Release（`attempt=2` 成功） | `43873316174` | `build-remote (darwin-arm64)` 排队 15 分钟 `runner_name: ""` 被取消 | 推 `main` 后仅隔 4 分钟推 Tag，`Warm release caches` 与 `Release` 同时争抢 `macos-15` 槽位 | `attempt=2` 重跑通过；`436c980` 进一步迁出 Linux Bazel 交叉编译减负 |
