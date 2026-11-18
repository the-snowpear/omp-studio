import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientBootstrap, ClientEvent, ClientTransport, ConversationMessageItem, QueryInput } from "@omp-studio/client-contract";
import { App } from "./App";
import { __resetAppSettingsForTests } from "./settings/appSettings";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

const clients: StudioClientImpl[] = [];
vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  cleanup();
  window.dispatchEvent(new Event("pagehide"));
  for (const client of clients.splice(0)) await client.close();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  __resetAppSettingsForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createFollowUpHarness(options?: { readonly degradedPrompt?: boolean }) {
  const fixture = structuredClone(contractFixtures.bootstrap);
  const workspaceId = fixture.residents!.residents[0]!.workspaceId;
  // Capability manifest without legacy `session.queue.list`, matching modern Runtimes (`core.followUp` + `session.queue.get`).
  const capabilities = fixture.capabilityManifest.capabilities.filter((cap) => cap.id !== "session.queue.list");
  if (!capabilities.some((cap) => cap.id === "core.followUp")) {
    capabilities.push({ id: "core.followUp", grade: "stable", version: 1, evidence: "test" });
  }
  if (!capabilities.some((cap) => cap.id === "session.queue.get")) {
    capabilities.push({ id: "session.queue.get", grade: "stable", version: 1, evidence: "test" });
  }
  const manifest = { ...fixture.capabilityManifest, capabilities };
  const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
  const queuedEntries: Array<{ id: string; kind: "followUp"; text: string; imageCount: number }> = [];
  const messages: ConversationMessageItem[] = [
    {
      kind: "message",
      itemId: "user-initial",
      parentId: null,
      createdAt: "2026-11-18T00:33:00.000Z",
      role: "user",
      content: [{ type: "text", text: "Initial task" }],
    },
  ];
  let cursor = 0;
  let streamSeq = 0;
  const listeners = new Set<(event: ClientEvent) => void>();
  let current: ClientBootstrap = {
    ...fixture,
    capabilityManifest: manifest,
    cursor: "0" as never,
    selected: { ...fixture.selected, workspaceId },
    snapshot: {
      ...fixture.snapshot!,
      isStreaming: options?.degradedPrompt !== true,
      pendingMessages: 0,
    },
  };

  const emit = (event: object) => {
    const value = {
      ...event,
      authorityEpoch: fixture.authority.authorityEpoch,
      cursor: String(++cursor),
      occurredAt: new Date().toISOString(),
    } as ClientEvent;
    for (const listener of listeners) listener(value);
  };

  const transport: ClientTransport = {
    bootstrap: async () => current,
    subscribe: (_scope, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    query: async (request) => {
      if (request.queryName === "capabilities.get") {
        return { ok: true, queryName: request.queryName, result: current.capabilityManifest } as never;
      }
      const response = structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]) as {
        ok: boolean;
        result: Record<string, unknown>;
      };
      if (request.queryName === "history.list") response.result = { ...response.result, entries: [], total: 0 };
      if (request.queryName === "projects.list") response.result = { ...response.result, activeWorkspaceId: workspaceId };
      if (request.queryName === "conversation.open") {
        const target = (request.input as QueryInput<"conversation.open">).target;
        const sessionId = target.kind === "session" ? target.sessionId : target.parentSessionId;
        response.result = {
          target: { kind: "session", sessionId, conversationSessionId: sessionId },
          page: { ...(response.result.page as object), sessionId, items: [...messages], hasMoreBefore: false },
          live: { status: "complete", watermark: streamSeq, events: [] },
        };
      }
      return response as never;
    },
    command: async (request) => {
      calls.push({ name: request.commandName, input: request.input });
      let result: unknown = {};
      if (request.commandName === "session.queue.get") {
        result = { result: { entries: [...queuedEntries], total: queuedEntries.length, truncated: false } };
      } else if (request.commandName === "core.followUp") {
        const text = (request.input as { text: string }).text;
        queuedEntries.push({ id: `q-${queuedEntries.length + 1}`, kind: "followUp", text, imageCount: 0 });
        const snapshot = {
          ...current.snapshot!,
          isStreaming: true,
          pendingMessages: queuedEntries.length,
          stateVersion: ((current.snapshot!.stateVersion as number) + 1) as never,
        };
        current = { ...current, snapshot, stateVersion: snapshot.stateVersion };
        emit({ kind: "snapshot", snapshot });
        result = { queued: true, pendingMessages: queuedEntries.length };
      } else if (request.commandName === "core.prompt" && options?.degradedPrompt === true) {
        const text = (request.input as { text: string }).text;
        queuedEntries.push({ id: `q-${queuedEntries.length + 1}`, kind: "followUp", text, imageCount: 0 });
        const snapshot = {
          ...current.snapshot!,
          isStreaming: true,
          pendingMessages: queuedEntries.length,
          stateVersion: ((current.snapshot!.stateVersion as number) + 1) as never,
        };
        current = { ...current, snapshot, stateVersion: snapshot.stateVersion };
        emit({ kind: "snapshot", snapshot });
        result = { started: false };
      }
      emit({
        kind: "command.receipt",
        receipt: {
          requestId: request.requestId,
          commandName: request.commandName,
          status: "completed",
          result,
          observedAt: new Date().toISOString(),
        },
      });
      return {
        commandName: request.commandName,
        requestId: request.requestId,
        status: "accepted",
        acceptedAt: new Date().toISOString(),
      };
    },
    close: async () => {
      listeners.clear();
    },
  };

  const client = new StudioClientImpl(transport);
  clients.push(client);
  return {
    client,
    calls,
    dequeueToConversation(text: string) {
      queuedEntries.shift();
      const sessionId = current.snapshot!.sessionId;
      const item: ConversationMessageItem = {
        kind: "message",
        itemId: "user-queued-1",
        parentId: "user-initial",
        createdAt: "2026-11-18T00:49:00.000Z",
        role: "user",
        content: [{ type: "text", text }],
      };
      messages.push(item);
      emit({
        kind: "conversation.changed",
        sessionId,
        runtimeEpoch: current.snapshot!.runtimeEpoch,
        stateVersion: current.snapshot!.stateVersion,
        streamSeq: ++streamSeq,
        eventSeq: streamSeq,
        update: { kind: "conversation.message.completed", sessionId, turnId: "turn-1", messageId: item.itemId, item },
      });
      const snapshot = {
        ...current.snapshot!,
        pendingMessages: queuedEntries.length,
        stateVersion: ((current.snapshot!.stateVersion as number) + 1) as never,
      };
      current = { ...current, snapshot, stateVersion: snapshot.stateVersion };
      emit({ kind: "snapshot", snapshot });
    },
  };
}

