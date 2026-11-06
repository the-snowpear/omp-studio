import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientEvent, ClientTransport } from "@omp-studio/client-contract";
import { App } from "./App";
import { __resetAppSettingsForTests } from "./settings/appSettings";
import { setModelConfigDirty } from "./models/modelConfigState";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";

/**
 * 项目/分支/执行位置/变更统计条只属于「新对话且还没发送」的界面：新对话里它贴着
 * Composer 上沿，项目、分支、执行位置、Git 增删统计整条都在；已经开始的对话整条
 * 不显示（项目和分支看顶栏）。它曾经在已开始的对话里只剩一个「此计算机」小条，
 * 而且排在队列上方、和输入框脱开。
 */

const clients: StudioClientImpl[] = [];
afterEach(async () => {
  cleanup();
  window.dispatchEvent(new Event("pagehide"));
  window.history.replaceState(null, "", "/");
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setModelConfigDirty(false);
  localStorage.clear();
  __resetAppSettingsForTests(null);
});

/** 预览数据默认落在已有消息的会话 t1；侧栏第一行是空白新对话 t0。 */
async function mountPreview() {
  window.history.replaceState(null, "", "/?preview=1&marks=off");
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  __resetAppSettingsForTests(JSON.stringify({ language: "zh", startupPage: "workbench", rememberLayout: false, restoreLastSession: false }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const initial = structuredClone(contractFixtures.bootstrap);
  const listeners = new Set<(event: ClientEvent) => void>();
  const snapshot = initial.snapshot!;
  const transport = {
    bootstrap: async () => ({ ...initial, cursor: "0", residents: { ...initial.residents, activeSessionId: snapshot.sessionId, residents: [] } }),
    query: async (request: { queryName: string }) => structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]),
    command: async (request: { commandName: string; requestId: string }) => ({ commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: new Date().toISOString() }),
    subscribe: (_scope: unknown, listener: (event: ClientEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: async () => {},
  } as unknown as ClientTransport;
  const client = new StudioClientImpl(transport);
  clients.push(client);
  render(<App client={client} />);
  await waitFor(() => expect(document.querySelector("#workbench")).not.toBeNull());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

it("hides the whole context strip in a started conversation", async () => {
  await mountPreview();
  const region = document.querySelector(".composer-region");
  expect(region).not.toBeNull();
  expect(region!.querySelector(".ctx-strip")).toBeNull();
  expect(region!.querySelector(".execution-picker")).toBeNull();
});

it("shows the full context strip attached above the composer on a new conversation", async () => {
  await mountPreview();
  const blank = [...document.querySelectorAll<HTMLElement>(".thread")]
    .find((row) => row.textContent?.includes("新建对话（空白）"));
  expect(blank).toBeTruthy();
  fireEvent.click(blank!);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

  const region = document.querySelector(".composer-region");
  expect(region).not.toBeNull();
  const strip = region!.querySelector(":scope > .ctx-strip");
  const queues = region!.querySelector(":scope > .composer-queues");
  const composer = region!.querySelector(":scope > .composer");
  expect(strip).not.toBeNull();
  expect(composer).not.toBeNull();

  // 项目、分支、执行位置、变更统计整条都在。
  expect(strip!.querySelector(".ctx-project-switch")?.textContent).toContain("omp-web");
  expect(strip!.querySelector(".ctx-branch-wrap")?.textContent).toContain("main");
  expect(strip!.querySelector(".execution-picker")?.textContent).toContain("此计算机");
  expect(strip!.querySelector(".ctx-diffstat")?.textContent).toContain("+214");

  // 队列在状态条之上，状态条紧贴输入框（后一个兄弟就是 Composer）。
  const children = [...region!.children];
  expect(children.indexOf(queues!)).toBeLessThan(children.indexOf(strip!));
  expect(children[children.indexOf(strip!) + 1]).toBe(composer);
});
