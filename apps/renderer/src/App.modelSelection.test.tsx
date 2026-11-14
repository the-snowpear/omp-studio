import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientBootstrap, ClientContextScope, ClientEvent, ClientTransport, ConversationMessageItem, ModelConfigReadModel, QueryInput } from "@omp-studio/client-contract";
import { App } from "./App";
import { __resetAppSettingsForTests } from "./settings/appSettings";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { ConversationWorkspaceStore } from "./conversationWorkspace/store";

const selector = "test/chosen";
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

function host(createReady?: Promise<void>) {
  const fixture = structuredClone(contractFixtures.bootstrap);
  const workspaceId = fixture.residents!.residents[0]!.workspaceId;
  const calls: Array<{ name: string; input: any; sessionId?: string }> = [];
  const modelsResponse = contractFixtures.queryResponses["models.get"];
  if (!modelsResponse.ok) throw new Error("models fixture");
  const models: ModelConfigReadModel = {
    ...modelsResponse.result,
    roles: [],
    availableModels: [{ provider: "test", id: "chosen", selector, name: "Chosen model", reasoning: false, kind: "chat" }],
  };
  const manifest = { ...fixture.capabilityManifest, capabilities: [
    ...fixture.capabilityManifest.capabilities,
    { id: "session.model.set", grade: "stable" as const, version: 1, evidence: "test" },
  ] };
  let fresh = 0;
  function transport(scope?: ClientContextScope): ClientTransport {
    let current: ClientBootstrap = scope ? (() => {
      const { snapshot, stateVersion, cursor, residents, ...base } = fixture;
      return { ...base, runtime: { status: "unavailable", classification: "unavailable" },
        capabilityManifest: { ...manifest, capabilities: [] },
        selected: { workspaceId, ...(scope.sessionId ? { sessionId: scope.sessionId, threadId: `thread:${scope.sessionId}` as never } : {}) } };
    })() : { ...fixture, capabilityManifest: manifest, cursor: "0" as never, selected: { ...fixture.selected, workspaceId } };
    let cursor = 0;
    let streamSeq = 0;
    const messages: ConversationMessageItem[] = [];
    const listeners = new Set<(event: ClientEvent) => void>();
    const emit = (event: object) => {
      const value = { ...event, authorityEpoch: fixture.authority.authorityEpoch, cursor: String(++cursor), occurredAt: new Date().toISOString() } as ClientEvent;
      for (const listener of listeners) listener(value);
    };
    const publishModel = (model = selector) => {
      const sessionId = current.snapshot?.sessionId ?? scope?.sessionId ?? `chosen-session-${++fresh}`;
      const snapshot = { ...fixture.snapshot!, sessionId: sessionId as never, runtimeId: `runtime:${sessionId}` as never,
        stateVersion: ((current.snapshot?.stateVersion ?? 0) + 1) as never,
        model: { selector: model, provider: "test", id: "chosen", thinking: "off" as const } };
      const runtime = { ...fixture.runtime, runtimeId: snapshot.runtimeId, runtimeEpoch: snapshot.runtimeEpoch };
      if (!current.snapshot) emit({ kind: "runtime.changed", connection: runtime });
      current = { ...current, runtime, capabilityManifest: manifest, snapshot, stateVersion: snapshot.stateVersion, cursor: String(cursor) as never };
      emit({ kind: "snapshot", snapshot });
      return snapshot;
    };
    const conversation = (update: object) => emit({ kind: "conversation.changed", sessionId: current.snapshot!.sessionId,
      runtimeEpoch: current.snapshot!.runtimeEpoch, stateVersion: current.snapshot!.stateVersion,
      streamSeq: ++streamSeq, eventSeq: streamSeq, update });
    return {
      bootstrap: async () => current,
      openContext: async next => transport(next),
      subscribe: (_scope, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      query: async request => {
        if (request.queryName === "capabilities.get") return { ok: true, queryName: request.queryName, result: current.capabilityManifest };
        if (request.queryName === "models.get") return { ok: true, queryName: request.queryName, result: models };
        const response = structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]) as any;
        if (request.queryName === "history.list") response.result = { ...response.result, entries: [], total: 0 };
        if (request.queryName === "projects.list") response.result = { ...response.result, activeWorkspaceId: workspaceId };
        if (request.queryName === "conversation.open") {
          const target = (request.input as QueryInput<"conversation.open">).target;
          const sessionId = target.kind === "session" ? target.sessionId : target.parentSessionId;
          response.result = { target: { kind: "session", sessionId, conversationSessionId: sessionId },
            page: { ...response.result.page, sessionId, items: [...messages] },
            live: { status: "complete", watermark: streamSeq, events: [] } };
        }
        if (request.queryName === "session.transcript.readPage") response.result = { ...response.result, sessionId: (request.input as QueryInput<"session.transcript.readPage">).sessionId, items: [...messages] };
        return response;
      },
      command: async request => {
        calls.push({ name: request.commandName, input: request.input, ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}) });
        if (request.commandName === "session.create") await createReady;
        const result = request.commandName === "session.create" || request.commandName === "session.resume" || request.commandName === "session.model.set"
          ? publishModel((request.input as { model?: string; selector?: string }).model ?? (request.input as { selector?: string }).selector)
          : {};
        if (request.commandName === "core.prompt") {
          const sessionId = current.snapshot!.sessionId, turnId = `turn:${messages.length}`;
          const streaming = (value: boolean) => {
            const snapshot = { ...current.snapshot!, isStreaming: value, stateVersion: (current.snapshot!.stateVersion + 1) as never };
            current = { ...current, snapshot, stateVersion: snapshot.stateVersion };
            emit({ kind: "snapshot", snapshot });
          };
          const message = (role: "user" | "assistant", text: string) => {
            const item: ConversationMessageItem = { kind: "message", itemId: `message:${messages.length}`, parentId: messages.at(-1)?.itemId ?? null,
              createdAt: new Date().toISOString(), role, content: [{ type: "text", text }] };
            messages.push(item);
            conversation({ kind: "conversation.message.completed", sessionId, turnId, messageId: item.itemId, item });
          };
          streaming(true);
          message("user", (request.input as { text: string }).text);
          setTimeout(() => {
            message("assistant", "Fixture response");
            conversation({ kind: "conversation.turn.completed", sessionId, turnId });
            streaming(false);
          }, 64);
        }
        emit({ kind: "command.receipt", receipt: { requestId: request.requestId, commandName: request.commandName, status: "completed", result, observedAt: new Date().toISOString() } });
        return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: new Date().toISOString() };
      },
      close: async () => { listeners.clear(); },
    };
  }
  const client = new StudioClientImpl(transport());
  clients.push(client);
  return { client, calls, workspaceId };
}

