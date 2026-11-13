import { describe, expect, it, mock } from "bun:test";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { projectQuota, StudioAccountStatusService } from "../src/studio/services/account-status-service";

describe("Studio read-only account status", () => {
	it("refreshes status without redemption or ambiguous cross-organization quota assignment", async () => {
		const reports = mock(async () => [
			{
				provider: "anthropic",
				fetchedAt: 10,
				metadata: { accountId: "shared" },
				raw: { token: "secret" },
				limits: [
					{
						id: "weekly",
						label: "Weekly",
						scope: { provider: "anthropic" },
						amount: { unit: "percent", used: 75 },
					},
				],
			},
		]);
		const listResets = mock(async () => [
			{
				provider: "anthropic",
				credentialId: 1,
				active: true,
				availableCount: 2,
				credits: [{ id: "private-credit-id", title: "Reset", remainingCount: 2, usable: true, clears: ["weekly"] }],
			},
		]);
		const redeem = mock(async () => {
			throw new Error("must never redeem");
		});
		const auth = {
			credentials: { list: () => [{ provider: "anthropic", key: "private-key" }] },
			keys: { source: () => ({ concrete: true }) },
			oauth: {
				policy: () => undefined,
				accounts: (provider: string) =>
					provider === "anthropic"
						? [
								{
									credentialId: 1,
									position: 0,
									accountId: "shared",
									orgId: "org-a",
									email: "user@example.com",
									active: true,
								},
								{
									credentialId: 2,
									position: 1,
									accountId: "shared",
									orgId: "org-b",
									email: "user@example.com",
									active: false,
								},
							]
						: [],
			},
			usage: { invalidate: async () => {}, reports },
			resets: { list: listResets, redeem },
		};
		const service = new StudioAccountStatusService({
			sessionId: "session",
			settings: Settings.isolated(),
			modelRegistry: { authStorage: auth, getAvailable: () => [] },
		} as unknown as AgentSession);
		const cold = await service.get(false);
		expect(reports).toHaveBeenCalledTimes(0);
		expect(cold.accounts[0]?.resets.state).toBe("unfetched");
		const [result] = await Promise.all([service.get(true), service.get(true)]);
		expect(reports).toHaveBeenCalledTimes(1);
		expect(listResets).toHaveBeenCalledTimes(1);
		expect(redeem).toHaveBeenCalledTimes(0);
		expect(result.accounts.every(account => account.limits.length === 0)).toBe(true);
		expect(result.unassigned[0]?.limits[0]?.usedFraction).toBe(0.75);
		expect(result.accounts[0]?.resets.availableCount).toBe(2);
		const wire = JSON.stringify(result);
		for (const secret of ["private-key", "private-credit-id", '"credentialId"', '"raw"', "secret"])
			expect(wire.includes(secret)).toBe(false);
		service.dispose();
	});
});

