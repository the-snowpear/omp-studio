# Changelog

All notable changes to OMP Studio are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
