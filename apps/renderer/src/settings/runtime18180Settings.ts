import type { Definition } from "./FeatureSettingsPane";

export const RUNTIME_18180_SETTINGS: Definition[] = [
  { key: "magicKeywords.enabled", group: "interaction", zh: "魔法关键词", en: "Magic keywords", hint: "允许独立关键词调整当前任务的执行策略。", hintEn: "Allow standalone keywords to adjust the current task's execution strategy." },
  { key: "magicKeywords.chillax", group: "interaction", zh: "Chillax 关键词", en: "Chillax keyword", hint: "chillax 让支持的模型使用最低推理档位并简短回答。", hintEn: "chillax requests the lowest supported reasoning effort and brief replies." },
  {
    "key": "out.enabled",
    "group": "interaction",
    "zh": "中途回复",
    "en": "Interim replies",
    "hint": "允许 Agent 通过 out:// 回复并继续当前任务。",
    "hintEn": "Allow out:// replies while the current task keeps running."
  },
  {
    "key": "btw.inject",
    "group": "interaction",
    "zh": "BTW 注入主会话",
    "en": "BTW steering injection",
    "hint": "旁路回答可生成纠偏建议，由你点击后发送给主会话。",
    "hintEn": "Offer steering suggestions in side answers; send them to the main session explicitly."
  },
  {
    "key": "composer.predictionAlternatives",
    "group": "interaction",
    "zh": "多条消息建议",
    "en": "Prediction alternatives",
    "hint": "同一次预测最多生成四条候选；接受只填入草稿。",
    "hintEn": "Offer up to four choices from one prediction request; accepting only fills the draft."
  },
  {
    "key": "display.shellVisualization",
    "group": "interaction",
    "zh": "Shell 执行可视化",
    "en": "Shell visualization",
    "hint": "查看原始命令或伪代码、变量和执行回放。",
    "hintEn": "Inspect Raw or Pseudo source, values and execution history."
  },
  {
    "key": "title.refreshAfterPrompts",
    "group": "interaction",
    "zh": "标题检查间隔",
    "en": "Title refresh interval",
    "hint": "每 N 条用户消息检查自动标题；0 关闭，手动标题保留。会调用 judge。",
    "hintEn": "Check generated titles every N user prompts; 0 disables it. User titles stay unchanged. Uses the judge.",
    "min": 0,
    "max": 1000000,
    "step": 1
  },
  {
    "key": "display.advisorCollapsedLines",
    "group": "tasks",
    "zh": "Advisor 折叠预览行数",
    "en": "Collapsed advisor lines",
    "hint": "0 显示完整预览。",
    "hintEn": "0 keeps the full preview.",
    "min": 0,
    "max": 1000000,
    "step": 1
  },
  {
    "key": "task.file",
    "group": "tasks",
    "zh": "从文件读取任务",
    "en": "Task instructions from files",
    "hint": "允许绝对 UTF-8 文件或 local:// 任务文件，沿用原生文件审批。",
    "hintEn": "Allow UTF-8 files and local:// task files under native file approvals."
  },
  {
    "key": "task.perCallModel",
    "group": "tasks",
    "zh": "单次任务模型选择",
    "en": "Per-call task models",
    "hint": "只允许原生配置授权的精确模型；项目配置只能收紧范围。",
    "hintEn": "Only exact models granted by native configuration; project settings can only narrow it.",
    "options": [
      [
        "off",
        "关闭",
        "Off"
      ],
      [
        "eval",
        "仅 Eval",
        "Eval only"
      ],
      [
        "on",
        "开启",
        "On"
      ]
    ]
  },
  {
    "key": "task.perCallModelAllow",
    "group": "tasks",
    "zh": "单次模型限制列表",
    "en": "Per-call model allowlist",
    "hint": "每行一个 provider/model；空列表沿用原生授权范围。",
    "hintEn": "One provider/model per line; an empty list keeps the native grant scope.",
    "list": true
  },
  {
    "key": "task.workerThreads",
    "group": "tasks",
    "zh": "子 Agent 工作线程上限",
    "en": "Subagent worker limit",
    "hint": "0 全部在主线程；9 个并发任务起启用工作线程。",
    "hintEn": "0 keeps agents on the main thread; workers join at nine concurrent agents.",
    "min": 0,
    "max": 1000000,
    "step": 1
  },
  {
    "key": "ovnfs.path",
    "group": "tasks",
    "zh": "ovnfs 程序路径",
    "en": "ovnfs executable",
    "hint": "留空使用 PATH 中的 ovnfs；auto 隔离会自动使用可用的 ovnfs。",
    "hintEn": "An empty path uses ovnfs on PATH; automatic isolation uses it when available.",
    "text": true
  },
  {
    "key": "prewalk.from",
    "group": "tasks",
    "zh": "Prewalk 规划模型",
    "en": "Prewalk planning model",
    "hint": "重启规划使用的模型或角色。",
    "hintEn": "Model or role used when restarting planning.",
    "text": true
  },
  {
    "key": "prewalk.into",
    "group": "tasks",
    "zh": "Prewalk 交接模型",
    "en": "Prewalk handoff model",
    "hint": "首次编辑后继续工作的模型或角色。",
    "hintEn": "Model or role that continues after the first edit.",
    "text": true
  },
  {
    "key": "retry.rateLimitWalksChain",
    "group": "models",
    "zh": "限流时立即尝试备用模型",
    "en": "Walk fallback chain on rate limits",
    "hint": "按原生规则在 429 后尝试已配置的备用链。",
    "hintEn": "Use the configured fallback chain on eligible 429 responses."
  },
  {
    "key": "providers.openaiResponsesWebsockets",
    "group": "models",
    "zh": "Responses WebSocket",
    "en": "Responses WebSockets",
    "hint": "为原生目录支持的标准 Responses 模型启用 WebSocket；失败回退 HTTP。",
    "hintEn": "Use WebSockets for supported standard Responses models, with native HTTP fallback."
  },
  {
    "key": "providers.openai-codex.daybreak",
    "group": "models",
    "zh": "Codex Daybreak Blue",
    "en": "Codex Daybreak Blue",
    "hint": "使用符合资格账户的原生访问计划。",
    "hintEn": "Use the native access program on eligible accounts."
  },
  {
    "key": "judgment.attemptTimeoutMs",
    "group": "models",
    "zh": "Judge 候选预算（毫秒）",
    "en": "Judge candidate budget (ms)",
    "hint": "配置备用模型时，每个候选的请求预算；没有备用链时不截断单个慢请求。",
    "hintEn": "Per-candidate deadline when fallbacks exist; a lone slow judge is not cut off.",
    "min": 1,
    "max": 1000000,
    "step": 1
  },
  {
    "key": "skills.manualSkills",
    "group": "context",
    "zh": "仅手动调用的 Skills",
    "en": "Manually invoked skills",
    "hint": "每行一个 glob；从模型目录隐藏匹配技能，保留手动调用。",
    "hintEn": "One glob per line; hide matching skills from the model catalog while keeping manual invocation.",
    "list": true
  },
  {
    "key": "hindsight.globalScope",
    "group": "context",
    "zh": "Hindsight 全局记忆",
    "en": "Hindsight global memories",
    "hint": "允许 retain / learn 保存跨项目记忆；需要 global 或 per-project-tagged 范围。",
    "hintEn": "Allow retain/learn memories shared across projects; requires global or per-project-tagged scoping."
  },
  {
    "key": "tools.xdevNotices",
    "group": "interaction",
    "zh": "工具挂载通知",
    "en": "Tool mount notices",
    "hint": "显示 MCP 或扩展工具挂载及移除的通知。",
    "hintEn": "Show MCP and extension tool mount/unmount notices."
  },
  {
    "key": "spotlight.experiment.enabled",
    "group": "experimental",
    "zh": "Spotlight 实验",
    "en": "Spotlight experiment",
    "hint": "使用 Stencil Spotlight 整理工具输出和排序搜索结果，并记录到会话。",
    "hintEn": "Use Stencil Spotlight to shape tool output and rank search results, recorded in the session."
  },
  {
    "key": "spotlight.url",
    "group": "experimental",
    "zh": "Spotlight 服务地址",
    "en": "Spotlight service URL",
    "hint": "启用实验时使用的评分服务地址。",
    "hintEn": "Scoring service used while the experiment is enabled.",
    "text": true
  },
  {
    "key": "spotlight.model",
    "group": "experimental",
    "zh": "Spotlight 模型",
    "en": "Spotlight model",
    "hint": "评分服务的模型标识。",
    "hintEn": "Model identifier used by the scoring service.",
    "text": true
  },
  {
    "key": "spotlight.thinking",
    "group": "experimental",
    "zh": "Spotlight 推理档位",
    "en": "Spotlight reasoning",
    "hint": "评分请求的推理档位。",
    "hintEn": "Reasoning effort of scoring requests.",
    "options": [
      [
        "low",
        "low",
        "low"
      ],
      [
        "med",
        "med",
        "med"
      ],
      [
        "high",
        "high",
        "high"
      ],
      [
        "max",
        "max",
        "max"
      ]
    ]
  },
  {
    "key": "spotlight.timeoutMs",
    "group": "experimental",
    "zh": "Spotlight 超时（毫秒）",
    "en": "Spotlight timeout (ms)",
    "hint": "超时后使用原生未评分规则。",
    "hintEn": "Use native unranked rules after the deadline.",
    "min": 1,
    "max": 1000000,
    "step": 1
  },
  {
    "key": "spotlight.experiment.holdout",
    "group": "experimental",
    "zh": "Spotlight 对照比例",
    "en": "Spotlight holdout share",
    "hint": "保留原始工具结果的对照样本比例。",
    "hintEn": "Share of control samples that keep original tool results.",
    "min": 0,
    "max": 1,
    "step": 0.05
  },
  {
    "key": "spotlight.experiment.scoreFree",
    "group": "experimental",
    "zh": "Spotlight 无评分比例",
    "en": "Spotlight score-free share",
    "hint": "用未评分规则整理输出的样本比例。",
    "hintEn": "Share shaped using unranked rules.",
    "min": 0,
    "max": 1,
    "step": 0.05
  },
  {
    "key": "spotlight.experiment.tools",
    "group": "experimental",
    "zh": "Spotlight 工具范围",
    "en": "Spotlight tool scope",
    "hint": "每行一个工具名；* 表示全部工具。",
    "hintEn": "One tool name per line; * covers every tool.",
    "list": true
  }
];
