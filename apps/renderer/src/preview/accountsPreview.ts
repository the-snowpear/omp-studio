import type { AccountStatusResult } from "@omp-studio/studio-protocol";
const previewNow = Date.now();
export const PREVIEW_ACCOUNT_STATUS: AccountStatusResult = {
  refreshing: false,
  usageUnavailable: false,
  truncated: false,
  refreshedAt: previewNow,
  accounts: [
    {
      id: "preview-claude", fastEligibility: { model: "anthropic/claude-opus-4.1", tier: "priority", state: "unknown" }, subscriptionPlan: "Max 20x", credentialId: 1, activeCredential: true,
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
      id: "preview-kiro", provider: "kiro", label: "studio@kiro.example", source: "oauth", active: false, credentialId: 2,
      reportedAt: previewNow, resets: { state: "unfetched", credits: [] },
      limits: [
        { id: "kiro:credits", label: "Monthly plan", status: "exhausted", usedFraction: 1, resetsAt: previewNow + 3 * 86400000 },
        { id: "kiro:bonus:starter", label: "Bonus credits", status: "ok", usedFraction: 0.4, resetsAt: previewNow + 10 * 86400000 },
        { id: "kiro:add-on:purchased", label: "Purchased credits", status: "ok", usedFraction: 0.1 },
        { id: "kiro:overage", label: "Overage", status: "warning" },
      ],
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
