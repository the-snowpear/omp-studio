# 性能优化与项目对标报告（2026-10-29）

## 结论
保留 Electron/React，修复实际的启动等待、整壳无效更新、重复读和提前加载。三个参考项目目前也都采用 Electron；没有同机同负载成绩，不能按框架或宣传给它们排名。

本次改动已经落到源码，未提交、发布或替换用户安装。**下面的前端基准不是完整 OMP Runtime 的启动/CPU/RSS 成绩。**

## 对标与取舍

- [oh-my-pi-gui](https://github.com/nornzach/oh-my-pi-gui/tree/f17a05e511cd19d0d1c6d99e6a9903e20f9a5444)：tab 按需启动 sidecar、32ms 事件批处理、虚拟列表和完整应用 E2E。借鉴按需启动和测量，不照搬预热备用进程或丢工具更新。
- [Pixel-Starry-Sky-Desktop](https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop/tree/bd861547a781d1392dba0569a6395cfadc066606)：连续 delta 合并、完成 Markdown 块复用、长尾节流、背景降档。只参考原理；未确认复制许可，不复制源码，也不默认截断流式正文。
- [ZCode](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab)：已公开完整源码，Apache-2.0；`utilityProcess` 隔离 Host、MessageChannel、保序有界合并。Host 搬进程可能减轻主线程，却新增内存与通信开销，本次没有未经实测重写。
- [Electron 官方性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)、[VS Code 性能排查](https://github.com/microsoft/vscode/wiki/Performance-Issues)：先按进程/阶段测量，资源用到才加载，避免阻塞主线程。

已有的 Store 限额、流式合流、动态虚拟列表、高亮 Worker、Mermaid 队列和内部休眠继续复用，没有重新实现。

## 已完成的优化

### 普通启动不等待完整 Runtime
基础 Host、authority、私有 endpoint、workspace registry 和真实 facade 就绪后创建窗口；Runtime 的播种、验签、探针和启动由同一个后台任务继续。准备中明确显示 `connecting`，不伪造 ready。

手动 ensure、会话切换、安装/回滚/清理与初始化协调；加入工作区代际检查，防止旧请求绑定新项目。退出等待在途启动并清理资源；更新试运行仍等终态再判断回滚。健康确认不越过 Runtime 准备或首个懒加载页面。

### 正文增量不再唤醒整壳
模型配置页原来直接订阅完整 ClientState，每个正文游标变化都触发 AppShell。改为只关注所选 session、workspace 与 Runtime status。协议 cursor、事件投递和收据语义不变。

### 真正按需加载
模型、能力中心、设置、诊断、Agent Hub、媒体、评测等页面按需加载，导航 intent 与模型展示辅助函数独立为轻模块。终端和录制播放器也按需加载；既有 PTY 不因隐藏销毁。局部失败可重试，导航往返保留 Composer 草稿。

生产静态闭包及浏览器验证确认：未使用这些功能时，首屏不请求 xterm、CodeMirror、Mermaid；打开模型页/终端后才加载对应模块。`onlyExplicitManualChunks` 避免手工 chunk 把公共依赖并入昂贵的 Mermaid 模块。

### 减少重复和空闲工作
初始加载和 Runtime resync 合并为一个入口，按数据域提交，只有在途请求共享，不建永久缓存。项目、环境、命令清单的初次请求由两次变一次。history 仍服务其他独立功能，不宣称全应用所有历史读取只有一次。

Git 按 client/workspace 共享订阅与读取。**变更事件只是失效通知，不是完整仓库快照**；因此合并补读，并丢弃已失效的旧结果。录制状态在隐藏时停查、恢复即刷新；fallback Runtime 队列仅在需要时轮询。Host 录制、真实终端和后台模型任务不停止。

### 去掉图形库重复发行文件
产品加载 X_ITE 的压缩 ESM 入口，依赖库也按入口后缀选择压缩组件。保留所需 `.min.mjs`、压缩组件、解码器、字体、其他资源和全部许可证，去掉未压缩/重复入口，不裁功能。

## 测量结果

环境：Windows、Intel Core i9-13900HX（32 逻辑核）、Node 24.13.0、Electron 43.4.0。使用锁定依赖、生产 `file://` 完整 App fixture，不发送模型请求。原构建保留，先各跑十次，再做五组交替 A/B；以下为五组中位数。

| 指标 | 优化前 | 优化后 | 变化 |
|---|---:|---:|---:|
| Electron 启动到合成工作台出现 | 1,772.56 ms | 1,384.26 ms | -21.9% |
| 720 个纯游标增量的脚本总耗时 | 368.63 ms | 27.58 ms | -92.5% |
| 同场景 Layout 总耗时 | 37.69 ms | 38.87 ms | +3.1% |
| 同场景测得 JS heap（未强制 GC） | 26.65 MiB | 14.05 MiB | -47.3% |
| 渲染生产目录总大小 | 31.74 MiB | 19.47 MiB | -38.7% |
| 其中 X_ITE 资源 | 22.83 MiB | 10.54 MiB | -53.8% |

说明：
- 纯游标增量刻意隔离“消息变化有没有让整壳做无用功”，不是正文解析吞吐测试；真实正文、工具卡、滚动另跑现有流式门禁。
- JS heap 不是 Electron/Runtime 总内存，也不是经过 GC 的 retained heap；不拿这个数字宣称所有内存下降 47%。
- 安装包未重新制作，不能把渲染目录缩小 38.7% 等同整个约 210.82 MiB 的 Windows 安装包下降同样比例。
- 操作系统文件缓存没有清除，不称为冷机成绩。首帧不是 Runtime 可发消息时间。中途不一致版本/失败样本未计入对照；旧/新构建最终比较均为 Electron 43.4.0。
- 本轮不以高刷 rAF 间隔推断真实用户流畅度；独立 Chromium 流式门禁采用自身测得的刷新率。

原始数据（本地、gitignored）：`outputs/perf/workbench-before.json`、`workbench-before-rechecked.json`、`workbench-final.json`、`workbench-paired.json`、`artifact-before.json`、`artifact-after.json`。

## 验证

- Desktop 核心及全部生命周期测试、Renderer 全部测试、Host client API、arch/selects 和最终生产构建已通过。初轮 Tooling 的 99/100 已在后续修复后恢复 **100/100**：目录数据、顺序和版本均未过期，根因是 Windows `core.autocrlf` 把检出内容变为 CRLF，而生成器按 LF 字节比较；检查现在仅规范化换行，不重新生成目录、不忽略实质内容差异。新增图形资源裁剪测试通过。
- 首轮生产 Chromium 流式门禁 **18/18**：布局比 1.365（上限 2.5）、heap 保留比 0.929（上限 1.25）、工具 DOM 比 0.980（上限 1.35）、忙场景 p95 16.8ms。后续切换修复复测仍 **18/18**：布局比 1.517、heap 保留比 1.01、DOM 比 0.94、忙场景 p95 16.7ms；切换首次可见位置跳变为 0，工具交接重挂载为 0，未放宽门槛。
- 100 代码块高亮全部着色，零正文不匹配、零外框重挂；空闲 31 秒后高亮 Worker/running/queued/listeners 均为零；Mermaid 运行/队列归零；50 次生命周期后 Engine/Store 活跃计数回到零。
- 浏览器验证真实/预览两套 UI、模型页/终端首次进入、草稿往返保留，以及模块按需请求；无当前页面请求失败。
- 真实 Electron 主入口以隔离 HOME/APPDATA/OMP_AGENT_DIR 启动：无签名 Runtime 的诚实不可用状态、Host projects query 正常，未访问用户会话或付费调用。单次 smoke 首壳约 2.33 秒，日志中基础 Host 246ms、窗口加载 314ms；这是无 Runtime 的功能验证，不计入前后收益。

## 未覆盖与已暴露限制

- 隔离配置没有签名 Runtime 工件，**未完成真实 Runtime 的冷/热启动前后基准、1/5/10 常驻会话的 10 分钟 CPU/RSS 对照和实际更新安装循环**。对应竞态通过注入延迟/假 Runtime 的行为测试验证，不能替代这些实机数据。
- 未做 macOS 实机验证，未构建完整 Windows/macOS 安装包。
- 初轮 X3D/VRML 验证暴露的 WASM/CSP 和 `file://` 沙箱模块加载问题已修复。主窗口仍禁止通用 `unsafe-eval`；仅隔离图形 iframe 的 CSP 允许 `wasm-unsafe-eval`，打包资源由只读 `omp-graphics://viewer` 地址提供，iframe 仍为 `sandbox="allow-scripts"`，无 Node、IPC 或父文档访问。贴图 ZIP fixture 使用不内联的资源 URL，不开放 `connect-src data:`。生产 Electron 验证包含 X3D、VRML、贴图 ZIP、错误提示和卸载，均通过；页面自身脚本确认 WASM 可用、通用 eval 被拒、父文档不可访问。浏览器预览 pane 的 `ERR_BLOCKED_BY_CLIENT` 属宿主嵌入限制，不以它替代 Electron 验证。
- Main 模块打包、移到 utilityProcess、减少重复 Runtime 摘要，以及常驻进程策略未实施；这些需要实际剖析或产品取舍，不用强制 GC/杀进程来制造“低占用”。

## 多会话与页面切换复核

后续专项审查按会话事件归属、请求失效、页面生命周期和资源预算核对，并参考 VS Code 的编辑器实例复用/可见性通知、oh-my-pi-gui 的按目标路由，以及 ZCode 的有界保序合并。不把“隐藏”当“关闭进程”，不默认预热备用 Runtime，也不保持所有对话热 Store。

会话层同时修复后台恢复的绑定归属：回调按创建它的 Worker port 定位居民，只允许活动居民更新前台 facade 与连接事实；启动尚未登记、停止中和已释放的回调不改变前台。首次创建的 Worker 记住实际会话 ID，自动重启仍恢复同一会话。连接曾进入 connecting/不可用后，重新接通允许补发一次相同版本的当前快照，不降低版本水位，也不丢终态收据。`runtime.ensure` 是 Host 拥有的命令，Runtime 身份变化不再提前作废它；真正 Host 传输丢失和重新 bootstrap 仍标记结果未知。Client、Host API 和 Desktop 全部回归通过；旧生命周期夹具的 Hello 现在跟随当前快照 epoch，产品仍拒绝身份不一致的快照。

Renderer 已消除标题结果提交引发的重复历史读取循环；模型页取当前权威快照会话；导航拒绝未保存配置时不再变更路由历史。媒体结果先保留目标级插入意图，回到工作台后再合并原草稿，不自动发送。终端“新建”先加载真实终端面板，再执行一次创建，不与首次自动初始化双建。

壳读模型按 authority、workspace、Runtime 与安装环境分别失效：会话切换仍读取目标 Runtime 的能力和命令清单，不沿用其他 Runtime 的权限事实；同构建居民切换不重新扫描项目/安装环境。准备中 Host 项目和历史仍可读取，Runtime 相关域等就绪后读取。缓存只保留各域最后成功提交的作用域键和在途请求，不保留多份永久数据快照。

隐藏控件已补齐请求所有权：fallback 队列和录制状态把在途锁保存在组件引用中，运行/待处理数和可见性变化只合并一次补读，旧 effect 的结果与错误不能回写新目标。录制回放收到面板可见性后暂停 RAF、位置更新与后续绘制；恢复时保留文件、位置和原 xterm 实例，播放由用户显式继续。生产 Electron 回放到 259ms 后隐藏 700ms、恢复，三次位置读取均为 259ms，未发生错误。Host 录制、PTY 输出和后台模型工作不停止。

生产 Electron 完整 App 隔离夹具已完成 30 次会话选择和 3 组“工作台 → 首页 → 设置 → 工作台”往返：模型页身份与当前快照一致，项目与环境总读取均保持 1 次；离开工作台 Engine/Store 各为 0，返回各为 1；终端首用创建 1 次，往返后仍为 1。一次真实标题更新只增加 3 次历史读取，结果提交后不再重复刷新。这是 10 个居民元数据行的合成验证，没有启动 10 个真实 OMP 进程，不作为长期 CPU/RSS 性能数据。

## 复现入口

使用现有 `scripts/check.mjs` 的 renderer/desktop/host-client-api/production 切片。完整壳基准：

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright PERF_REPORT=outputs/perf/workbench.json node scripts/startup-perf.mjs
```

性能基准只手动运行，不加入普通 CI 或发布门禁。`scripts/artifact-inventory.mjs` 可单独统计生产目录；原有 streaming/render-work 脚本支持 `PERF_URL` 接入已经启动的生产预览服务器，不需要另起服务器。
