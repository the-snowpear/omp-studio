/** OMP 18.4.4 settings exposed by the Studio GUI; exact public allowlist. */
export const GUI_SETTING_DEFINITIONS = {
	"providers.cacheWarming": {
		type: "enum",
		values: ["off", "streaming", "idle"],
		default: "idle",
		zh: "提示缓存预热",
		en: "Prompt cache warming",
		note: "空闲预热可能发出计费请求；沿用 Runtime 的成本收益判断。",
		noteEn: "Idle warming may incur charges; native cost-benefit checks apply.",
	},
	"task.speculativeLaunch": {
		type: "boolean",
		default: true,
		zh: "流式提前启动子代理",
		en: "Speculative task launch",
	},
	"providers.openaiLiveSteering": {
		type: "boolean",
		default: true,
		zh: "OpenAI 实时纠偏",
		en: "OpenAI live steering",
	},
	"telemetry.otlpExportEnabled": {
		type: "boolean",
		default: true,
		zh: "OTLP 导出",
		en: "OTLP export",
	},
	"advisor.evictStaleResults": {
		type: "boolean",
		default: true,
		zh: "清理 Advisor 旧工具结果",
		en: "Evict stale advisor results",
	},
	"task.agentCompactionThresholdOverrides": {
		type: "thresholds",
		default: {},
		zh: "子代理压缩阈值",
		en: "Agent compaction thresholds",
		note: '按代理名称配置，例如 {"task":"80%","reviewer":90000}；null 清除继承。',
		noteEn: "Map agent names to percentages or token counts; null clears inherited entries.",
	},
	"mnemopi.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"],
		default: "per-project",
		zh: "记忆作用域",
		en: "Memory scope",
	},
	"tier.openai": {
		type: "enum",
		values: ["none", "auto", "default", "flex", "scale", "priority", "ultrafast"],
		default: "none",
		zh: "OpenAI 默认服务档位",
		en: "OpenAI default tier",
	},
	"tier.anthropic": {
		type: "enum",
		values: ["none", "priority"],
		default: "none",
		zh: "Anthropic 默认服务档位",
		en: "Anthropic default tier",
	},
	"tier.google": {
		type: "enum",
		values: ["none", "flex", "priority"],
		default: "none",
		zh: "Google 默认服务档位",
		en: "Google default tier",
	},
	"tier.subagent": {
		type: "enum",
		values: ["inherit", "none", "auto", "default", "flex", "scale", "priority", "ultrafast"],
		default: "inherit",
		zh: "子代理默认服务档位",
		en: "Subagent default tier",
	},
	"tier.advisor": {
		type: "enum",
		values: ["inherit", "none", "auto", "default", "flex", "scale", "priority", "ultrafast"],
		default: "none",
		zh: "Advisor 默认服务档位",
		en: "Advisor default tier",
	},
	"codexResets.autoRedeem": {
		type: "enum",
		values: ["unset", "yes", "no"],
		default: "unset",
		zh: "Codex 重置券策略",
		en: "Codex reset policy",
	},
	"codexResets.minBlockedMinutes": {
		type: "number",
		default: 60,
		zh: "Codex 最短受限时间（分钟）",
		en: "Codex minimum blocked minutes",
	},
	"codexResets.keepCredits": {
		type: "number",
		default: 0,
		zh: "Codex 保留重置券",
		en: "Codex resets to retain",
	},
	"codexResets.salvageHorizonHours": {
		type: "number",
		default: 12,
		zh: "Codex 到期利用窗口（小时）",
		en: "Codex reset expiry horizon (hours)",
	},
	"ida.enabled": {
		type: "boolean",
		default: true,
		zh: "启用 IDA",
		en: "Enable IDA",
	},
	"ida.python": {
		type: "string",
		default: "",
		zh: "IDA Python 路径",
		en: "IDA Python path",
	},
	"ida.installDir": {
		type: "string",
		default: "",
		zh: "IDA 安装目录",
		en: "IDA installation",
	},
	"ida.maxOpen": {
		type: "number",
		default: 4,
		zh: "同时打开的 IDA 数据库上限",
		en: "Maximum open IDA databases",
	},
	"ida.idleCloseSec": {
		type: "number",
		default: 900,
		zh: "IDA 空闲关闭时间（秒）",
		en: "IDA idle timeout (seconds)",
	},
	"spelling.autocomplete": {
		type: "enum",
		values: ["off", "auto", "ngram", "smollm", "apple"],
		default: "auto",
		zh: "输入预测引擎",
		en: "Input prediction engine",
		note: "自动使用本地 N-gram；SmolLM2 需显式下载。Windows 不提供 Apple 引擎。",
		noteEn: "Auto uses local N-gram. SmolLM2 requires an explicit download; Apple is unavailable on Windows.",
	},
} as const;
export type GuiSettingKey = keyof typeof GUI_SETTING_DEFINITIONS;
type DefinitionValue<D> = D extends { type: "enum"; values: readonly (infer V)[] }
	? V
	: D extends { type: "boolean" }
		? boolean
		: D extends { type: "number" }
			? number
			: D extends { type: "thresholds" }
				? Record<string, number | string | null>
				: string;
export type GuiSettingsSnapshot = { [K in GuiSettingKey]?: DefinitionValue<(typeof GUI_SETTING_DEFINITIONS)[K]> };
export const GUI_SETTING_KEYS = Object.keys(GUI_SETTING_DEFINITIONS) as GuiSettingKey[];
export function isGuiSettingKey(key: string): key is GuiSettingKey {
	return Object.hasOwn(GUI_SETTING_DEFINITIONS, key);
}
export function validateGuiSetting(key: GuiSettingKey, value: unknown): void {
	const d = GUI_SETTING_DEFINITIONS[key];
	if (d.type === "boolean" && typeof value === "boolean") return;
	if (d.type === "string" && typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value))
		return;
	if (
		d.type === "number" &&
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= 2147483647
	)
		return;
	if (d.type === "enum" && typeof value === "string" && (d.values as readonly string[]).includes(value)) return;
	if (d.type === "thresholds" && value && typeof value === "object" && !Array.isArray(value)) {
		const entries = Object.entries(value);
		if (
			entries.length <= 256 &&
			entries.every(
				([name, v]) =>
					name.trim().length > 0 &&
					name.length <= 256 &&
					!/[\u0000-\u001f]/u.test(name) &&
					!["__proto__", "constructor", "prototype"].includes(name) &&
					(v === null ||
						(typeof v === "number" && Number.isSafeInteger(v) && v > 0) ||
						(typeof v === "string" && /^\d+(?:\.\d+)?%$/.test(v) && parseFloat(v) > 0 && parseFloat(v) <= 100)),
			)
		)
			return;
	}
	throw new Error("Invalid value for " + key);
}
