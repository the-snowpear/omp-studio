import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { BrowserObservationEvent, BrowserObservationInput, BrowserObservationResultMap, BrowserPageInspection, BrowserInspectionView, ManagedBrowserPage } from "@omp-studio/studio-protocol";
import { useSurfaceChrome, useSurfaceDocument } from "../dock/SurfaceContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewBrowserFrame, previewBrowserInspection } from "../preview/browserPreview";
import { browserAddress } from "./browserNativeBackend";
import type { BrowserAction, BrowserPageController, BrowserSession } from "./browserSessions";

export type NativeBrowserState = Extract<BrowserObservationEvent, { kind: "state" }>;
export type NativeBrowserFrame = Extract<BrowserObservationEvent, { kind: "frame" }>;
/** One window-local frame leaf. High-frequency images do not re-render the toolbar, Dock or shared page model. */
export class NativeBrowserFrames {
  #frame: NativeBrowserFrame | undefined;
  readonly #listeners = new Set<() => void>();
  getSnapshot = (): NativeBrowserFrame | undefined => this.#frame;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  publish(frame: NativeBrowserFrame | undefined): void { this.#frame = frame; for (const listener of this.#listeners) listener(); }
}
interface ObservationHandle {
  id: string;
  generation: string;
  state?: NativeBrowserState | undefined;
  frame?: NativeBrowserFrame | undefined;
  loaded?: { sequence: number; generation: string; documentEpoch: number } | undefined;
  taking: boolean;
  stopped: boolean;
  returned: Set<() => void>;
}

/** Metadata and media watches follow both the pane and its actual (possibly floating) document. */
export function useBrowserVisible(visible: boolean): boolean {
  const document = useSurfaceDocument();
  const [shown, setShown] = useState(!document.hidden);
  useEffect(() => { const change = () => setShown(!document.hidden); change(); document.addEventListener("visibilitychange", change); return () => document.removeEventListener("visibilitychange", change); }, [document]);
  return visible && shown;
}
export function useBrowserWatch(session: BrowserSession | null, visible: boolean): void {
  const shown = useBrowserVisible(visible);
  useEffect(() => { if (shown) return session?.watch(); return undefined; }, [session, shown]);
}

