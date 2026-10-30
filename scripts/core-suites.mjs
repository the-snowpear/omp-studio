// Core regression list. One source of truth for `npm run check`, `npm run test:core`
// and CI. Keep it on end-user workflows; page details and fixtures belong to the
// package suites, not the default gate.
//
// Paths are relative to the repository root. Node suites run against compiled output
// (`dist/`), renderer suites run through Vitest against sources.

export const CORE_NODE_SUITES = [
  // Bridge contracts, client receipts, and both transport adapters.
  "packages/studio-protocol/dist/test/protocol.test.js",
  "packages/studio-protocol/dist/test/conversation.test.js",
  "packages/client/dist/test/reducer.test.js",
  "packages/client/dist/test/receipt-selectors.test.js",
  "packages/testkit/dist/test/transport-contract.test.js",
  // Opening, recovering, browsing and deleting conversations.
  "packages/studio-host/dist/test/backend-lifecycle.test.js",
  "packages/studio-host/dist/test/conversation-open.test.js",
  "packages/studio-host/dist/test/conversation-open-slice.test.js",
  "packages/studio-host/dist/test/session-catalog.test.js",
  "packages/studio-host/dist/test/session-delete-service.test.js",
  "packages/host-client-api/dist/test/conversation-open.test.js",
  "packages/host-client-api/dist/test/facade-history.test.js",
  "packages/host-client-api/dist/test/snapshot-clone.test.js",
  "packages/host-client-api/dist/test/session-delete-command.test.js",
  "apps/desktop/dist/test/runtime-session.test.js",
  "apps/desktop/dist/test/runtime-multi-session.test.js",
  "apps/desktop/dist/test/session-commands.test.js",
  // Local file writes, Electron boundaries, installation and update recovery.
  "apps/desktop/dist/test/workspace-files.test.js",
  "apps/desktop/dist/test/security.test.js",
  "apps/desktop/dist/test/desktop-ipc-subscriptions.test.js",
  "apps/desktop/dist/test/perf-profile.test.js",
  "apps/desktop/dist/test/terminal-batch.test.js",
  "apps/desktop/dist/test/terminal-flow-control.test.js",
  "apps/desktop/dist/test/update-v2.test.js",
  "packages/runtime-installer/dist/test/installer.test.js",
  "packages/runtime-installer/dist/test/installer-verification-cache.test.js",
  "packages/runtime-installer/dist/test/update-v2.test.js",
  "packages/studio-host/dist/test/runtime-executable-verification.test.js",
];

export const CORE_RENDERER_SUITES = [
  "src/composer/ChipComposer.test.tsx",
  "src/composer/dispatch.test.ts",
  "src/composer/serialize.test.ts",
  "src/conversation/conversationStore.test.ts",
  "src/conversation/useConversation.test.ts",
  "src/InteractionDeck.test.tsx",
  "src/sessionLifecycle.test.ts",
  "src/HistoryPage.test.tsx",
  "src/settings/DesktopUpdateRecovery.test.tsx",
  // Dock workbench: layout model, persistence, the stable host layer and the
  // body→card-column wheel handoff. Narrow-window drawers are covered by the
  // App-level suite so a regression in the layout solver fails the gate.
  "src/dock/model.test.ts",
  "src/dock/store.test.ts",
  "src/dock/hosts.test.ts",
  "src/dock/scrollChain.test.ts",
  "src/App.dockRegion.test.tsx",
  "src/layout/useWorkbenchLayout.test.tsx",
  "src/terminalSessions.test.tsx",
  "src/usage/usagePolling.test.ts",
  "src/perf/tiers.test.ts",
  "src/perf/tierControl.test.ts",
  "src/App.composerPerf.test.tsx",
];
