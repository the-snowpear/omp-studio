import type { AccountStatusResult } from "@omp-studio/studio-protocol";
export const PREVIEW_ACCOUNT_STATUS: AccountStatusResult = {
  refreshing: false, usageUnavailable: false, truncated: false, refreshedAt: 1789000000000,
  accounts: [{ id: "preview-claude", provider: "anthropic", label: "demo@example.com", organization: "Studio demo", source: "oauth", active: true,
    reportedAt: 1789000000000,
    limits: [{ id: "5h", label: "5 Hour", status: "ok", usedFraction: 0.32, resetsAt: 1789010000000 }, { id: "7d", label: "Weekly", status: "warning", usedFraction: 0.82 }],
    resets: { state: "available", availableCount: 2, redeemableCount: 1, eligible: true,
      credits: [{ title: "Saved session reset", usable: true, remainingCount: 1, requiresLimit: true, clears: ["5h"], expiresAt: "2026-10-01T00:00:00.000Z" }] } }],
  unassigned: [],
};
