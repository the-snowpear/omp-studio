import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  AuthorityId,
  ClientEvent,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";
import { HostBackend, type StudioBtwForward } from "@omp-studio/studio-host";

import {
  StudioHostClientFacade,
  type HostRuntimeAccess,
  type HostRuntimeHelloView,
} from "../src/index.js";

const T0 = "2026-08-18T09:00:00.000Z";
const SESSION = "session-1" as SessionId;

function snapshot(runtimeEpoch = 1) {
  return {
    runtimeId: "rt-1" as RuntimeId,
    runtimeEpoch: runtimeEpoch as RuntimeEpoch,
    stateVersion: 4 as StateVersion,
    sessionId: SESSION,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal" as const,
    approvalMode: "yolo" as const,
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

function hello(): HostRuntimeHelloView {
  return { runtimeId: "rt-1", runtimeEpoch: 1, classification: "managed" };
}

function btwForward(runtimeEpoch: number, text: string): StudioBtwForward {
  return {
    envelope: {
      type: "studio.event",
      runtimeEpoch: runtimeEpoch as RuntimeEpoch,
      eventSeq: 8 as never,
      stateVersion: 4 as StateVersion,
      occurredAt: T0,
      event: {
        kind: "btw.changed",
        snapshot: { ephemeralId: "ephemeral-1", status: "running", text },
      },
    },
  };
}

async function withFacade(
  runtime: HostRuntimeAccess,
  run: (facade: StudioHostClientFacade) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-btw-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-btw" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      diagnostics: {
        now: () => T0,
        newEntryId: () => "diag-btw" as never,
      },
      install: async () => {
        throw new Error("runtime.install is not wired in BTW tests");
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

test("BTW deltas emit btw.changed with the live session identity", async () => {
  let publish: (event: StudioBtwForward) => void = () => {};
  await withFacade(
    {
      hello,
      snapshot: () => snapshot(),
      onBtwEvent: (listener) => {
        publish = listener;
        return () => {
          publish = () => {};
        };
      },
    },
    async (facade) => {
      const events: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => events.push(event));
      publish(btwForward(1, "partial answer"));
      const last = events.at(-1);
      assert.equal(last?.kind, "btw.changed");
      if (last?.kind !== "btw.changed") return;
      assert.equal(last.sessionId, SESSION);
      assert.equal(last.eventSeq, 8);
      assert.equal(last.snapshot.text, "partial answer");
    },
  );
});

test("BTW deltas whose Runtime epoch does not match the live snapshot are dropped", async () => {
  let publish: (event: StudioBtwForward) => void = () => {};
  await withFacade(
    {
      hello,
      snapshot: () => snapshot(1),
      onBtwEvent: (listener) => {
        publish = listener;
        return () => {
          publish = () => {};
        };
      },
    },
    async (facade) => {
      const events: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => events.push(event));
      publish(btwForward(2, "stale epoch"));
      assert.equal(events.filter((event) => event.kind === "btw.changed").length, 0);
    },
  );
});