async function mountApp(client: StudioClientImpl) {
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  __resetAppSettingsForTests(JSON.stringify({ language: "en", restoreLastSession: false, startupPage: "workbench" }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  render(<App client={client} />);
  await waitFor(() => expect(document.querySelector("#workbench")).not.toBeNull());
  await screen.findByText("Initial task");
}

describe("queued follow-up timeline isolation", () => {
  it("queues Enter during streaming via core.followUp without rendering an optimistic user bubble until dequeued", async () => {
    const harness = createFollowUpHarness();
    await mountApp(harness.client);

    const editor = document.querySelector<HTMLElement>('.chip-composer-editor[contenteditable="true"]')!;
    editor.textContent = "Queued mid-stream follow-up";
    fireEvent.input(editor);
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
    });

    await waitFor(() => expect(harness.calls.some((call) => call.name === "core.followUp")).toBe(true));
    expect(document.querySelectorAll('[data-item-id^="pending:"]')).toHaveLength(0);
    const timeline = document.querySelector(".convo-transcript") ?? document.querySelector("#workbench")!;
    expect(timeline.querySelectorAll(".ev-user")).toHaveLength(1);

    act(() => harness.dequeueToConversation("Queued mid-stream follow-up"));
    await screen.findByText("Queued mid-stream follow-up");
    expect(timeline.querySelectorAll(".ev-user")).toHaveLength(2);
  });

  it("drops the optimistic pending row when core.prompt degrades to a queued follow-up (started: false)", async () => {
    const harness = createFollowUpHarness({ degradedPrompt: true });
    await mountApp(harness.client);

    const editor = document.querySelector<HTMLElement>('.chip-composer-editor[contenteditable="true"]')!;
    editor.textContent = "Raced busy turn";
    fireEvent.input(editor);
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
    });

    await waitFor(() => expect(harness.calls.some((call) => call.name === "core.prompt")).toBe(true));
    await waitFor(() => {
      const timeline = document.querySelector(".convo-transcript") ?? document.querySelector("#workbench")!;
      expect(timeline.querySelectorAll(".ev-user")).toHaveLength(1);
    });
  });
});
