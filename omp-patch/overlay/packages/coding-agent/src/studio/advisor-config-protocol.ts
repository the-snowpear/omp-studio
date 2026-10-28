export interface AdvisorConfigRow {
	name: string;
	model?: string;
	tools?: string[];
	instructions?: string;
	enabled?: boolean;
	maxNotesPerUpdate?: number;
	reviewMode?: "turn" | "agent-end";
	reviewInterval?: number;
	syncBacklog?: "off" | "1" | "3" | "5" | "strict";
	scope?: "main" | "subagent" | "all";
	includeReasoning?: boolean;
}
export interface AdvisorConfigDocument {
	advisors: AdvisorConfigRow[];
	instructions?: string;
	maxNotesPerUpdate?: number;
}
export interface AdvisorConfigView {
	scope: "user" | "project";
	version: string;
	document: AdvisorConfigDocument;
	warnings: string[];
	active: number;
}
export type AdvisorConfigOperation =
	| { kind: "advisors.config.get"; sessionId: string; scope: "user" | "project" }
	| {
			kind: "advisors.config.save";
			sessionId: string;
			scope: "user" | "project";
			version: string;
			document: AdvisorConfigDocument;
	  };
export interface AdvisorConfigResultMap {
	"advisors.config.get": AdvisorConfigView;
	"advisors.config.save": AdvisorConfigView;
}
export const ADVISOR_CONFIG_KINDS = ["advisors.config.get", "advisors.config.save"] as const;
export function isAdvisorConfigKind(kind: string): kind is AdvisorConfigOperation["kind"] {
	return (ADVISOR_CONFIG_KINDS as readonly string[]).includes(kind);
}
