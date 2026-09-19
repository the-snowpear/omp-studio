# 应用内更新

## 用户体验

新更新器在后台检查并准备更新，完成后点击「重启更新」。下载不会中断任务；运行中任务或待处理交互会阻止重启。普通退出不会自动安装。

桌面更新包括 Electron、Main、Renderer、preload 和原生模块。Runtime 可以独立更新，并保留 Stable / Canary。两者共用签名发现、差分下载和持久化事务；若桌面包已包含目标 Stable Runtime，复用内置工件。

更新器优先复用本地相同数据块，通过 HTTP Range 下载变化部分。缓存缺失、损坏、服务器不支持 Range、差分失败时回退一次完整下载。完整下载仍使用静默安装，界面显示实际下载方式和字节数。

## 存储和迁移

- 当前用户默认安装目录：`%LOCALAPPDATA%\Programs\OMP Studio`，程序以普通用户权限启动。发布打包会在复制 Runtime 后立即使用 `packaging/keys/trusted-keys.json` 验证 Runtime manifest、checksums、signature 和 EXE 摘要；开发密钥或错误发行密钥会让打包失败。
- 活跃 Runtime：`%LOCALAPPDATA%\omp-studio\runtimes`。
- 更新缓存与事务：`%LOCALAPPDATA%\omp-studio\updates-v2`。
- 原有会话、设置、工作区记录和头像位置保持不变；不迁移用户项目。
- 安装器保留签名 Runtime seed，用于初装离线启动，日常桌面更新不删除活跃 Runtime。

旧全机安装需要一次迁移安装。安装器先完成当前用户安装，再请求授权卸载旧全机版本。迁移前复制旧 Runtime，启动时重新验签。授权取消、旧版仍在运行或旧卸载失败时保留旧版本，并明确提示重新运行 Setup 完成迁移；新旧安装可能暂时并存。旧卸载器会按名称处理进程，因此迁移要求所有 OMP 进程退出；新安装器不按名称全局杀进程。

## 可信更新与恢复

v2 清单采用 Ed25519 签名，包含组件、版本、通道、架构、序号、兼容协议、工件和 blockmap 的 SHA-256/SHA-512。签名域为 `omp-studio-update-v2`。下载与重建后的文件校验完整摘要；执行前重新校验。镜像只改变传输位置，不能改变信任来源。

发现按组件、通道与架构分别选择最大签名序号，保存防回退水位。Runtime 独立发行不使用 GitHub Latest。Canary 必须显式选择；同一个 Runtime 版本不能发布不同字节或不同通道。

准备完成的工件和签名清单写入事务文件。用户点击重启后，Main 保存居民会话 ID 与原工作区，阻止新生命周期操作，关闭 Runtime，然后启动 NSIS 静默安装或直接重启。新 Main 验证并激活 Runtime，恢复会话；启动失败时尝试验证和激活兼容的上一 Runtime。没有兼容旧版本时保留诊断界面。

桌面静默安装不是原子事务。保留上一签名桌面安装包，通过「设置 → 高级 → 恢复上一桌面版本」查看恢复目标并准备上一版本，再单独点击「重启恢复」。缺少可验证旧版本时入口禁用并说明使用历史安装包；准备好的回滚跨启动保留，不会被后台下载替换。新桌面完全无法启动时，需要手动运行历史 Setup。Runtime 数据和用户配置不在桌面安装目录中，避免重装时被替换。

应用更新在最终退出前重新检查待应用桌面和 Runtime 的协议及最低桌面版本，避免分次准备形成不兼容组合。Runtime 激活后的中断恢复保留原试运行的回滚目标，即使 current.json 已切换也不会覆盖它。旧全机迁移通过临时复制的 NSIS 卸载器和 `_?=` 等待实际卸载结束，并核对旧程序文件已移除。

「跳过此版本」仅用于桌面更新。Runtime 独立更新不显示此按钮，避免把 Runtime 版本写入桌面的跳过配置；Runtime 更新仍可关闭自动下载或稍后处理。

## 工程边界

- `update-coordinator.ts` 管理 Main 中的后台任务、事务、准备与重启。
- `differential-artifact.ts` 负责工件缓存、摘要验证、差分和全量回退。
- `electron-update-adapter.ts` 集中封装固定版本 electron-updater 的差分实现，以及 NSIS `--updated /S --force-run` 启动；等待进程启动结果，失败不回退到交互打开安装包。
- IPC 固定为 snapshot / prepare / check / apply / cancel；共用 v2 类型来自 runtime-installer。旧在线 startApp/startRuntime 在新打包应用中禁用；旧代码仅用于兼容测试和未打包开发环境。
- ZIP 工件离线导入仍使用内部 Runtime 签名验证和现有维护事务；不能用未签名目录覆盖活跃版本。

## 发布前验收

运行 `npm run check`、`npm run omp:test:metadata`、`npm run updates:verify`、`npm run p5:gate`。Windows 安装迁移、UAC、静默重启、安装失败恢复和 ARM64 必须在对应环境验收。不得将代码编译通过或本地 HTTP 差分测试标记为已完成 Windows GUI 迁移验收。
