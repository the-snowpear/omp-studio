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
      label: "mira@studio.dev",
      organization: "OMP Studio",
      source: "oauth",
      active: true,
      reportedAt: previewNow,
      resetPolicies: [
        { window: "5h", key: "claudeResets.autoRedeem5h", mode: "unset", source: "default" },
        { window: "weekly", key: "claudeResets.autoRedeemWeekly", mode: "no", source: "global" },
        { window: "fable", key: "claudeResets.autoRedeemFable", mode: "unset", source: "default" },
      ],
      limits: [
        {
          scope: {
            provider: "anthropic",
            tier: "normal",
            shared: true,
            sharedGroup: "team-weekly",
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
    {
      id: "preview-codex", provider: "openai-codex", label: "mira@studio.dev · Codex", source: "oauth", active: false,
      reportedAt: previewNow,
      resetPolicies: [
        { window: "5h", key: "codexResets.autoRedeem5h", mode: "no", source: "global" },
        { window: "weekly", key: "codexResets.autoRedeemWeekly", mode: "unset", source: "default" },
      ],
      limits: [{ id: "openai-codex:primary", label: "5 Hour", status: "unknown" }],
      resets: { state: "unfetched", credits: [] },
    },
    {
      id: "preview-litellm", provider: "litellm", label: "Studio gateway", source: "api-key", active: false,
      reportedAt: previewNow,
      limits: [
        { id: "litellm:key:budget", label: "Key budget", status: "ok", amount: { unit: "usd", used: 4.25, limit: 25, remaining: 20.75 }, scope: { provider: "litellm", windowId: "7d", shared: true } },
        { id: "litellm:user:budget", label: "User budget", status: "unknown", amount: { unit: "usd", used: 9.5 }, scope: { provider: "litellm", shared: true } },
      ],
      resets: { state: "unavailable", credits: [] },
    },
  ],
  unassigned: [],
};
