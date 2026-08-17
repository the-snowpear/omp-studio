import { describe, expect, test } from "bun:test";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	expandSkillPrompts,
	listSkillInvocationNames,
} from "@oh-my-pi/pi-coding-agent/studio/services/skill-prompt-expansion";

const build = async (skill: { name: string }, args: string) => ({
	message: `SKILL:${skill.name}`,
	details: { name: skill.name, path: `/skills/${skill.name}/SKILL.md`, args: args || undefined, lineCount: 1 },
});

function sessionOf(
	names: readonly string[],
	enableSkillCommands: boolean | undefined = true,
): {
	skills: Array<{ name: string; filePath: string; baseDir: string }>;
	skillsSettings: { enableSkillCommands: boolean };
} {
	return {
		skills: names.map(name => ({ name, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}` })),
		skillsSettings: { enableSkillCommands: enableSkillCommands === true },
	};
}

describe("listSkillInvocationNames", () => {
	test("keeps first-seen order and drops duplicates", () => {
		expect(listSkillInvocationNames("/skill:alpha /skill:beta fix this /skill:alpha")).toEqual(["alpha", "beta"]);
	});

	test("finds a mid-prompt token", () => {
		expect(listSkillInvocationNames("please /skill:commit-msg the staged files")).toEqual(["commit-msg"]);
	});

	test("ignores other leading slash commands", () => {
		expect(listSkillInvocationNames("/compact /skill:alpha")).toEqual([]);
	});

	test("ignores local-execution prefixes", () => {
		expect(listSkillInvocationNames("!git status /skill:alpha")).toEqual([]);
		expect(listSkillInvocationNames("$ print(1) /skill:alpha")).toEqual([]);
	});
});

describe("expandSkillPrompts", () => {
	test("builds one prelude per known skill and skips unknown names", async () => {
		const result = await expandSkillPrompts(
			sessionOf(["alpha", "beta"]),
			"/skill:alpha /skill:ghost /skill:beta please",
			build,
		);
		expect(result.names).toEqual(["alpha", "beta"]);
		expect(result.preludes.map(prelude => prelude.customType)).toEqual([
			SKILL_PROMPT_MESSAGE_TYPE,
			SKILL_PROMPT_MESSAGE_TYPE,
		]);
		expect(result.preludes.map(prelude => prelude.content)).toEqual(["SKILL:alpha", "SKILL:beta"]);
		expect(result.preludes.every(prelude => prelude.attribution === "user")).toBe(true);
		expect(result.preludes.every(prelude => prelude.display === true)).toBe(true);
	});

	test("passes empty args so the user body is not copied into each sheet", async () => {
		const args: string[] = [];
		await expandSkillPrompts(sessionOf(["alpha"]), "/skill:alpha do the thing", async (skill, skillArgs) => {
			args.push(skillArgs);
			return build(skill, skillArgs);
		});
		expect(args).toEqual([""]);
	});

	test("does nothing when skill commands are disabled", async () => {
		const result = await expandSkillPrompts(sessionOf(["alpha"], false), "/skill:alpha", build);
		expect(result).toEqual({ preludes: [], names: [] });
	});

	test("does nothing for /compact and !cmd drafts", async () => {
		await expect(expandSkillPrompts(sessionOf(["alpha"]), "/compact /skill:alpha", build)).resolves.toEqual({
			preludes: [],
			names: [],
		});
		await expect(expandSkillPrompts(sessionOf(["alpha"]), "!ls /skill:alpha", build)).resolves.toEqual({
			preludes: [],
			names: [],
		});
	});
});
