# 工作台精简重构实施记录

基线：`be2673b`。独立工作树分支：`codex/studio-streamline`，目录 `D:\Project\.worktrees\omp-studio-streamline`。用户明确要求本次不另做备份；原工作树保留不动。

## 已确认的边界

- 保留功能、界面入口、协议、持久化格式，以及真实／预览两条路径。
- 保留已合入的会话切换共享读取、归档 Worker、缓存预算和竞态修复。
- 隐藏闲置网页只节流，保护实际操作、加载、下载、音视频及 DevTools；不自动卸载或关闭。
- 复用现有 Dock 稳定宿主、延迟面板、Store 和检查入口，不增加通用框架或第二套缓存。
- 各阶段独立提交，测量没有通过或没有执行的项目单独记录。

## 执行阶段

1. 生产构建、首屏资源、原生启动与会话切换基线。
2. 首次使用才加载的重面板与页面样式。
3. 托管网页活动与退出清理。
4. 工作台职责和大型功能页拆分。
5. 发行物盘点、可证实的冗余裁剪。
6. 行为回归、生产检查、性能对照和持续运行验收。

## 测量方法

`node scripts/renderer-assets.mjs apps/renderer/dist outputs/streamline/<阶段>/assets.json` 统计生产入口的静态 JS 依赖、首屏 CSS 与完整 Renderer 目录。静态依赖去重；启动中实际触发的 lazy 资源另由原生测量记录。gzip 只用于字节对比，不代表本地文件读取量。

启动复用 `startup-perf.mjs` 的合成工作台，并与真实 Host 的 `native-session-perf.mjs` 分开记录。Windows 原生浏览器检查使用隔离配置和本地 HTTP fixture，不发送模型请求或使用用户会话。

## 结果

### 首批加载精简

Git、上下文查看器、Computer 正文复用 Dock 首次可见才挂载的机制；本地资源编辑器只在对话框打开时加载，具备局部失败重试。模型配置页样式随该页面加载，所有 harness 同步移除提前导入，避免测试入口与产品入口采用不同加载策略。

| 实际生产入口 | 基线 | 首批加载修改 | 变化 |
| --- | ---: | ---: | ---: |
| 静态 JS，raw bytes | 4,391,054 | 3,211,131 | −26.9% |
| 首屏 CSS，raw bytes | 764,829 | 652,801 | −14.6% |

CodeMirror 及语言目录不再出现在首屏静态依赖中。以上不是启动时间或完整安装包的缩减比例。原始记录位于 `outputs/streamline/{baseline,loading}/assets.json`。

`npm run check -- --only renderer --suite DeferredPanel --suite App --suite ModelConfigPage` 通过；Renderer 生产构建通过。基线合成工作台五次采样完成，其启动时间包含自动化启动成本，最终性能结论等待同条件对照。

### 托管网页活动

`BrowserPageActivity` 归每个实际网页实例所有。可见窗口、加载、媒体、声音、DevTools、元素选择和在途操作阻止节流；最后一个保护结束后等待 30 秒。普通目录读取不续期。隐藏只降低调度，不导航、不销毁页面；真正关闭时清理计时器和窗口监听。所有 CDP 请求、attach 和截图都有活动生命周期，下载在完成／取消后释放保护。

Electron 原生实验确认，单独设置后台节流不会立即更新停放页面的可见性。切换时通过一次原生 capture 同步可见性；Agent 的焦点模拟也随睡眠暂停、唤醒恢复。没有增加常驻轮询。

- 单元回归覆盖 30 秒宽限期、所有保护条件、重复状态通知、重叠请求和退出清理。
- 隔离原生页面：同一 1.2 秒采样窗口，动画 292 → 0 帧、10 ms 计时器 121 → 1 次。页面 ID、表单和 JavaScript 状态保留；35 秒 Agent 请求、错误清理、媒体、下载、最小化截图和恢复通过。这个数字属于受控 fixture，不是所有网站的 CPU 节省比例。
- 真实 Runtime relay 验收覆盖正常／隔离子 Agent、接管、下载、Runtime 代次切换、关闭和重启；基线与当前代码各自使用全新配置完成完整流程。
- 原冒烟夹具缺少当前 Runtime 的 SessionManager 身份、view-session 能力和 Eval owner；补齐后保持所有原断言。重启夹具还漏了首次进程已有的宿主 `about:blank` 初始化；基线同样超时，补齐初始化后通过，没有放宽超时或产品检查。

证据：`outputs/streamline/browser/{baseline-full,current-full}.json`、`native-*/report.json` 与对应日志。失败实验保留原文件。两小时浏览器生命周期记录仍在运行；结束后另记结果。