async function mount(client: StudioClientImpl) {
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  __resetAppSettingsForTests(JSON.stringify({ language: "en", restoreLastSession: false, startupPage: "workbench" }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  render(<App client={client} />);
  await waitFor(() => expect(document.querySelector("#workbench")).not.toBeNull());
  await waitFor(() => expect(document.querySelector('.cw-document [aria-busy="true"]#appRoot')).toBeNull());
}

async function chooseModel() {
  fireEvent.click(screen.getByRole("button", { name: "Select Model" }));
  const more = await screen.findByRole("button", { name: "More Models" });
  // A real pointer enters the hover zone before clicking the same trigger.
  // Clicking must keep the already-open model list available for selection.
  fireEvent.mouseEnter(more);
  fireEvent.click(more);
  const choice = await screen.findByRole("option", { name: /Chosen model/ });
  expect(choice.hasAttribute("disabled")).toBe(false);
  fireEvent.click(choice);
  await waitFor(() => expect(screen.getByRole("button", { name: "Select Model" }).getAttribute("aria-description")).toBe("Chosen model"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Select Model" }).hasAttribute("disabled")).toBe(false));
}

describe("model selection in a cold conversation", () => {
  it("selects before the first prompt, keeps the draft, and sends two prompts to that session", async () => {
    let releaseCreate!: () => void;
    const h = host(new Promise<void>(resolve => { releaseCreate = resolve; }));
    await mount(h.client);
    fireEvent.click(document.querySelector(".new-convo-btn")!);
    await screen.findByText("Runtime 未启动");
    const editor = document.querySelector<HTMLElement>('.cw-main-conversation [contenteditable="true"]')!;
    editor.textContent = "first prompt stays in the draft";
    fireEvent.input(editor);
    const selection = chooseModel();
    await waitFor(() => expect(h.calls.filter(call => call.name === "session.create")).toHaveLength(1));
    editor.textContent = "first prompt with typing during connection";
    fireEvent.input(editor);
    releaseCreate();
    await selection;
    expect(h.calls.filter(call => call.name === "session.create").map(call => call.input)).toEqual([{ model: selector }]);
    expect(h.calls.some(call => call.name === "runtime.ensure" || call.name === "core.prompt")).toBe(false);
    expect(editor.textContent).toBe("first prompt with typing during connection");
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(h.calls.filter(call => call.name === "core.prompt")).toHaveLength(1));
    await waitFor(() => expect(document.querySelector(".cw-main-conversation .send-btn.abort")).toBeNull());
    editor.textContent = "second prompt";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(h.calls.filter(call => call.name === "core.prompt")).toHaveLength(2));
    await waitFor(() => expect(document.querySelector(".cw-main-conversation .send-btn.abort")).toBeNull());
    expect(h.calls.filter(call => call.name === "core.prompt").map(call => call.input.text))
      .toEqual(["first prompt with typing during connection", "second prompt"]);
    expect(h.calls.filter(call => call.name === "session.create")).toHaveLength(1);
  });

  it("resumes a saved conversation using the selected model without creating a different session", async () => {
    const h = host();
    const workspace = new ConversationWorkspaceStore(localStorage);
    workspace.open({ targetId: null, workspaceId: h.workspaceId, sessionId: "saved-session" as never, threadId: "thread:saved-session" as never });
    workspace.flush();
    await mount(h.client);
    await screen.findByText("Runtime 未启动");
    await chooseModel();
    expect(h.calls.filter(call => call.name === "session.resume").map(call => ({ input: call.input, sessionId: call.sessionId })))
      .toEqual([{ input: { threadId: "thread:saved-session", model: selector }, sessionId: "saved-session" }]);
    expect(h.calls.some(call => call.name === "session.create" || call.name === "core.prompt")).toBe(false);
  });
});
