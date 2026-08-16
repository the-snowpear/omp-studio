import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  AuthorityId,
  ClientBootstrap,
  ClientEvent,
  CommandRequestId,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";
import type { CommandId, InteractionId } from "@omp-studio/studio-protocol";
import { HostBackend, type StudioInteractionForward } from "@omp-studio/studio-host";

import { StudioHostClientFacade, type HostRuntimeAccess } from "../src/index.js";

const T0 = "2026-08-15T13:00:00.000Z";
const SESSION = "session-1" as SessionId;

function snapshot() {
  return {
    runtimeId: "rt-1" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 4 as StateVersion,
    sessionId: SESSION,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal" as const, approvalMode: "yolo" as const,
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

function hello() {
  return { runtimeId: "rt-1", runtimeEpoch: 1, classification: "managed" as const };
}

function guiConfirm(requestId = "client-req-1"): StudioInteractionForward {
  return {
    clientRequestId: requestId,
    envelope: {
      type: "studio.event",
      runtimeEpoch: 1 as RuntimeEpoch,
      eventSeq: 9 as never,
      stateVersion: 4 as StateVersion,
      occurredAt: "2026-08-15T13:00:02.000Z",
      event: {
        kind: "interaction.required",
        owner: "gui",
        leaseGeneration: 1,
        request: {
          kind: "confirm",
          interactionId: "int-1" as InteractionId,
          commandId: "cmd-1" as CommandId,
          title: "Confirm drop",
          message: "Drop the session?",
        },
      },
    },
  };
}

function guiResolved(
  outcome: "submitted" | "cancelled" | "aborted" | "expired" = "submitted",
): StudioInteractionForward {
  return {
    envelope: {
      type: "studio.event",
      runtimeEpoch: 1 as RuntimeEpoch,
      eventSeq: 10 as never,
      stateVersion: 5 as StateVersion,
      occurredAt: "2026-08-15T13:00:03.000Z",
      event: {
        kind: "interaction.resolved",
        interactionId: "int-1" as InteractionId,
        commandId: "cmd-1" as CommandId,
        leaseGeneration: 1,
        outcome,
      },
    },
  };
}

async function withFacade(
  runtime: HostRuntimeAccess,
  run: (facade: StudioHostClientFacade) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-ix-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-ix" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      diagnostics: {
        now: () => T0,
        newEntryId: () => "diag-ix" as never,
      },
      install: async () => {
        throw new Error("runtime.install is not wired in interaction tests");
      },
      runtime,
    });
    try {
      await run(facade);
    } finally {
      await facade.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

function lastRequired(received: ClientEvent[]): Extract<ClientEvent, { kind: "interaction.required" }> | undefined {
  for (let index = received.length - 1; index >= 0; index -= 1) {
    if (received[index]!.kind === "interaction.required") {
      return received[index] as Extract<ClientEvent, { kind: "interaction.required" }>;
    }
  }
  return undefined;
}

test("gui-owned interaction is published as interaction.required with title", async () => {
  const listeners: Array<(event: StudioInteractionForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      onInteractionEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => received.push(event));
      listeners[0]!(guiConfirm("gui-req-9"));
      const required = lastRequired(received);
      assert.ok(required);
      assert.equal(required.interaction.requestId, "gui-req-9" as CommandRequestId);
      assert.equal(required.interaction.kind, "confirm");
      if (required.interaction.kind === "confirm") {
        assert.equal(required.interaction.destructive, false);
        assert.equal(required.interaction.message, "Drop the session?");
      }
      assert.equal(required.interaction.title, "Confirm drop");
      assert.equal(required.interaction.sessionId, SESSION);
      assert.equal(required.interaction.leaseGeneration, 1);
    },
  );
});

test("interaction.resolved is published with id/generation/outcome", async () => {
  const listeners: Array<(event: StudioInteractionForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      onInteractionEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => received.push(event));
      listeners[0]!(guiConfirm());
      listeners[0]!(guiResolved("cancelled"));
      let resolved: Extract<ClientEvent, { kind: "interaction.resolved" }> | undefined;
      for (let index = received.length - 1; index >= 0; index -= 1) {
        if (received[index]!.kind === "interaction.resolved") {
          resolved = received[index] as Extract<ClientEvent, { kind: "interaction.resolved" }>;
          break;
        }
      }
      assert.ok(resolved);
      assert.equal(resolved.interactionId, "int-1" as InteractionId);
      assert.equal(resolved.leaseGeneration, 1);
      assert.equal(resolved.outcome, "cancelled");
      assert.equal("value" in resolved, false);
      assert.equal(JSON.stringify(resolved).includes("Drop the session?"), false);
    },
  );
});

