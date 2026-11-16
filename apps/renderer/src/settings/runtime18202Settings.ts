import type { Definition } from "./FeatureSettingsPane";

/**
 * OMP 18.20.2 native setting handles. Copy follows the native setting
 * descriptions; values, defaults and sources always come from the Runtime.
 * `models.offline` is a provider policy for auxiliary models, not a network switch.
 */
export const RUNTIME_18202_SETTINGS: Definition[] = [
  { key: "models.noJudge", group: "auxiliary", zh: "Judge 只用当前 Provider", en: "Keep Judge on the session provider",
    hint: "Judge 角色的辅助调用只走当前会话正在用的 Provider，不跨到其他已配置的 Provider。Judge 本身仍会运行。",
    hintEn: "Judge-role auxiliary calls stay on the provider this session uses and never reach other configured providers. Judge itself still runs." },
  { key: "models.noSpotlight", group: "auxiliary", zh: "Spotlight 只用当前 Provider", en: "Keep Spotlight on the session provider",
    hint: "Spotlight 的评分调用只走当前会话的 Provider。是否启用 Spotlight 仍由实验设置决定。",
    hintEn: "Spotlight scoring calls stay on this session's provider. Whether Spotlight runs is still up to the experiment setting." },
  { key: "models.offline", group: "auxiliary", zh: "辅助请求限定当前 Provider", en: "Auxiliary requests: session provider only",
    hint: "同时应用上面两项限制。这是辅助模型的 Provider 使用政策，不会断开网络，也不影响主对话模型；语音转写同样遵守。",
    hintEn: "Applies both restrictions above. A provider policy for auxiliary models: it does not go offline, does not touch the main chat model, and dictation follows it too." },
  { key: "find.verifyModel", group: "auxiliary", zh: "Find 段落校验模型", en: "Find verification model",
    hint: "find 校验段落时先试这个模型（如 openrouter/liquid/d1-ultra），再回到 judge 角色；文件名与草图排序仍由 judge 负责。留空则全部由 judge 校验。",
    hintEn: "Tried first when find verifies passages (e.g. openrouter/liquid/d1-ultra), before the judge role; filename and sketch ranking stay on judge. Empty: judge verifies too.", text: true },
  { key: "find.hitThreshold", group: "auxiliary", zh: "Find 命中阈值", en: "Find hit threshold",
    hint: "段落校验概率达到该值才算命中，也是列出行范围的下限。不同校验模型校准不同；未设置时用内置阈值。",
    hintEn: "Verified-passage probability needed for a hit, and the floor for listed line ranges. Decision models calibrate differently; unset keeps the built-in threshold.", min: 0, max: 1, step: 0.05 },
  { key: "encourageEdits", group: "tasks", zh: "改文件必须用 edit 工具", en: "Require the edit tool",
    hint: "系统提示要求修改文件时使用 edit 工具，禁止用 sed / perl / python 改写；关闭则省略这条指引。",
    hintEn: "The system prompt requires the edit tool for file changes and forbids sed/perl/python rewrites. Off omits that guidance." },
  { key: "commit.enabled", group: "tasks", zh: "选择性提交", en: "Selective commit",
    hint: "启用 /commit 与提交预载：只提交本 Agent 及其子 Agent 写下的行。关闭后选择性提交面板不可用，普通 Git 提交不受影响。",
    hintEn: "Enables /commit and the commit prelude: commit only lines this agent and its subagents wrote. Off disables the selective-commit panel; regular Git commits are unaffected." },
  { key: "todo.midRunNudges", group: "tasks", zh: "长回合待办提醒", en: "Mid-run todo nudges",
    hint: "回合持续改动时，多久提醒一次更新待办列表。",
    hintEn: "How often a long turn is reminded to update its todo list while it keeps changing things.",
    options: [["off", "关闭", "Off"], ["capped", "有上限（12 次改动后，最多两次）", "Capped (after 12 changes, at most twice)"], ["backoff", "间隔翻倍（12、24、48…）", "Backoff (12, 24, 48 …)"]] },
  { key: "ttsr.repeatMode", group: "context", zh: "TTSR 规则重复方式", en: "TTSR repeat mode",
    hint: "规则在一个会话里只触发一次，还是隔若干条消息后可以再次触发。",
    hintEn: "Whether a rule fires once per session, or may fire again after a message gap.",
    options: [["once", "每个会话一次", "Once per session"], ["after-gap", "隔几条消息后可再次触发", "Again after a message gap"]] },
  { key: "shellPath", group: "shell", zh: "Shell 程序路径", en: "Shell executable",
    hint: "Bash 工具使用的 Shell 可执行文件；留空沿用原生默认。", hintEn: "Shell executable used by the bash tool; empty keeps the native default.", text: true },
  { key: "bash.allowedEnvVars", group: "shell", zh: "允许的命令前缀变量", en: "Allowed command env prefixes",
    hint: "匹配 allow 审批规则时，允许出现在命令开头的 KEY=VALUE 变量名（精确名称、无通配，每行一个）。任意值都会被接受，只列无害的构建 / 测试变量；PATH、LD_PRELOAD、BASH_ENV、*_RUNNER、*_WRAPPER 这类会改变执行的变量能执行任意命令。",
    hintEn: "Exact variable names (no wildcards, one per line) allowed as leading KEY=VALUE when matching allow rules. Any value is accepted, so list only benign build/test variables; PATH, LD_PRELOAD, BASH_ENV, *_RUNNER or *_WRAPPER allow arbitrary execution.", list: true },
  { key: "bash.patterns", group: "shell", zh: "Bash 审批规则", en: "Bash approval rules",
    hint: "按顺序匹配的命令审批规则，只支持 * 通配；项目规则排在用户规则之前。", hintEn: "Ordered command approval rules; only * wildcards. Project rules come before user rules.", rules: true },
];
