# Changelog

All notable changes to OMP Studio are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **侧栏会话行「更多」菜单**：左侧对话列表每行的 ⋯ 按钮与行右键均可打开与顶栏「对话选项」同款的菜单（重命名 / Fork / Handoff / Compact / 导出 / 会话历史 / 归档），弹层稍窄；右键时菜单贴光标弹出。动作作用于所在行会话：非当前会话先打开（必要时切换工作区并 resume）再执行；预览演示行的会话动作保持禁用，归档仍为本地演示行为。

### Changed

- **流式渲染性能重构**：对话正文改为增量渲染。已完成的顶层 markdown 块在流式过程中只解析、只高亮一次并缓存元素，每个 chunk 仅重新解析尾部两块（脚注 / 链接引用定义出现时自动退回整篇渲染，保证结果一致）；快照之间复用未变化的时间线行，`MarkdownText` / `MessageBody` / 变更卡与 Plan 绑定表补上 memo 与稳定回调；engine 通知按动画帧合并（首次同步 + 帧尾补一次）。渲染结果的 DOM 与样式与改造前逐字节一致（测试断言 innerHTML 相等）。实测：单条 12.8KB 回复的流式渲染 2142ms → 448ms（120 tick），31 行 transcript 带流式尾行 389ms/帧 → 3.3ms/帧。
- **会话切换加载与显示性能**：切回最近看过的会话时先画上次渲染的行（按 sessionId 的 LRU，5 条会话 / 每条 60 行）并作为行复用基线，新页落地后未变化的行沿用旧对象，正文不再整页重新解析；驻留会话在 `session.resume` 期间不再先读一次归档页（600ms 兜底回落），一次切换只读一遍 transcript；用户气泡缩略图与 hydrate 合并成同一次提交；恢复超过 16 行时按动画帧从尾部铺开；一次提交里的多次贴底合并为一条链。Host 侧 `session-archive-reader` 改为追加式续读（只解析新增字节、滚动哈希算 revision）、投影结果可续算缓存、快照缓存命中刷新 LRU 顺序，整档解析 / 哈希按 8ms 时间片让出事件循环。实测 3 万条消息（12.5MB）的会话：追加后重读 260ms → 60ms，缓存命中 12ms，冷读期间主进程最长停顿 173ms → 16ms；续读得到的 revision 与 items 与整档重读逐字节一致（测试断言）。


## [0.1.1] - 2026-08-16

### Added

- **供应商模型自动获取能力**：模型配置 · 供应商新增 / 编辑页「模型」区块新增「自动获取模型」按钮。支持直接读取该供应商的模型列表接口（OpenAI 兼容 `/models`、Anthropic `/v1/models`、Google Generative AI、Ollama `/api/tags` 等），解析提取上下文窗口（Context Window）、输出上限（Max Output）及思考/视觉能力，生成可勾选清单一键导入 Custom Models。

### Fixed

- **运行时动态新增模型切换报错**：修复在供应商页新增模型后返回工作台切换报错 `runtime rejected the request arguments` 的问题。在模型切换未命中时主动触发 `modelRegistry.refresh("offline")` 热重载本地配置，与 OMP 内置 `/model` 保持一致，无需重启即可无缝热生效。
- **全新环境 Runtime 初始化与冷启动**：修复在电脑原先未安装 OMP 且无 `~/.omp` 目录的纯净环境下 Runtime 解析失败与初始化异常问题，完善自动初始化与环境骨架补齐逻辑。
- **思考强度格式校验与序列化**：修复在新建供应商与添加模型时，思考强度（Thinking Budget）格式解析与离散/数值模式映射问题，确保配置正确保存与加载。
- **Host 账本与错误回执展示**：优化失败回执文案，优先保留 Runtime 真实的拒绝原因（如 `Model is not available: provider/id`），避免统一被压缩为固定的无意义报错。

## [0.1.0] - 2026-08-15

- 初始正式版本发布，提供 OMP Studio 桌面工作台、Session 管理、审批模式与工具链集成。

[0.1.1]: https://github.com/the-snowpear/omp-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/the-snowpear/omp-studio/releases/tag/v0.1.0