test("tui-owned interaction is not published as a submittable Deck prompt", async () => {
  const listeners: Array<(event: StudioInteractionForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      onInteractionEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => received.push(event));
      const tui = guiConfirm();
      tui.envelope.event = {
        ...(tui.envelope.event as Extract<StudioInteractionForward["envelope"]["event"], { kind: "interaction.required" }>),
        owner: "tui",
      };
      listeners[0]!(tui);
      assert.equal(received.some((event) => event.kind === "interaction.required"), false);
      const diagnostics = await facade.query({ queryName: "diagnostics.get", input: {} });
      assert.equal(diagnostics.ok, true);
      if (!diagnostics.ok) return;
      assert.ok(diagnostics.result.entries.some((entry) => /terminal-owned|TUI/i.test(entry.message)));
    },
  );
});

test("interaction without a client requestId is still published", async () => {
  const listeners: Array<(event: StudioInteractionForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      onInteractionEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => received.push(event));
      const { clientRequestId: _ignored, ...rest } = guiConfirm();
      listeners[0]!(rest);
      const required = lastRequired(received);
      assert.ok(required);
      assert.equal("requestId" in required.interaction, false);
    },
  );
});

test("same interactionId with a higher generation is published as an update", async () => {
  const listeners: Array<(event: StudioInteractionForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      onInteractionEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => received.push(event));
      listeners[0]!(guiConfirm());
      const updated = guiConfirm();
      updated.envelope.event = {
        ...(updated.envelope.event as Extract<StudioInteractionForward["envelope"]["event"], { kind: "interaction.required" }>),
        leaseGeneration: 2,
        owner: "gui",
      };
      listeners[0]!(updated);
      assert.equal(received.filter((event) => event.kind === "interaction.required").length, 2);
    },
  );
});

test("reload of a new facade does not replay old interaction events", async () => {
  const listeners = new Set<(event: StudioInteractionForward) => void>();
  const runtime: HostRuntimeAccess = {
    hello,
    snapshot,
    onInteractionEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  await withFacade(runtime, async (first) => {
    const firstEvents: ClientEvent[] = [];
    first.subscribe({ scope: "all" }, (event) => firstEvents.push(event));
    for (const listener of listeners) listener(guiConfirm());
    assert.equal(firstEvents.filter((event) => event.kind === "interaction.required").length, 1);
    await first.close();
  });
  await withFacade(runtime, async (second) => {
    const secondEvents: ClientEvent[] = [];
    second.subscribe({ scope: "all" }, (event) => secondEvents.push(event));
    assert.equal(secondEvents.some((event) => event.kind === "interaction.required"), false);
  });
});

test("bootstrap restores a pending GUI interaction from the snapshot", async () => {
  const withPending: HostRuntimeAccess = {
    hello,
    snapshot: () => ({
      ...snapshot(),
      pendingInteraction: {
        request: {
          kind: "select",
          interactionId: "int-1" as InteractionId,
          commandId: "cmd-1" as CommandId,
          title: "Pick a branch",
          options: [
            { id: "option:0", label: "main" },
            { id: "option:1", label: "dev" },
          ],
        },
        owner: "gui" as const,
        leaseGeneration: 2,
      },
    }),
  };
  await withFacade(withPending, async (facade) => {
    const bootstrap: ClientBootstrap = await facade.bootstrap();
    assert.ok(bootstrap.pendingInteraction);
    assert.equal(bootstrap.pendingInteraction.kind, "select");
    if (bootstrap.pendingInteraction.kind === "select") {
      assert.equal(bootstrap.pendingInteraction.title, "Pick a branch");
      assert.equal(bootstrap.pendingInteraction.leaseGeneration, 2);
      assert.equal("requestId" in bootstrap.pendingInteraction, false);
    }
  });
});

test("bootstrap hides a TUI-owned pending interaction", async () => {
  const withTuiPending: HostRuntimeAccess = {
    hello,
    snapshot: () => ({
      ...snapshot(),
      pendingInteraction: {
        request: {
          kind: "confirm",
          interactionId: "int-1" as InteractionId,
          commandId: "cmd-1" as CommandId,
          title: "TUI confirm",
          message: "Handle me in the terminal",
        },
        owner: "tui" as const,
        leaseGeneration: 1,
      },
    }),
  };
  await withFacade(withTuiPending, async (facade) => {
    const bootstrap: ClientBootstrap = await facade.bootstrap();
    assert.equal(bootstrap.pendingInteraction, undefined);
  });
});
