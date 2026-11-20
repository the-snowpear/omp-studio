import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createDraft } from "../src/commit/selective/draft";
import { ChangeJournal } from "../src/commit/selective/journal";
import {
	COMMIT_DRAFT_LEASE_MS,
	CommitDraftStore,
	createCommitPrelude,
	draftFor,
} from "../src/commit/selective/prelude-definition";
import { Settings } from "../src/config/settings";
import { StudioBridgeDispatcher } from "../src/studio/bridge-dispatcher";
import type { StudioReceipt, StudioRequest } from "../src/studio/bridge-protocol";
import type { StudioStateProjector } from "../src/studio/state-projector";
import type { StudioHostRuntime } from "../src/studio/studio-host-mode";
import type {
	SelectiveCommitDraft,
	SelectiveCommitOperation,
	SelectiveCommitPreview,
} from "../src/studio/commit-protocol";
import { type CommitServiceSession, StudioCommitService } from "../src/studio/services/commit-service";
import type { ToolSession } from "../src/tools";

const tempDirs: string[] = [];
const services: StudioCommitService[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const service of services.splice(0)) service.dispose();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

/** Fixture setup only. Product git operations must use the compiled native VCS. */
async function git(cwd: string, args: string[]): Promise<string> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: cwd,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
	delete env.GIT_INDEX_FILE;
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${stderr}`);
	return stdout;
}

interface FixtureSession extends CommitServiceSession {
	sessionId: string;
	transcriptEpoch: number;
}
interface Fixture {
	root: string;
	artifacts: string;
	journal: ChangeJournal;
	session: FixtureSession;
	service: StudioCommitService;
	setEpoch(value: number): void;
	write(agent: string, file: string, after: string, parent?: string): Promise<void>;
}

async function fixture(
	seed: Record<string, string> = { "file.txt": "header\nbase\nfooter\n", "staged.txt": "original\n" },
): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-selective-"));
	const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "studio-selective-journal-"));
	tempDirs.push(root, artifacts);
	await git(root, ["init", "-q", "-b", "main"]);
	for (const [key, value] of Object.entries({
		"user.name": "Test",
		"user.email": "test@example.invalid",
		"commit.gpgSign": "false",
		"core.hooksPath": ".git/hooks",
		"core.autocrlf": "false",
	})) {
		await git(root, ["config", key, value]);
	}
	for (const [name, text] of Object.entries(seed)) await Bun.write(path.join(root, name), text);
	if (Object.keys(seed).length) {
		await git(root, ["add", "."]);
		await git(root, ["commit", "-q", "-m", "fixture base"]);
	}
	const journal = ChangeJournal.at(artifacts);
	const session: FixtureSession = {
		sessionId: crypto.randomUUID(),
		transcriptEpoch: 1,
		settings: Settings.isolated({ "commit.enabled": true }),
		sessionManager: { getCwd: () => root, getArtifactsDir: () => artifacts },
		getAgentId: () => "Main",
	};
	let epoch = 1;
	const service = new StudioCommitService(session, () => epoch);
	services.push(service);
	return {
		root,
		artifacts,
		journal,
		session,
		service,
		setEpoch: value => {
			epoch = value;
		},
		write: async (agent, file, after, parent) => {
			const absolute = path.join(root, file);
			const before = await Bun.file(absolute)
				.text()
				.catch(() => null);
			await Bun.write(absolute, after);
			journal.recordChange({ agent, parent, tool: "edit", path: absolute, before, after });
			await journal.flush();
		},
	};
}

function pointer(f: Fixture, draft: SelectiveCommitDraft) {
	return { sessionId: f.session.sessionId, draftId: draft.view.id, revision: draft.view.revision };
}
async function prepare(f: Fixture, scope?: string): Promise<SelectiveCommitDraft> {
	return f.service.execute({
		kind: "commit.draft.prepare",
		sessionId: f.session.sessionId,
		...(scope ? { scope } : {}),
	});
}
async function preview(f: Fixture, draft: SelectiveCommitDraft): Promise<SelectiveCommitPreview> {
	return f.service.execute({ kind: "commit.draft.preview", ...pointer(f, draft) });
}
function executeOperation(
	f: Fixture,
	draft: SelectiveCommitDraft,
	prepared: SelectiveCommitPreview,
): Extract<SelectiveCommitOperation, { kind: "commit.draft.execute" }> {
	return {
		kind: "commit.draft.execute",
		...pointer(f, draft),
		previewId: prepared.previewId,
		message: { subject: "confirmed selection" },
	};
}
async function shared(f: Fixture): Promise<void> {
	await f.write("Other", "file.txt", "header\nforeign\nbase\nfooter\n");
	await f.write("Main", "file.txt", "header\nown\nforeign\nbase\nfooter\n");
	await f.write("Child", "child.txt", "child\n", "Main");
	await Bun.write(path.join(f.root, "staged.txt"), "user staged\n");
	await git(f.root, ["add", "staged.txt"]);
}
function prelude(f: Fixture) {
	const session = {
		cwd: f.root,
		settings: f.session.settings,
		hasUI: false,
		getSessionId: () => f.session.sessionId,
		getAgentId: () => "Main",
		getArtifactsDir: () => f.artifacts,
		getSessionSpawns: () => null,
		registerDisposeCallback: (callback: () => void) => {
			cleanups.push(callback);
		},
	} as ToolSession;
	const commit = createCommitPrelude(session);
	return { session, commit };
}

async function hook(f: Fixture, name: string, body: string): Promise<string> {
	const file = path.join(f.root, ".git/hooks", name);
	await Bun.write(file, `#!/bin/sh\n${body}\n`);
	await fs.chmod(file, 0o755);
	return file;
}

