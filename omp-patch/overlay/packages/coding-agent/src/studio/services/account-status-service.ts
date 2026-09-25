import { createHash } from "node:crypto";
import type { OAuthAccountSummary, ResetCreditAccountStatus, UsageReport } from "@oh-my-pi/pi-ai";
import { resolveUsedFraction } from "@oh-my-pi/pi-ai/usage";
import type { AgentSession } from "../../session/agent-session";
import type {
	AccountQuotaWindow,
	AccountResetStatus,
	AccountStatusResult,
	StudioAccountStatus,
} from "../accounts-protocol";
import { validateAccountStatus } from "../accounts-protocol";

const clean = (value: string) =>
	value
		.replace(/[\u0000-\u001f]/gu, " ")
		.trim()
		.slice(0, 512);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const accountId = (provider: string, identity: string) =>
	"account-" +
	createHash("sha256")
		.update(provider + ":" + identity)
		.digest("hex")
		.slice(0, 32);
export function accountMatchesReport(account: OAuthAccountSummary, report: UsageReport): boolean {
	const metadata = report.metadata ?? {};
	if (typeof metadata.orgId === "string" && metadata.orgId !== account.orgId) return false;
	if (typeof metadata.accountId === "string") return metadata.accountId === account.accountId;
	if (typeof metadata.email === "string") return metadata.email === account.email;
	return false;
}
export function projectQuota(report: UsageReport): AccountQuotaWindow[] {
	return report.limits.slice(0, 64).map(limit => {
		const fraction = resolveUsedFraction(limit);
		return {
			id: clean(limit.id) || "quota",
			label: clean(limit.label) || "Quota",
			status: limit.status ?? (finite(fraction) ? (fraction >= 1 ? "exhausted" : "ok") : "unknown"),
			...(finite(fraction) ? { usedFraction: fraction } : {}),
			...(finite(limit.window?.resetsAt) ? { resetsAt: limit.window!.resetsAt! } : {}),
			...(limit.scope.modelId ? { model: clean(limit.scope.modelId) } : {}),
		};
	});
}
function resetStatus(status: ResetCreditAccountStatus | undefined, fetched: boolean): AccountResetStatus {
	if (!status || status.error) return { state: fetched ? "unavailable" : "unfetched", credits: [] };
	return {
		state: "available",
		availableCount: status.availableCount,
		...(status.redeemableCount === undefined ? {} : { redeemableCount: status.redeemableCount }),
		...(status.eligible === undefined ? {} : { eligible: status.eligible }),
		credits: status.credits.slice(0, 64).map(credit => ({
			title: clean(credit.title ?? credit.program ?? "Saved reset"),
			...(credit.status ? { status: clean(credit.status) } : {}),
			...(credit.expiresAt ? { expiresAt: clean(credit.expiresAt) } : {}),
			...(finite(credit.remainingCount) ? { remainingCount: credit.remainingCount } : {}),
			...(credit.usable === undefined ? {} : { usable: credit.usable }),
			...(credit.requiresLimit === undefined ? {} : { requiresLimit: credit.requiresLimit }),
			clears: (credit.clears ?? []).slice(0, 32).map(clean),
		})),
	};
}

/** Read-only quota/reset status. Does not call AgentSession's auto-redemption heartbeat. */
export class StudioAccountStatusService {
	#reports: UsageReport[] = [];
	#resets: ResetCreditAccountStatus[] = [];
	#refreshedAt: number | undefined;
	#usageUnavailable = false;
	#refreshing: Promise<void> | undefined;
	#abort: AbortController | undefined;
	constructor(readonly session: AgentSession) {}
	dispose(): void {
		this.#abort?.abort();
	}
	async get(refresh = false): Promise<AccountStatusResult> {
		const auth = this.session.modelRegistry.authStorage;
		if (refresh) {
			this.#refreshing ??= (async () => {
				const controller = new AbortController();
				this.#abort = controller;
				const timer = setTimeout(() => controller.abort(), 30000);
				try {
					const reports = auth.usage
						.invalidate(undefined, controller.signal)
						.then(() => auth.usage.reports({ signal: controller.signal }));
					const resets = Promise.all(
						["anthropic", "openai-codex"].map(provider =>
							auth.oauth.accounts(provider).length
								? auth.resets
										.list({ provider, sessionId: this.session.sessionId, signal: controller.signal })
										.catch(() => [])
								: Promise.resolve([]),
						),
					);
					const [usage, credits] = await Promise.allSettled([reports, resets]);
					this.#reports = usage.status === "fulfilled" ? (usage.value ?? []) : [];
					this.#usageUnavailable = usage.status === "rejected" || usage.value === null;
					this.#resets = credits.status === "fulfilled" ? credits.value.flat() : [];
					this.#refreshedAt = Date.now();
				} finally {
					clearTimeout(timer);
					this.#abort = undefined;
				}
			})().finally(() => {
				this.#refreshing = undefined;
			});
			await this.#refreshing;
		}
		const providers = new Set([
			...auth.credentials.list().map(row => row.provider),
			...this.session.modelRegistry.getAvailable("all").map(model => model.provider),
		]);
		const accounts: StudioAccountStatus[] = [];
		const assigned = new Set<UsageReport>();
		for (const provider of providers) {
			const native = auth.oauth.accounts(provider, this.session.sessionId);
			for (const account of native) {
				const matches = this.#reports.filter(
					report =>
						report.provider === provider &&
						accountMatchesReport(account, report) &&
						native.filter(candidate => accountMatchesReport(candidate, report)).length === 1,
				);
				const report = matches.sort((left, right) => right.fetchedAt - left.fetchedAt)[0];
				if (report) matches.forEach(item => assigned.add(item));
				accounts.push({
					id: accountId(provider, String(account.credentialId)),
					provider,
					label: clean(account.email ?? account.accountId ?? "Account " + (account.position + 1)),
					...(account.orgName ? { organization: clean(account.orgName) } : {}),
					source: "oauth",
					active: account.active,
					limits: report ? projectQuota(report) : [],
					...(report ? { reportedAt: report.fetchedAt } : {}),
					resets: resetStatus(
						this.#resets.find(item => item.provider === provider && item.credentialId === account.credentialId),
						this.#refreshedAt !== undefined,
					),
				});
			}
			const source = auth.keys.source(provider);
			if (!native.length && source)
				accounts.push({
					id: accountId(provider, "key"),
					provider,
					label: provider,
					source: source.concrete ? "api-key" : "ambient",
					active: this.session.model?.provider === provider,
					limits: [],
					resets: { state: "unfetched", credits: [] },
				});
		}
		const unassigned = this.#reports
			.filter(report => !assigned.has(report))
			.map(report => ({ provider: report.provider, reportedAt: report.fetchedAt, limits: projectQuota(report) }));
		const result: AccountStatusResult = {
			accounts: accounts.slice(0, 200),
			unassigned: unassigned.slice(0, 200),
			...(this.#refreshedAt === undefined ? {} : { refreshedAt: this.#refreshedAt }),
			refreshing: this.#refreshing !== undefined,
			usageUnavailable: this.#usageUnavailable,
			truncated: accounts.length > 200 || unassigned.length > 200,
		};
		while (Buffer.byteLength(JSON.stringify(result)) > 800000) {
			result.truncated = true;
			if (result.unassigned.length) result.unassigned.pop();
			else result.accounts.pop();
		}
		validateAccountStatus(result);
		return result;
	}
}
