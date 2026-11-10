import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { EvaluationActivity } from "./EvaluationActivity";
import { ConversationViewContext } from "../conversationWorkspace/Context";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function activityClient(query = vi.fn().mockResolvedValue({ records: [], total: 0 })) {
  const listeners = new Set<(event: ClientEvent) => void>();
  const client = {
    query,
    subscribe: (_scope: unknown, listener: (event: ClientEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as StudioClient;
  return {
    client, query, listeners,
    changed: () => { for (const listener of listeners) listener({ kind: "evaluations.changed" } as ClientEvent); },
  };
}

function view(client: StudioClient, visible = true) {
  return <I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled>
    <EvaluationActivity client={client} visible={visible} onOpen={() => {}} />
  </PreviewModeProvider></I18nProvider>;
}

it("only the active conversation polls the global activity while other views remain mounted", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const first = activityClient(), second = activityClient();
  const pair = (active: number) => <>{[first, second].map((source, index) =>
    <ConversationViewContext.Provider key={index} value={{ active: index === active } as never}>{view(source.client)}</ConversationViewContext.Provider>,
  )}</>;
  const mounted = render(pair(0));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(first.query).toHaveBeenCalledTimes(2);
  expect(second.query).not.toHaveBeenCalled();
  await act(async () => { mounted.rerender(pair(1)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(first.query).toHaveBeenCalledTimes(2);
  expect(second.query).toHaveBeenCalledTimes(2);
  expect(first.listeners.size).toBe(0);
});

it("coalesces progress received during a slow read and keeps one polling chain", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  let release!: (result: { records: []; total: number }) => void;
  const pending = new Promise<{ records: []; total: number }>(resolve => { release = resolve; });
  const source = activityClient(vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ records: [], total: 0 }));
  const mounted = render(view(source.client));
  await act(async () => { for (let i = 0; i < 25; i++) source.changed(); });
  expect(source.query).toHaveBeenCalledTimes(1);

  await act(async () => { release({ records: [], total: 0 }); await vi.advanceTimersByTimeAsync(0); });
  expect(source.query).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(source.query).toHaveBeenCalledTimes(5);
  mounted.unmount();
  expect(source.listeners.size).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(source.query).toHaveBeenCalledTimes(5);
});

it("refreshes when shown and does no polling while its surface or window is hidden", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const source = activityClient();
  const mounted = render(view(source.client, false));
  expect(source.query).not.toHaveBeenCalled();
  await act(async () => { mounted.rerender(view(source.client)); });
  expect(source.query).toHaveBeenCalledTimes(1);

  await act(async () => {
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    source.changed();
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(source.query).toHaveBeenCalledTimes(1);
  await act(async () => {
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(source.query).toHaveBeenCalledTimes(2);
});
