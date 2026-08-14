# OMP Studio 全能力技术方案包 v3

研究基线：2026-08-10，目标为当前 `can1357/oh-my-pi` main 分支公开能力。

固定源码提交：`45e12e5bb758198a920c6070e7e64cb33b21beac`。

## 规范优先级

`contracts/` 与状态为 Accepted 的 ADR 是实现时的规范事实来源；架构章节用于解释。发生冲突时以前两者为准。`24_OMP_CAPABILITY_IMPLEMENTABILITY.md` 给出当前 OMP 全能力的 GUI 可实现性结论。

本方案的目标不是 ACP parity，也不是 RPC parity，而是尽量实现 **OMP Harness parity**：只要 OMP CLI/Harness 本身具备某项能力，OMP Studio 就尽可能通过一种或多种官方/兼容渠道提供执行、观察、控制、配置和诊断能力。

## 核心结论

OMP Studio 不应只绑定一个协议。采用 `Capability Broker + 多适配器`：

1. `RPC UI v2`：实时会话主通道，最高优先级。
2. `Slash Command over RPC`：调用 OMP 已有但没有独立 RPC command 的确定性本地命令。
3. `OMP CLI`：配置、认证、模型目录、诊断等机器可读命令。
4. `Schema-aware Config/File Adapter`：项目级 config、models.yml、mcp.json、agents/skills/extensions 等文件能力。
5. `OMP Studio Companion Extension`：对当前 RPC 缺失、但 OMP 内部已具备的结构化控制面做窄桥接。
6. `Collab Adapter (Experimental)`：仅作为少数 Agent Hub 控制能力的兼容/研究后备，不作为主通道。
7. `Upstream RPC`：长期最终解。重要控制能力优先向 OMP 上游补 RPC，而不是在 Studio 中重新实现 Harness。

## 目录

- `V3_CHANGELOG.md`：v2 审查缺口在 v3 中的闭环清单。
- `00_EXECUTIVE_SUMMARY.md`：给评审者先看的结论。
- `01_GOALS_AND_PRINCIPLES.md`：目标、非目标、架构红线。
- `02_TARGET_ARCHITECTURE.md`：整体系统架构。
- `03_CAPABILITY_BROKER.md`：多通道能力路由核心。
- `04_CHANNELS.md`：每个接入渠道的职责和风险。
- `05_RUNTIME_PROCESS_MODEL.md`：OMP 进程/Thread/Host 模型。
- `06_RPC_UI_ADAPTER.md`：RPC v2 / rpc-ui 实现要求。
- `07_SLASH_COMMAND_ADAPTER.md`：通过 RPC 调 OMP 本地 slash command。
- `08_CLI_AND_CONFIG_ADAPTERS.md`：CLI、config.yml、models.yml、mcp.json。
- `09_COMPANION_EXTENSION.md`：可选兼容扩展设计。
- `10_SUBAGENT_AND_AGENT_HUB.md`：多 Agent、kill/revive/chat、缺口与方案。
- `11_EXTENSION_AND_DISCOVERY.md`：Skills/Agents/Plugins/Hooks/Tools/MCP。
- `12_MODELS_ROLES_ADVISOR_FALLBACK.md`：模型、Role、Advisor、Fallback。
- `13_PREVIEW_BROWSER_HOST_TOOLS.md`：Preview 与 Host Tools。
- `14_WEB_DESKTOP_PARITY.md`：WebUI 与 Electron 共用架构。
- `15_STATE_AND_DATA_OWNERSHIP.md`：事实来源。
- `16_SECURITY.md`：多通道安全边界。
- `17_FAILURE_RECOVERY.md`：崩溃、断线、版本变化。
- `18_VERSION_AND_CAPABILITY_NEGOTIATION.md`：能力探测而不是版本硬编码。
- `19_TEST_STRATEGY.md`：真实 OMP 版本矩阵与协议回放。
- `20_IMPLEMENTATION_PLAN.md`：分阶段实施。
- `21_UPSTREAM_RPC_PROPOSALS.md`：建议向 OMP 增加的 RPC。
- `22_KNOWN_GAPS.md`：仍然无法自动做到 100% 的部分。
- `23_CODEX_REVIEW_NOTES.md`：希望 Codex 重点攻击的问题。
- `24_OMP_CAPABILITY_IMPLEMENTABILITY.md`：当前 OMP 能力的可实现/有条件/暂不能矩阵。
- `references/CAPABILITY_CHANNEL_MATRIX.csv`：能力到渠道的完整矩阵。
- `references/OMP_SOURCE_MAP.md`：本方案使用的 OMP 一手资料。
- `contracts/`：接口草案。
- `adr/`：关键架构决策。
- `codex/`：可直接交给 Codex 的审查 Prompt/Checklist。

## 评审目标

请不要把“RPC 没有命令”直接判定为“Studio 做不到”。本方案的关键问题是：

- 是否选择了正确的备用渠道；
- 备用渠道是否保持真实 OMP 行为；
- 是否引入了脆弱的内部耦合；
- 哪些缺口应该直接补上游 RPC；
- 哪些能力只需要执行/观察，不需要 GUI 直接控制。