it("signs out the exact native credential when account labels are duplicated, rejecting stale or cross-session targets", async () => {
	let accounts = [
		{ credentialId: 31, position: 0, email: "same@example.test", orgId: "one", active: true },
		{ credentialId: 47, position: 1, email: "same@example.test", orgId: "two", active: false },
	];
	const removeById = mock(async (provider: string, id: number) => {
		expect(provider).toBe("anthropic");
		const found = accounts.some(account => account.credentialId === id);
		accounts = accounts.filter(account => account.credentialId !== id);
		return found;
	});
	const refreshProvider = mock(async () => {}),
		refreshScopedModels = mock(async () => {});
	const auth = {
		credentials: { list: () => [{ provider: "anthropic" }], reload: async () => {}, removeById },
		oauth: { accounts: () => accounts, policy: () => undefined },
		keys: { source: () => undefined, describe: () => undefined },
	};
	const service = new StudioAccountStatusService({
		sessionId: "owner",
		settings: Settings.isolated(),
		refreshScopedModels,
		modelRegistry: { authStorage: auth, getAvailable: () => [], refreshProvider },
	} as unknown as AgentSession);
	const rows = (await service.get()).accounts;
	await expect(service.logout("other", rows[1]!.id)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	expect(removeById).not.toHaveBeenCalled();
	expect(await service.logout("owner", rows[1]!.id)).toEqual({ loggedOut: true });
	expect(removeById).toHaveBeenCalledWith("anthropic", 47);
	expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
	expect(refreshScopedModels).toHaveBeenCalledTimes(1);
	expect((await service.get()).accounts.map(account => account.id)).toEqual([rows[0]!.id]);
	await expect(service.logout("owner", rows[1]!.id)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	expect(removeById).toHaveBeenCalledTimes(1);
	service.dispose();
});

it("LiteLLM key and user USD budgets belong to one calling account and absent budgets remain unknown", async () => {
	const reports = mock(async () => [
		{
			provider: "litellm",
			fetchedAt: 100,
			metadata: { accountId: "user" },
			limits: [
				{
					id: "litellm:key:budget",
					label: "Key budget",
					scope: { provider: "litellm" },
					amount: { unit: "usd", used: 4, limit: 25, remaining: 21 },
				},
				{
					id: "litellm:user:budget",
					label: "User budget",
					scope: { provider: "litellm" },
					amount: { unit: "usd", used: 9 },
				},
			],
		},
	]);
	const redeem = mock(async () => {
		throw new Error("must not redeem");
	});
	const auth = {
		credentials: { list: () => [{ provider: "litellm" }] },
		keys: { source: (provider: string) => (provider === "litellm" ? { concrete: true } : undefined) },
		oauth: { accounts: () => [], policy: () => undefined },
		usage: { invalidate: async () => {}, reports },
		resets: { list: async () => [], redeem },
	};
	const service = new StudioAccountStatusService({
		sessionId: "owner",
		settings: Settings.isolated(),
		modelRegistry: { authStorage: auth, getAvailable: () => [] },
	} as unknown as AgentSession);
	const result = await service.get(true, true);
	expect(result.accounts).toHaveLength(1);
	expect(result.unassigned).toEqual([]);
	expect(result.accounts[0]?.limits[0]?.amount).toEqual({ unit: "usd", used: 4, limit: 25, remaining: 21 });
	expect(result.accounts[0]?.limits[1]?.amount).toEqual({ unit: "usd", used: 9 });
	expect(result.accounts[0]?.limits[1]?.usedFraction).toBeUndefined();
	expect(redeem).not.toHaveBeenCalled();
	service.dispose();
});

it("legacy reset consent is read through native migration without extending it to Fable", async () => {
	const settings = Settings.isolated({ "claudeResets.autoRedeem": "yes", "codexResets.autoRedeem": "no" });
	const reports = mock(async () => []),
		resets = mock(async () => []);
	const auth = {
		credentials: { list: () => [{ provider: "anthropic" }, { provider: "openai-codex" }] },
		keys: { source: () => undefined },
		oauth: {
			policy: () => undefined,
			accounts: (provider: string) => [
				{ credentialId: 1, position: 0, email: provider + "@example.test", active: false },
			],
		},
		usage: { reports },
		resets: { list: resets },
	};
	const service = new StudioAccountStatusService({
		sessionId: "owner",
		settings,
		modelRegistry: { authStorage: auth, getAvailable: () => [] },
	} as unknown as AgentSession);
	const result = await service.get(false);
	const claude = result.accounts.find(row => row.provider === "anthropic")!.resetPolicies!;
	expect(claude.map(row => [row.key, row.mode])).toEqual([
		["claudeResets.autoRedeem5h", "yes"],
		["claudeResets.autoRedeemWeekly", "yes"],
		["claudeResets.autoRedeemFable", "unset"],
	]);
	expect(result.accounts.find(row => row.provider === "openai-codex")?.resetPolicies?.map(row => row.mode)).toEqual([
		"no",
		"no",
	]);
	expect(reports).not.toHaveBeenCalled();
	expect(resets).not.toHaveBeenCalled();
	service.dispose();
});

it("saving a governing-window policy changes only its live native key and performs no quota or credit read", async () => {
	const settings = Settings.isolated();
	const reports = mock(async () => []),
		resets = mock(async () => []);
	const service = new StudioAccountStatusService({
		sessionId: "owner",
		settings,
		modelRegistry: { authStorage: { usage: { reports }, resets: { list: resets } } },
	} as unknown as AgentSession);
	const policy = await service.setResetPolicy("owner", "claudeResets.autoRedeem5h", "no");
	expect(policy).toMatchObject({ window: "5h", key: "claudeResets.autoRedeem5h", mode: "no", source: "global" });
	expect(settings.mirrorState().global.claudeResets).toEqual({ autoRedeem5h: "no" });
	expect(reports).not.toHaveBeenCalled();
	expect(resets).not.toHaveBeenCalled();
	service.dispose();
});

it("quota details opt in to new fields while the old status response remains readable", () => {
	const report = {
		provider: "test",
		fetchedAt: 123,
		limits: [
			{
				id: "weekly",
				label: "Weekly",
				scope: {
					provider: "test",
					projectId: "project",
					orgId: "organization",
					shared: true,
					sharedGroup: "group",
					tier: "low_priority",
				},
				amount: { unit: "percent" as const, usedFraction: 0.8 },
				notes: ["Lower priority allowance"],
				window: { id: "7d", label: "Weekly", resetsAt: 900, resetLabel: "regen" },
			},
		],
	};
	const legacy = projectQuota(report)[0]!;
	expect("scope" in legacy).toBe(false);
	expect("notes" in legacy).toBe(false);
	expect("resetLabel" in legacy).toBe(false);
	expect(projectQuota(report, true)[0]).toMatchObject({
		scope: report.limits[0]!.scope,
		notes: ["Lower priority allowance"],
		resetLabel: "regen",
		resetsAt: 900,
	});
});