describe("native selective commit confirmation", () => {
	it("shows native own/other units and subtree scope, commits own only, and leaves other staged content untouched", async () => {
		const f = await fixture();
		await shared(f);
		const draft = await prepare(f);
		const changed = draft.view.paths.find(file => file.path === "file.txt")!;
		expect(changed.ownership.sort()).toEqual(["other", "own"]);
		expect(changed.selected).toBe("partial");
		expect(changed.hunks[0].units.find(unit => unit.actor === "Main")).toMatchObject({
			selected: "all",
			ownership: ["own"],
		});
		expect(changed.hunks[0].units.find(unit => unit.actor === "Other")).toMatchObject({
			selected: "none",
			ownership: ["other"],
		});
		expect(draft.view.agents.find(agent => agent.id === "Child")).toMatchObject({ parent: "Main", inScope: true });
		expect(draft.view.agents.find(agent => agent.id === "Other")).toMatchObject({ inScope: false });
		expect(draft.view.staged).toContain("staged.txt");
		const self = await prepare(f, "self");
		expect(self.view.paths.find(file => file.path === "child.txt")?.selected).toBe("none");
		const prepared = await preview(f, draft);
		const body = await f.service.execute({
			kind: "commit.draft.read",
			...pointer(f, draft),
			body: { kind: "preview", previewId: prepared.previewId },
		});
		expect(body.body?.text).toContain("+own");
		expect(body.body?.text).not.toContain("+foreign");
		await f.service.execute(executeOperation(f, draft, prepared));
		expect(await git(f.root, ["show", "HEAD:file.txt"])).toBe("header\nown\nbase\nfooter\n");
		expect(await git(f.root, ["show", "HEAD:child.txt"])).toBe("child\n");
		expect(await git(f.root, ["show", "HEAD:staged.txt"])).toBe("original\n");
		expect(await git(f.root, ["diff", "--cached", "--name-only"])).toBe("staged.txt\n");
		expect(await Bun.file(path.join(f.root, "file.txt")).text()).toContain("foreign");
	});

	it("shares native selection actions with eval, fences stale revisions/HEAD, and preserves CLI automatic rebasing", async () => {
		const f = await fixture();
		await shared(f);
		const native = await draftFor({
			cwd: f.root,
			artifactsDir: f.artifacts,
			agent: "Main",
			sessionId: f.session.sessionId,
		});
		let draft = (
			await f.service.execute({
				kind: "commit.draft.read",
				sessionId: f.session.sessionId,
				draftId: native.id,
				revision: native.revision,
			})
		).draft;
		const units = draft.view.paths.find(file => file.path === "file.txt")!.hunks[0].units;
		const own = units.find(unit => unit.actor === "Main")!.id;
		const other = units.find(unit => unit.actor === "Other")!.id;
		const stale = pointer(f, draft);
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "drop", path: "file.txt", units: [own] },
		});
		await expect(f.service.execute({ kind: "commit.draft.read", ...stale })).rejects.toThrow(/revision/);
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "take", path: "file.txt", units: [other] },
		});
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "only", paths: ["file.txt"] },
		});
		const prepared = await preview(f, draft);
		await git(f.root, ["commit", "-q", "--allow-empty", "-m", "intervening", "--only"]);
		await expect(f.service.execute(executeOperation(f, draft, prepared))).rejects.toThrow(/HEAD/);
		const cli = prelude(f);
		await cli.commit.invoke!(
			{ action: "commit", draft: native.id, subject: "explicit other unit" },
			{ session: cli.session, toolCallId: "commit-test" },
		);
		expect(await git(f.root, ["show", "HEAD:file.txt"])).toBe("header\nforeign\nbase\nfooter\n");
		expect(await git(f.root, ["ls-tree", "--name-only", "HEAD", "child.txt"])).toBe("");
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("3\n");
	});

	it("opens Studio /commit without committing or treating opaque native instructions as flags", async () => {
		const f = await fixture();
		await f.write("Main", "file.txt", "candidate\n");
		const prepared = await f.service.prepareFromArgs("  --amend --no-verify fix the selected changes  ");
		expect(prepared.instructions).toBe("--amend --no-verify fix the selected changes");
		expect(prepared.draft.view.paths.find(file => file.path === "file.txt")?.selected).toBe("all");
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
	});

	it("does not auto-select entangled review hunks", async () => {
		const f = await fixture();
		await f.write("Other", "file.txt", "header\nforeign\nbase\nfooter\n");
		await f.write("Main", "file.txt", "header\nrewritten foreign\nbase\nfooter\n");
		const draft = await prepare(f);
		const changed = draft.view.paths.find(file => file.path === "file.txt")!;
		expect(changed.ownership).toEqual(["review"]);
		expect(changed.selected).toBe("none");
		expect(changed.hunks[0].units.flatMap(unit => unit.reasons)).toContainEqual({
			kind: "entangled",
			with: ["Other"],
		});
		await expect(preview(f, draft)).rejects.toThrow(/Nothing selected/);
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
	});

	it("freezes binary bytes for an initial commit and rejects a whole-file change after preview", async () => {
		const f = await fixture({});
		const file = path.join(f.root, "binary.dat");
		await Bun.write(file, new Uint8Array([0, 1, 2, 255]));
		let draft = await prepare(f);
		expect(draft.view.head).toBeNull();
		expect(draft.view.paths[0]).toMatchObject({ kind: "binary", selected: "none", change: "added" });
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "take", path: "binary.dat" },
		});
		const first = await preview(f, draft);
		const changed = new Uint8Array([0, 7, 2, 254]);
		await Bun.write(file, changed);
		await expect(f.service.execute(executeOperation(f, draft, first))).rejects.toThrow(/changed/);
		expect(await vcs.requireGit(f.root).headSha()).toBeNull();
		await expect(preview(f, draft)).rejects.toThrow(/changed/);
		draft = await prepare(f);
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "take", path: "binary.dat", units: ["1a"] },
		});
		const confirmed = await preview(f, draft);
		const outcome = await f.service.execute(executeOperation(f, draft, confirmed));
		expect(outcome.parent).toBeNull();
		expect(new Uint8Array((await vcs.requireGit(f.root).showBlob("HEAD:binary.dat")).data)).toEqual(changed);
		await expect(
			vcs.requireGit(f.root).commitCreate("stale unborn confirmation", { expectedHead: "", allowEmpty: true }),
		).rejects.toMatchObject({ code: "HeadMoved" });
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
	});

	it("rejects selected text changed after preview instead of silently committing the old selection", async () => {
		const f = await fixture();
		await f.write("Main", "file.txt", "changed\n");
		const draft = await prepare(f);
		const prepared = await preview(f, draft);
		await Bun.write(path.join(f.root, "file.txt"), "changed again\n");
		await expect(f.service.execute(executeOperation(f, draft, prepared))).rejects.toThrow(/changed/);
		expect(await git(f.root, ["show", "HEAD:file.txt"])).toBe("header\nbase\nfooter\n");
	});

	it("freezes mode-only changes as whole units", async () => {
		const f = await fixture({ "mode.txt": "unchanged\n" });
		await git(f.root, ["update-index", "--chmod=+x", "mode.txt"]);
		await git(f.root, ["commit", "-q", "-m", "executable baseline"]);
		await git(f.root, ["config", "core.filemode", "true"]);
		await fs.chmod(path.join(f.root, "mode.txt"), 0o644);
		let draft = await prepare(f);
		expect(draft.view.paths[0]).toMatchObject({
			kind: "mode",
			beforeMode: "100755",
			afterMode: "100644",
			selected: "none",
		});
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "take", path: "mode.txt" },
		});
		const prepared = await preview(f, draft);
		await f.service.execute(executeOperation(f, draft, prepared));
		expect(await git(f.root, ["ls-tree", "HEAD", "mode.txt"])).toMatch(/^100644 blob/);
	});

	it("freezes symlink targets rather than the content they point to", async () => {
		const f = await fixture();
		await fs.symlink("file.txt", path.join(f.root, "link"));
		let draft = await prepare(f);
		expect(draft.view.paths.find(file => file.path === "link")?.kind).toBe("symlink");
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "take", path: "link" },
		});
		const prepared = await preview(f, draft);
		await fs.unlink(path.join(f.root, "link"));
		await fs.symlink("staged.txt", path.join(f.root, "link"));
		await expect(f.service.execute(executeOperation(f, draft, prepared))).rejects.toThrow(/changed/);
		expect(await git(f.root, ["ls-tree", "--name-only", "HEAD", "link"])).toBe("");
		draft = await prepare(f);
		draft = await f.service.execute({
			kind: "commit.draft.select",
			...pointer(f, draft),
			selection: { action: "take", path: "link" },
		});
		await f.service.execute(executeOperation(f, draft, await preview(f, draft)));
		expect(await git(f.root, ["ls-tree", "HEAD", "link"])).toMatch(/^120000 blob/);
		expect(await git(f.root, ["show", "HEAD:link"])).toBe("staged.txt");
	});

	it("only amends a HEAD made by this native session flow when explicitly requested", async () => {
		const f = await fixture();
		await f.write("Main", "file.txt", "first selective\n");
		let draft = await prepare(f);
		let prepared = await preview(f, draft);
		await expect(
			f.service.execute({ ...executeOperation(f, draft, prepared), options: { amend: true } }),
		).rejects.toThrow(/not made by this session/);
		await f.service.execute(executeOperation(f, draft, prepared));
		await f.write("Main", "file.txt", "amended selective\n");
		draft = await prepare(f);
		prepared = await preview(f, draft);
		await f.service.execute({ ...executeOperation(f, draft, prepared), options: { amend: true } });
		expect(await git(f.root, ["show", "HEAD:file.txt"])).toBe("amended selective\n");
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("2\n");
	});

	it("keeps a failed hook draft editable, requires explicit noVerify, and double execute creates just one commit", async () => {
		const f = await fixture();
		await f.write("Main", "file.txt", "hook candidate\n");
		const draft = await prepare(f);
		const prepared = await preview(f, draft);
		await hook(f, "pre-commit", "printf 'policy failure' >&2\nexit 1");
		const operation = executeOperation(f, draft, prepared);
		await expect(f.service.execute(operation)).rejects.toThrow();
		expect((await f.service.execute({ kind: "commit.draft.read", ...pointer(f, draft) })).draft.view.state).toBe(
			"open",
		);
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
		const explicit = { ...operation, options: { noVerify: true } };
		const attempts = await Promise.allSettled([f.service.execute(explicit), f.service.execute(explicit)]);
		expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter(attempt => attempt.status === "rejected")).toHaveLength(1);
		await expect(f.service.execute(explicit)).rejects.toThrow(/expired|committed/);
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("2\n");
	});

	for (const name of ["pre-commit", "commit-msg"]) {
		it(`rejects ${name} staging unpreviewed content into the private index, then retries the frozen preview`, async () => {
			const f = await fixture();
			await f.write("Main", "file.txt", "previewed\n");
			await Bun.write(path.join(f.root, "staged.txt"), "not previewed\n");
			const draft = await prepare(f);
			const prepared = await preview(f, draft);
			const hookFile = await hook(f, name, "git add -- staged.txt");
			await expect(f.service.execute(executeOperation(f, draft, prepared))).rejects.toThrow(
				/index changed after preview/,
			);
			expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
			expect(await git(f.root, ["diff", "--cached", "--name-only"])).toBe("");
			await fs.rm(hookFile);
			await f.service.execute(executeOperation(f, draft, prepared));
			expect(await git(f.root, ["show", "HEAD:staged.txt"])).toBe("original\n");
			expect(await git(f.root, ["show", "HEAD:file.txt"])).toBe("previewed\n");
		});
	}

	it("replays a completed execute through the existing dispatcher receipts without another native commit", async () => {
		const f = await fixture();
		await f.write("Main", "file.txt", "receipt candidate\n");
		const draft = await prepare(f);
		const prepared = await preview(f, draft);
		let executions = 0;
		const runtime = {
			runtimeEpoch: 1,
			sessionId: f.session.sessionId,
			session: { ...f.session, isStreaming: false, isCompacting: false },
			services: {
				permissions: {},
				transcript: {},
				interaction: { bind: () => {}, unbind: () => {} },
				btw: { onChange: () => () => {} },
				tree: { cancelReanswer: () => {} },
				workbench: {
					views: { cancelClose: () => {} },
					execute: async (operation: SelectiveCommitOperation) => {
						executions++;
						return f.service.execute(operation);
					},
				},
			},
		} as unknown as StudioHostRuntime;
		const projector = {
			stateVersion: 0,
			commitStateChange: () => {},
			recordTerminalReceipt: () => {},
		} as unknown as StudioStateProjector;
		const receipts: StudioReceipt[] = [];
		const dispatcher = new StudioBridgeDispatcher(runtime, projector, (_id, frame) => {
			if (frame.type === "studio.receipt") receipts.push(frame);
		});
		cleanups.push(() => dispatcher.dispose());
		const request: StudioRequest = {
			type: "studio.request",
			requestId: "execute-first",
			runtimeEpoch: 1,
			idempotencyKey: "same-confirmation",
			operation: executeOperation(f, draft, prepared),
		};
		await dispatcher.dispatch(request);
		expect(receipts.at(-1)?.status).toBe("completed");
		const result = receipts.at(-1)?.result;
		await dispatcher.dispatch({ ...request, requestId: "execute-replay" });
		expect(receipts.at(-1)).toMatchObject({ requestId: "execute-replay", status: "completed", result });
		expect(executions).toBe(1);
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("2\n");
	});

	it("expires drafts on Runtime/session changes and bounds native leases without advancing HEAD", async () => {
		const f = await fixture();
		await f.write("Main", "file.txt", "candidate\n");
		const draft = await prepare(f);
		const prepared = await preview(f, draft);
		f.setEpoch(2);
		await expect(f.service.execute(executeOperation(f, draft, prepared))).rejects.toThrow(/expired/);
		const next = await prepare(f);
		f.session.transcriptEpoch++;
		await expect(f.service.execute({ kind: "commit.draft.read", ...pointer(f, next) })).rejects.toThrow(/expired/);
		const current = await prepare(f);
		await expect(
			f.service.execute({ kind: "commit.draft.read", ...pointer(f, current), sessionId: "another-session" }),
		).rejects.toThrow(/current native session/);
		let now = Date.now();
		const store = new CommitDraftStore(() => now);
		cleanups.push(() => store.clear());
		const native = await createDraft({ cwd: f.root, journal: f.journal, caller: "Main" });
		store.remember(native, undefined);
		const frozen = await store.preview(native.id, native.revision);
		now += COMMIT_DRAFT_LEASE_MS + 1;
		await expect(
			store.commit(
				native.id,
				{ subject: "too late" },
				{ journal: f.journal, agent: { agent: "Main" } },
				{ revision: native.revision, previewId: frozen.id },
			),
		).rejects.toThrow(/expired/);
		expect(await git(f.root, ["rev-list", "--count", "HEAD"])).toBe("1\n");
	});
});