/** Window-owned same-page view. Only small page metadata reaches the shared BrowserSession; never frames, logs or keystrokes. */
export function useNativeBrowserObservation(options: { client?: StudioClient | undefined; session: BrowserSession | null; page?: ManagedBrowserPage | undefined; visible: boolean; capture: boolean; inspection?: BrowserInspectionView | undefined }) {
  const chrome = useSurfaceChrome(), document = useSurfaceDocument();
  const { preview } = usePreviewMode();
  const shown = useBrowserVisible(options.visible);
  const [state, setState] = useState<NativeBrowserState>();
  const [frames] = useState(() => new NativeBrowserFrames());
  const [inspection, setInspection] = useState<BrowserPageInspection>();
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false), [paused, setPaused] = useState(false), [revision, refresh] = useState(0), [viewer, setViewer] = useState(false);
  const current = useRef<ObservationHandle | undefined>(undefined);
  const epoch = useRef(0);
  const controls = useRef<BrowserPageController | undefined>(undefined);
  const descriptor = options.page?.descriptor;
  const eligible = descriptor?.transport === "frames" && descriptor.capabilities.observe;
  const active = shown && eligible && (!options.capture || !paused);
  const send = useCallback(async (input: BrowserObservationInput) => {
    const handle = current.current;
    if (!handle || handle.stopped) throw new Error("The same-page observation is no longer attached.");
    if (preview) {
      if (input.kind === "take" || input.kind === "release") {
        const next: NativeBrowserState = { kind: "state", observationId: handle.id, tabId: options.page!.id, generation: handle.generation, documentEpoch: 0,
          title: options.page!.title, url: options.page!.url, frozen: false, busy: false, control: input.kind === "take" ? "human" : "agent", ...(input.kind === "take" ? { leaseId: "preview-lease" } : {}) };
        handle.state = next; handle.taking = input.kind === "take"; setState(next);
      }
      return;
    }
    const result = await chrome?.controlBrowserObservation?.({ observationId: handle.id, input });
    if (!result?.ok) throw new Error(result?.message ?? "The authenticated native observation channel is unavailable.");
  }, [chrome, preview, options.page?.id, options.page?.title, options.page?.url]);
  const report = useCallback((cause: unknown) => setError(hostErrorMessage(cause, "Native browser observation unavailable")), []);

  useEffect(() => {
    const run = ++epoch.current;
    const view: Window = document.defaultView ?? window;
    setState(undefined); frames.publish(undefined); setInspection(undefined); setError(""); setConnecting(false); setViewer(false);
    if (!active || !descriptor || !options.page || !options.session) return;
    if (!preview && (!options.client || !chrome?.attachBrowserObservation || !chrome?.onBrowserObservation)) return;
    let disposed = false, handle: ObservationHandle | undefined, unbind: (() => void) | undefined;
    let heartbeat: number | undefined;
    const stop = async () => {
      if (!handle || handle.stopped) return;
      handle.stopped = true; handle.frame = undefined; handle.loaded = undefined; frames.publish(undefined);
      if (current.current === handle) current.current = undefined;
      view.clearInterval(heartbeat);
      for (const resolve of handle.returned) resolve(); handle.returned.clear();
      if (!preview) {
        // Apply visibility first. Closing this channel releases observation/control only, never the CLI tab.
        await chrome?.controlBrowserObservation?.({ observationId: handle.id, input: { kind: "visibility", visible: false } }).catch(() => undefined);
        await chrome?.detachBrowserObservation?.({ observationId: handle.id }).catch(() => undefined);
      }
    };
    const release = async () => {
      if (!handle || handle.stopped) return;
      if (!preview && (handle.taking || handle.state?.control === "human" || handle.state?.control === "waiting")) {
        let resolveReturned!: () => void;
        const returned = new Promise<void>(resolve => { resolveReturned = resolve; });
        handle.returned.add(resolveReturned);
        const timer = setTimeout(resolveReturned, 8000);
        try { await send({ kind: "release" }); await returned; }
        finally { clearTimeout(timer); handle.returned.delete(resolveReturned); }
      }
      await stop();
      if (!disposed && epoch.current === run) { setPaused(true); setState(undefined); frames.publish(undefined); setViewer(false); }
    };
    const controller: BrowserPageController = {
      release,
      async execute(action: BrowserAction) {
        if (!handle || handle.stopped) throw new Error("Resume same-page viewing before using native controls.");
        if (action.action === "take") { handle.taking = true; await send({ kind: "take", generation: handle.generation }); return; }
        if (action.action === "return" || action.action === "release") { await release(); return; }
        const documentEpoch = handle.loaded?.documentEpoch ?? handle.frame?.documentEpoch ?? handle.state?.documentEpoch, leaseId = handle.state?.leaseId;
        const fence = { generation: handle.generation, ...(documentEpoch === undefined ? {} : { documentEpoch }), ...(leaseId === undefined ? {} : { leaseId }) };
        if (action.action === "navigate") await send({ kind: "navigate", url: browserAddress(action.url), ...fence });
        else if (action.action === "back" || action.action === "forward" || action.action === "reload" || action.action === "stop") await send({ kind: action.action, ...fence });
        else if (action.action === "viewer") { await send({ kind: "viewer", visible: action.visible, ...fence }); if (preview) setViewer(action.visible); }
        else throw new Error(descriptor.capabilities.reasons[action.action === "zoom" ? "zoom" : action.action === "find" ? "find" : "control"] ?? "This action is not provided by the native same-page adapter.");
      },
    };
    controls.current = controller;
    const off = !preview ? chrome?.onBrowserObservation?.(event => {
      if (disposed || epoch.current !== run || !handle || handle.stopped || event.observationId !== handle.id) return;
      if ("tabId" in event && event.tabId !== options.page!.id) return;
      if ("generation" in event && event.generation !== handle.generation) return;
      if (event.kind === "state") {
        if (handle.loaded && event.documentEpoch !== handle.loaded.documentEpoch) { handle.loaded = undefined; frames.publish(undefined); }
        handle.state = event; handle.taking = event.control === "human" || event.control === "waiting";
        if (event.control === "agent") { for (const resolve of handle.returned) resolve(); handle.returned.clear(); }
        setState(event); setViewer(event.viewerVisible === true);
        options.session!.updatePage(options.page!.id, { title: event.title, url: event.url, canGoBack: event.canGoBack ?? false, canGoForward: event.canGoForward ?? false });
      } else if (event.kind === "frame") { handle.frame = event; frames.publish(event); }
      else if (event.kind === "inspection") setInspection(event.inspection);
      else if (event.kind === "error") setError(event.message);
      else { void stop(); setState(undefined); frames.publish(undefined); setPaused(true); }
    }) : undefined;
    setConnecting(true);
    void (async () => {
      if (preview) {
        handle = { id: "preview-observation", generation: descriptor.generation, taking: false, stopped: false, returned: new Set() };
        current.current = handle;
        const next: NativeBrowserState = { kind: "state", observationId: handle.id, tabId: options.page!.id, generation: handle.generation, documentEpoch: 0,
          title: options.page!.title, url: options.page!.url, frozen: false, busy: false, control: "agent" };
        handle.state = next; setState(next);
        if (options.capture) { handle.frame = previewBrowserFrame(options.page!.id, descriptor.generation); frames.publish(handle.frame); }
        if (options.inspection) setInspection(previewBrowserInspection(options.inspection));
      } else {
        const receipt = await options.client!.command("browser.observe.prepare", { sessionId: options.session!.id, tabId: options.page!.id });
        const result = (await waitReceipt<{ result: BrowserObservationResultMap["browser.observe.prepare"] }>(options.client!, receipt.requestId)).result;
        if (disposed || epoch.current !== run) { await chrome?.detachBrowserObservation?.({ observationId: result.observationId }); return; }
        handle = { id: result.observationId, generation: result.generation ?? descriptor.generation, taking: false, stopped: false, returned: new Set() };
        current.current = handle;
        const attachment = { observationId: result.observationId, sessionId: result.sessionId, tabId: result.tabId, generation: handle.generation };
        const attached = await chrome!.attachBrowserObservation!(attachment);
        if (disposed || epoch.current !== run) { await stop(); return; }
        if (!attached.ok) throw new Error(attached.message ?? "Native same-page observation could not attach.");
        await send({ kind: "visibility", visible: true, capture: options.capture });
        if (options.inspection) await send({ kind: "inspect", view: options.inspection });
        heartbeat = view.setInterval(() => { if (!document.hidden && !disposed) void send({ kind: "ping" }).catch(report); }, 5000);
      }
      if (!disposed) unbind = options.session!.bindPage(options.page!.id, controller);
    })().catch(cause => { if (!disposed && epoch.current === run) { report(cause); void stop(); } }).finally(() => { if (!disposed && epoch.current === run) setConnecting(false); });
    return () => { disposed = true; epoch.current++; unbind?.(); off?.(); if (controls.current === controller) controls.current = undefined; void stop(); };
  }, [options.client, options.session, options.page?.id, descriptor?.generation, active, options.capture, options.inspection, preview, chrome, document, revision]);

  const execute = useCallback(async (action: BrowserAction) => {
    try { await controls.current?.execute(action); } catch (cause) { report(cause); }
  }, [report]);
  const acknowledge = useCallback(async (loaded: NativeBrowserFrame) => {
    const handle = current.current;
    if (!handle || handle.stopped || loaded !== handle.frame || loaded.generation !== handle.generation || loaded.documentEpoch === undefined) return;
    try { await send({ kind: "ack", sequence: loaded.sequence, generation: handle.generation }); if (current.current === handle && loaded === handle.frame) handle.loaded = { sequence: loaded.sequence, generation: handle.generation, documentEpoch: loaded.documentEpoch }; }
    catch (cause) { report(cause); }
  }, [send, report]);
  const input = useCallback(async (action: BrowserObservationInput) => {
    const handle = current.current, displayed = handle?.loaded;
    if (preview) return;
    if (!handle || !displayed || ((action.kind === "click" || action.kind === "wheel") && displayed.sequence !== handle.frame?.sequence) || handle.state?.control !== "human" || !handle.state.leaseId) return;
    try { await send({ ...action, sequence: displayed.sequence, generation: handle.generation, documentEpoch: displayed.documentEpoch, leaseId: handle.state.leaseId } as BrowserObservationInput); }
    catch (cause) { report(cause); }
  }, [send, preview, report]);
  return { state, frames, inspection, error, connecting, paused, viewer, preview, shown, available: preview || !!chrome?.attachBrowserObservation,
    acknowledge, input, execute, resume: () => { setPaused(false); refresh(value => value + 1); },
    refreshInspection: () => { if (preview && options.inspection) setInspection(previewBrowserInspection(options.inspection)); else if (options.inspection) void send({ kind: "inspect", view: options.inspection }).catch(report); } };
}
