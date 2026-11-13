export interface AccountQuotaScope {
  provider: string; accountId?: string; projectId?: string; orgId?: string; modelId?: string;
  tier?: string; windowId?: string; shared?: boolean; sharedGroup?: string;
}
export interface AccountQuotaWindow {
  id: string; label: string; status: "ok" | "warning" | "exhausted" | "unknown";
  usedFraction?: number; resetsAt?: number; model?: string;
  scope?: AccountQuotaScope; notes?: string[]; resetLabel?: string;
}
export interface AccountResetCredit {
  title: string; status?: string; expiresAt?: string; remainingCount?: number;
  usable?: boolean; requiresLimit?: boolean; clears: string[];
}
export interface AccountResetStatus {
  state: "unfetched" | "available" | "unavailable";
  availableCount?: number; redeemableCount?: number; eligible?: boolean; credits: AccountResetCredit[];
}
export interface AccountRoutingPolicy { priority: number; reservePct: number; reserveSource: "global" | "override"; state: "eligible" | "inside-reserve" | "exhausted" | "unknown"; remainingPct?: number; reclaimAbovePct?: number }
export interface StudioAccountStatus {
  policy?: AccountRoutingPolicy;
  id: string; provider: string; label: string; organization?: string;
  source: "oauth" | "api-key" | "ambient"; active: boolean;
  limits: AccountQuotaWindow[]; reportedAt?: number; resets: AccountResetStatus;
}
export interface AccountStatusResult {
  accounts: StudioAccountStatus[];
  unassigned: Array<{ provider: string; reportedAt: number; limits: AccountQuotaWindow[] }>;
  refreshedAt?: number; refreshing: boolean; usageUnavailable: boolean; truncated: boolean;
}
