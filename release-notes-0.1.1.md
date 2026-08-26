### OMP Studio v0.1.1 (Runtime: 17.3.7-studio.5)

#### 更新内容：
1. **供应商模型自动获取能力**：供应商新增 / 编辑页新增「自动获取模型」，支持直接读取 OpenAI 兼容接口、Anthropic、Google 及 Ollama 等端点的模型列表，解析上下文上限、输出上限及思考能力，支持批量勾选并一键导入 Custom Models 表单。
2. **运行时动态新增模型切换报错修复**：修复在供应商页新增模型后返回工作台切换报错 `runtime rejected the request arguments` 的问题。在模型切换未命中时主动触发 `modelRegistry.refresh("offline")` 热重载本地配置，实现免重启即刻生效。
3. **全新环境 Runtime 初始化与冷启动**：修复在未安装全局 OMP 或缺失 `~/.omp` 目录的纯净环境下，Runtime 解析失败与初始化异常问题，新增自动初始化与环境骨架补齐逻辑。
4. **思考强度格式校验与序列化**：修复在新建供应商与模型时，思考强度（Thinking Budget）由于数值/枚举格式差异导致的配置保存与解析异常。
5. **Host 账本与错误回执展示优化**：优化失败回执文案，优先保留 Runtime 真实的拒绝原因（如 `Model is not available: provider/id`），避免统一被压缩为固定的无意义报错。
