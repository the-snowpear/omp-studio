import type { AccountStatusResult } from "@omp-studio/studio-protocol";
const previewNow = Date.now();
export const PREVIEW_ACCOUNT_STATUS: AccountStatusResult = {
  refreshing: false,
  usageUnavailable: false,
  truncated: false,
  refreshedAt: previewNow,
  accounts: [
    {
      id: "preview-claude",
      provider: "anthropic",
      label: "demo@example.com",
      organization: "Studio demo",
      source: "oauth",
      active: true,
      reportedAt: previewNow,
      limits: [
        {
          scope: {
            provider: "anthropic",
            tier: "normal",
            shared: true,
            sharedGroup: "demo-weekly",
          },
          id: "5h",
          label: "5 Hour",
          status: "ok",
          usedFraction: 0.32,
          resetsAt: previewNow + 2 * 60 * 60 * 1000,
        },
        { id: "7d", label: "Weekly", status: "warning", usedFraction: 0.82 },
      ],
      resets: {
        state: "available",
        availableCount: 2,
        redeemableCount: 1,
        eligible: true,
        credits: [
          {
            title: "Saved session reset",
            usable: true,
            remainingCount: 1,
            requiresLimit: true,
            clears: ["5h"],
            expiresAt: new Date(
              previewNow + 24 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
        ],
      },
    },
  ],
  unassigned: [],
};
