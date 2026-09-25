import { expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSession } from "../src/session/agent-session";
import { Settings } from "../src/config/settings";
import type { SkillshareClient } from "../src/skillshare/client";
import { StudioSkillshareService } from "../src/studio/services/skillshare-service";
import type { SkillshareAction, SkillshareActionState, SkillshareReview } from "../src/studio/skillshare-protocol";
const version = {
	version: "1.0.0",
	integrity: "sha512-fixture",
	size: 100,
	fileCount: 1,
	hasScripts: true,
	yanked: false,
	publishedAt: 1,
	publisher: { username: "fixture", avatar: "a" },
	unpackedSize: 100,
};
function registry() {
	return {
		registryUrl: "https://registry.invalid",
		authToken: async () => "private-test-token",
		close() {},
		packument: async () => ({
			scope: "fixture",
			name: "tool",
			description: "test",
			distTags: { latest: "1.0.0" },
			versions: { "1.0.0": version },
			owners: [{ username: "fixture" }],
			keywords: [],
		}),
		version: async () => ({
			...version,
			scope: "fixture",
			name: "tool",
			files: [{ path: "scripts/run.sh", executable: true, size: 10, sha256: "a".repeat(64) }],
		}),
		publish: async () => ({ url: "https://registry.invalid/@fixture/tool" }),
		listTokens: async () => [{ id: "t", name: "test", packages: [], createdAt: 1, token: "sks_DO_NOT_PROJECT" }],
		createToken: async () => ({ id: "new", name: "new", packages: [], createdAt: 1, token: "sks_fake_secret" }),
	};
}
const session = (cwd: string) =>
	({
		sessionId: "s",
		sessionManager: { getCwd: () => cwd },
		settings: Settings.isolated(),
	}) as unknown as AgentSession;
