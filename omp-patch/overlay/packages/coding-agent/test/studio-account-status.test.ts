import { describe, expect, it, mock } from "bun:test";
import type { AgentSession } from "../src/session/agent-session";
import { StudioAccountStatusService } from "../src/studio/services/account-status-service";

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
