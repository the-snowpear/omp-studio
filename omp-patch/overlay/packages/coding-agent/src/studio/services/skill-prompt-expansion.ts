import { buildSkillPromptMessage, type Skill } from "../../extensibility/skills";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE } from "../../session/messages";

/** Same token shape the Studio composer serializes: `/skill:<name>`. */
export const SKILL_TOKEN_RE = /(?:^|\s)\/skill:([^\s/]+)(?=\s|$)/g;

export type SkillPromptExpansionSession = {
	readonly skills?: readonly Pick<Skill, "name" | "filePath" | "baseDir">[];
	readonly skillsSettings?: { readonly enableSkillCommands?: boolean };
};

export type SkillPromptExpansion = {
	readonly preludes: CustomMessage[];
	readonly names: string[];
};

const EMPTY_EXPANSION: SkillPromptExpansion = { preludes: [], names: [] };

export type SkillPromptBuilder = typeof buildSkillPromptMessage;

/**
 * First-seen `/skill:<name>` tokens in a user draft. Empty when the draft
 * starts with a different slash command or a TUI local-execution sigil.
 */
export function listSkillInvocationNames(text: string): string[] {
	if (!shouldScanSkillTokens(text)) return [];
	const names: string[] = [];
	const seen = new Set<string>();
	const matcher = new RegExp(SKILL_TOKEN_RE.source, "g");
	for (const match of text.matchAll(matcher)) {
		const name = match[1];
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}

/**
 * Expand every known `/skill:` token into a `skill-prompt` custom message.
 * Unknown names stay in the user text. Args are empty — the user body is the
 * following message, not copied into each skill sheet.
 */
export async function expandSkillPrompts(
	session: SkillPromptExpansionSession,
	text: string,
	build: SkillPromptBuilder = buildSkillPromptMessage,
): Promise<SkillPromptExpansion> {
	if (session.skillsSettings?.enableSkillCommands === false) return EMPTY_EXPANSION;
	const names = listSkillInvocationNames(text);
	if (names.length === 0) return EMPTY_EXPANSION;
	const skills = session.skills ?? [];
	const preludes: CustomMessage[] = [];
	const expanded: string[] = [];
	for (const name of names) {
		const skill = skills.find(candidate => candidate.name === name);
		if (skill === undefined) continue;
		const built = await build(skill, "", "user");
		preludes.push({
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
			timestamp: Date.now(),
		});
		expanded.push(name);
	}
	return { preludes, names: expanded };
}

function shouldScanSkillTokens(text: string): boolean {
	const trimmedStart = text.trimStart();
	if (trimmedStart.startsWith("/") && !trimmedStart.startsWith("/skill:")) return false;
	return !startsWithLocalExecutionPrefix(trimmedStart);
}

/** Mirrors `startsWithLocalExecutionPrefix` in extensibility/skills.ts. */
function startsWithLocalExecutionPrefix(trimmedStart: string): boolean {
	if (trimmedStart.startsWith("!")) return true;
	if (trimmedStart.charCodeAt(0) !== 36 /* $ */) return false;
	if (trimmedStart.charCodeAt(1) === 123 /* { */) return false;
	const sigilLength = trimmedStart.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedStart.charCodeAt(sigilLength);
	if (Number.isNaN(next)) return true;
	return next === 32 /* space */ || next === 9 /* tab */ || next === 10 /* LF */ || next === 13 /* CR */;
}