async function prepare(service: StudioSkillshareService, action: SkillshareAction) {
	return (
		(await service.execute({ kind: "skillshare.prepare", sessionId: "s", action })) as { review: SkillshareReview }
	).review;
}
async function settle(service: StudioSkillshareService, id: string): Promise<SkillshareActionState> {
	for (let i = 0; i < 300; i++) {
		const { action } = (await service.execute({ kind: "skillshare.action", sessionId: "s", id })) as {
			action: SkillshareActionState;
		};
		if (action.state !== "running") return action;
		await Bun.sleep(5);
	}
	throw new Error("Registry mock did not settle");
}
it("reviews exact registry versions and scripts, refuses forged confirmation and never repeats a mutation", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-skills-install-"));
	const client = registry();
	let installs = 0;
	const service = new StudioSkillshareService(session(root), {
		directory: root,
		client: async () => client as unknown as SkillshareClient,
		install: async (frozen, options, hooks) => {
			installs++;
			expect(options.specs).toEqual(["@fixture/tool"]);
			expect((await frozen.packument("fixture", "tool")).distTags.latest).toBe("1.0.0");
			expect(await hooks.confirmScripts({ id: "@fixture/tool", version: "1.0.0", files: [] })).toBe(true);
			return [];
		},
	});
	try {
		const review = await prepare(service, { type: "install", specs: ["@fixture/tool"], scope: "project" });
		expect(installs).toBe(0);
		expect(review.changes[0]!.to).toBe("1.0.0");
		expect(review.scripts).toHaveLength(1);
		const request = {
			kind: "skillshare.execute" as const,
			sessionId: "s",
			id: review.id,
			digest: review.digest,
			allowScripts: false,
			allowSecrets: false,
		};
		await expect(service.execute(request)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		await expect(service.execute({ ...request, digest: "0".repeat(64), allowScripts: true })).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
		});
		client.packument = async () => ({ ...(await registry().packument()), distTags: { latest: "2.0.0" } });
		await service.execute({ ...request, allowScripts: true });
		expect((await settle(service, review.id)).state).toBe("completed");
		await service.execute({ ...request, allowScripts: true });
		expect(installs).toBe(1);
		await expect(
			service.execute({ kind: "skillshare.action", sessionId: "other", id: review.id }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		service.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
it("checks packed bytes after review and keeps newly created tokens outside all public results", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-skills-publish-"));
	const source = join(root, "skill");
	await mkdir(source);
	const text = "---\nname: tool\ndescription: Test fixture\nmetadata:\n  version: 1.0.0\n---\nFixture\n";
	await writeFile(join(source, "SKILL.md"), text);
	let publishes = 0;
	const client = registry();
	client.publish = async () => {
		publishes++;
		return { url: "https://registry.invalid/@fixture/tool" };
	};
	const service = new StudioSkillshareService(session(root), {
		directory: root,
		client: async () => client as unknown as SkillshareClient,
	});
	try {
		const review = await prepare(service, { type: "publish", directory: "skill", scope: "fixture" });
		expect(review.files[0]!.path).toBe("SKILL.md");
		expect(publishes).toBe(0);
		await writeFile(join(source, "SKILL.md"), text + "changed\n");
		await service.execute({
			kind: "skillshare.execute",
			sessionId: "s",
			id: review.id,
			digest: review.digest,
			allowScripts: true,
			allowSecrets: true,
		});
		expect((await settle(service, review.id)).state).toBe("failed");
		expect(publishes).toBe(0);
		expect(JSON.stringify(await service.execute({ kind: "skillshare.tokens", sessionId: "s" }))).not.toContain(
			"sks_",
		);
		const token = await prepare(service, { type: "token.create", name: "new", packages: [] });
		await service.execute({
			kind: "skillshare.execute",
			sessionId: "s",
			id: token.id,
			digest: token.digest,
			allowScripts: false,
			allowSecrets: false,
		});
		const result = await settle(service, token.id);
		expect(result.state).toBe("completed");
		expect(result.secretId).toBeDefined();
		expect(JSON.stringify(result)).not.toContain("sks_");
		const files = await readdir(join(root, "skillshare", "secrets"));
		expect(files).toHaveLength(1);
		expect(JSON.parse(await readFile(join(root, "skillshare", "secrets", files[0]!), "utf8")).token).toBe(
			"sks_fake_secret",
		);
	} finally {
		service.dispose();
		await Bun.sleep(10);
		await rm(root, { recursive: true, force: true });
	}
});

it("uses typed maintenance APIs and treats interrupted remote writes as uncertain without retries", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-skills-maintenance-"));
	const calls: string[] = [];
	const client = {
		...registry(),
		setTag: async () => {
			calls.push("tag.set");
		},
		removeTag: async () => {
			calls.push("tag.remove");
		},
		yank: async () => {
			calls.push("yank");
		},
		deprecate: async () => {
			calls.push("deprecate");
		},
		addOwner: async () => {
			calls.push("owner.add");
		},
		removeOwner: async () => {
			calls.push("owner.remove");
		},
		revokeToken: async () => {
			calls.push("token.revoke");
			throw new Error("Connection lost after submission");
		},
	};
	const service = new StudioSkillshareService(session(root), {
		directory: root,
		client: async () => client as unknown as SkillshareClient,
	});
	try {
		const actions: SkillshareAction[] = [
			{ type: "tag.set", package: "@fixture/tool", tag: "stable", version: "1.0.0" },
			{ type: "tag.remove", package: "@fixture/tool", tag: "stable" },
			{ type: "yank", package: "@fixture/tool", version: "1.0.0", yanked: false },
			{ type: "deprecate", package: "@fixture/tool", version: "1.0.0", message: null },
			{ type: "owner.add", package: "@fixture/tool", username: "other" },
			{ type: "owner.remove", package: "@fixture/tool", username: "other" },
			{ type: "token.revoke", id: "t" },
		];
		for (const action of actions) {
			const review = await prepare(service, action);
			const request = {
				kind: "skillshare.execute" as const,
				sessionId: "s",
				id: review.id,
				digest: review.digest,
				allowScripts: false,
				allowSecrets: false,
			};
			await service.execute(request);
			const done = await settle(service, review.id);
			expect(done.state).toBe(action.type === "token.revoke" ? "uncertain" : "completed");
			await service.execute(request);
		}
		expect(calls).toEqual(actions.map(action => action.type));
	} finally {
		service.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("can preview and apply a version bump to an unpublished skill without a version field", async () => {
	const root = await mkdtemp(join(tmpdir(), "studio-skills-version-"));
	const file = join(root, "SKILL.md");
	const original = "---\nname: tool\ndescription: New skill\n---\nInstructions\n";
	await writeFile(file, original);
	const service = new StudioSkillshareService(session(root), {
		directory: root,
		client: async () => registry() as unknown as SkillshareClient,
	});
	try {
		const review = await prepare(service, { type: "version", directory: ".", bump: "patch" });
		expect(await readFile(file, "utf8")).toBe(original);
		await service.execute({
			kind: "skillshare.execute",
			sessionId: "s",
			id: review.id,
			digest: review.digest,
			allowScripts: false,
			allowSecrets: false,
		});
		expect((await settle(service, review.id)).state).toBe("completed");
		expect(await readFile(file, "utf8")).toContain("version:");
		expect(await readFile(join(root, "skillshare", "backups", review.id, "0.original"), "utf8")).toBe(original);
	} finally {
		service.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
