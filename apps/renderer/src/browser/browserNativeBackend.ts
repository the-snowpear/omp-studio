import type { StudioClient } from "@omp-studio/client-contract";
import type { BrowserObservationResultMap, ManagedBrowserApi, ManagedBrowserCommand, ManagedBrowserEvent, ManagedBrowserPage, ManagedBrowserState, StudioBrowserTab } from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";
import type { BrowserBackend, BrowserPageController } from "./browserSessions";

export const browserAddress = (value: string): string => value === "about:blank" ? value : new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`).href;
/** Compatibility chrome is only a projection. Target, ownership, engine and capabilities remain native facts. */
export function nativeBrowserPage(tab: StudioBrowserTab, sessionId: string): ManagedBrowserPage {
  return { id: tab.id, sessionId, spaceId: "", title: tab.title, url: tab.url, status: "ready", canGoBack: false, canGoForward: false,
    zoom: 1, devtools: false, descriptor: tab };
}

/** Joins real native targets with the explicitly selected local embedded adapter. It never reopens a page to display it. */
export function createNativeBrowserBackend(client: StudioClient, api?: ManagedBrowserApi): BrowserBackend {
  const native = new Map<string, StudioBrowserTab[]>();
  const embedded = new Map<string, ManagedBrowserState>();
  const selected = new Map<string, string>();
  const nativeVersions = new Map<string, number>();
  const embeddedVersions = new Map<string, number>();
  const patches = new Map<string, Partial<ManagedBrowserPage>>();
  const controllers = new Map<string, BrowserPageController>();
  const listeners = new Set<(event: ManagedBrowserEvent) => void>();
  const watches = new Map<string, { count: number; timer?: number | undefined; reading: boolean }>();
  const clock: Window = window;
  const signatures = new Map<string, string>();
  let unsubscribe: (() => void) | undefined;
  const pageKey = (sessionId: string, pageId: string) => `${sessionId}\n${pageId}`;
  const bump = (versions: Map<string, number>, sessionId: string) => versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1);
  const state = (sessionId: string): ManagedBrowserState => {
    const base = embedded.get(sessionId);
    const tabs = native.get(sessionId) ?? [];
    const pages = (base?.pages ?? []).map(page => {
      const tab = tabs.find(tab => tab.embeddedPageId === page.id);
      return tab ? { ...page, descriptor: tab } : page;
    });
    for (const tab of tabs) if (!tab.embeddedPageId || !pages.some(page => page.id === tab.embeddedPageId)) pages.push(nativeBrowserPage(tab, sessionId));
    const active = selected.get(sessionId) ?? base?.activePageId;
    return { sessionId, pages: pages.map(page => ({ ...page, ...patches.get(pageKey(sessionId, page.id)) })),
      activePageId: pages.some(page => page.id === active) ? active! : pages[0]?.id ?? null,
      spaces: base?.spaces ?? [], control: base?.control ?? "agent", connection: "connected",
      // This policy belongs solely to the embedded adapter, not the CLI's native browsers.
      settings: base?.settings ?? { maxTabs: 0, downloadDirectory: "", askDownloadLocation: false }, downloads: base?.downloads ?? [], permissions: base?.permissions ?? [] };
  };
  const emit = (sessionId: string) => {
    const current = state(sessionId), signature = JSON.stringify(current);
    if (signatures.get(sessionId) === signature) return;
    signatures.set(sessionId, signature);
    for (const listener of listeners) listener({ kind: "state", state: current });
  };
  const read = async (sessionId: string): Promise<ManagedBrowserState> => {
    const nativeVersion = nativeVersions.get(sessionId), embeddedVersion = embeddedVersions.get(sessionId);
    const reads: Promise<void>[] = [(async () => {
      const receipt = await client.command("browser.tabs.get", { sessionId });
      const value = await waitReceipt<{ result: BrowserObservationResultMap["browser.tabs.get"] }>(client, receipt.requestId);
      if (nativeVersions.get(sessionId) === nativeVersion) {
        native.set(sessionId, value.result.tabs);
        const live = new Set(value.result.tabs.map(tab => pageKey(sessionId, tab.embeddedPageId ?? tab.id)));
        for (const key of patches.keys()) if (key.startsWith(`${sessionId}\n`) && !live.has(key)) patches.delete(key);
      }
    })()];
    if (api) reads.push(api.read(sessionId).then(value => { if (embeddedVersions.get(sessionId) === embeddedVersion) embedded.set(sessionId, value); }));
    const results = await Promise.allSettled(reads);
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) {
      const message = failed.map(result => result.reason instanceof Error ? result.reason.message : String(result.reason)).join(" · ");
      if (failed.length === results.length) throw new Error(message);
      for (const listener of listeners) listener({ kind: "error", sessionId, message });
    }
    return state(sessionId);
  };
  return {
    native: true, embedded: !!api, read,
    async execute(command: ManagedBrowserCommand): Promise<ManagedBrowserState> {
      const id = command.sessionId;
      if (command.action === "create" && command.app !== "embedded") {
        const handle = await client.command("browser.native.open", { sessionId: id, url: browserAddress(command.url),
          ...(command.app === undefined ? {} : { app: command.app }), ...(command.argv === undefined ? {} : { argv: command.argv }),
          ...(command.target === undefined ? {} : { target: command.target }), ...(command.insecure === undefined ? {} : { insecure: command.insecure }) });
        const value = (await waitReceipt<{ result: BrowserObservationResultMap["browser.native.open"] }>(client, handle.requestId, 120000)).result;
        bump(nativeVersions, id);
        native.set(id, [...(native.get(id) ?? []).filter(tab => tab.id !== value.tab.id), value.tab]);
        selected.set(id, value.tab.embeddedPageId ?? value.tab.id); emit(id); return state(id);
      }
      const page = "pageId" in command ? state(id).pages.find(page => page.id === command.pageId) : undefined;
      const tab = page?.descriptor;
      if (tab && tab.transport !== "embedded") {
        if (command.action === "select") { selected.set(id, page!.id); emit(id); return state(id); }
        const controller = controllers.get(pageKey(id, page!.id));
        if (command.action === "close" || command.action === "close-handoff") {
          // The private controller confirms Return before detach, so native close cannot race its own lease.
          await controller?.release();
          const receipt = await client.command("browser.native.close", { sessionId: id, tabId: page!.id, generation: tab.generation });
          const result = (await waitReceipt<{ result: BrowserObservationResultMap["browser.native.close"] }>(client, receipt.requestId, 65000)).result;
          if (!result.closed) throw new Error("The native page was not closed; refresh its targets before retrying.");
          bump(nativeVersions, id); native.set(id, (native.get(id) ?? []).filter(item => item.id !== page!.id));
          patches.delete(pageKey(id, page!.id)); emit(id); return state(id);
        }
        if (!controller) throw new Error("Show this native page and take its current lease before using page controls.");
        const { sessionId: _sessionId, ...action } = command;
        await controller.execute(action); return state(id);
      }
      if (command.action === "return" || command.action === "release") {
        await Promise.all([...controllers].filter(([key]) => key.startsWith(`${id}\n`)).map(([, controller]) => controller.release()));
        if (!api) return state(id);
      }
      if (!api) throw new Error("This action requires the explicit local embedded browser adapter.");
      if (command.action === "create") {
        const prepared = await client.command("browser.managed.prepare", { sessionId: id });
        await waitReceipt(client, prepared.requestId);
      }
      const result = await api.execute(command); bump(embeddedVersions, id); embedded.set(id, result);
      if (command.action === "create" && result.activePageId) selected.set(id, result.activePageId);
      emit(id); return state(id);
    },
    watch(sessionId) {
      let watch = watches.get(sessionId);
      if (!watch) watches.set(sessionId, watch = { count: 0, reading: false });
      watch.count++;
      const current = watch;
      const poll = async () => {
        if (!current.count || current.reading) return;
        current.reading = true;
        try { await read(sessionId); if (current.count) emit(sessionId); }
        catch (cause) { if (current.count) for (const listener of listeners) listener({ kind: "error", sessionId, message: cause instanceof Error ? cause.message : String(cause) }); }
        finally { current.reading = false; if (current.count) current.timer = clock.setTimeout(() => void poll(), 2000); }
      };
      if (current.count === 1) void poll();
      return () => { if (--current.count === 0) { clearTimeout(current.timer); current.timer = undefined; } };
    },
    bindPage(sessionId, pageId, controller) {
      const key = pageKey(sessionId, pageId); controllers.set(key, controller);
      return () => { if (controllers.get(key) === controller) { controllers.delete(key); patches.delete(key); emit(sessionId); } };
    },
    updatePage(sessionId, pageId, patch) { const key = pageKey(sessionId, pageId); patches.set(key, { ...patches.get(key), ...patch }); emit(sessionId); },
    subscribe(listener) {
      listeners.add(listener);
      unsubscribe ??= api?.subscribe(event => {
        if (event.kind === "state") { bump(embeddedVersions, event.state.sessionId); embedded.set(event.state.sessionId, event.state); emit(event.state.sessionId); }
        else for (const listener of listeners) listener(event);
      });
      return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; } };
    },
  };
}
