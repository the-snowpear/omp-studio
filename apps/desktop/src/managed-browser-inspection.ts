import type { WebContents } from "electron";
import type { BrowserConsoleRow, BrowserInspectionView, BrowserNetworkRow, BrowserPageInspection } from "@omp-studio/studio-protocol";

/** Bounded metadata of this exact WebContents. Network uses its own CDP session, never the Agent's CDP session or response bodies. */
export class ManagedBrowserInspection {
  readonly #console: BrowserConsoleRow[] = [];
  readonly #network = new Map<string, BrowserNetworkRow>();
  #session: string | undefined;
  #starting: Promise<void> | undefined;
  #ownedDebugger = false;
  #closed = false;
  #revision = 0;
  #owner: string | undefined;
  readonly #onConsole: (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>, level: number, message: string, line: number, source: string) => void;
  readonly #onNetwork: (event: Electron.Event, method: string, params: Record<string, unknown>, sessionId?: string) => void;
  constructor(readonly contents: WebContents, readonly sharedDebugger: () => boolean) {
    this.#onConsole = event => {
      this.#console.push({ level: event.level, text: event.message.slice(0, 4096), location: `${event.sourceId}:${event.lineNumber}`.slice(0, 4096), timestamp: Date.now() });
      if (this.#console.length > 200) this.#console.shift();
    };
    this.#onNetwork = (_event, method, params, sessionId) => {
      if (!this.#session || sessionId !== this.#session || typeof params.requestId !== "string") return;
      const id = params.requestId;
      if (method === "Network.requestWillBeSent") {
        const request = params.request as { method: string; url: string };
        this.#network.set(id, { id, method: request.method, url: request.url.slice(0, 4096), ...(typeof params.type === "string" ? { resourceType: params.type } : {}) });
        if (this.#network.size > 200) this.#network.delete(this.#network.keys().next().value!);
      } else {
        const row = this.#network.get(id);
        if (!row) return;
        if (method === "Network.responseReceived") { const response = params.response as { status: number }; row.status = response.status; }
        else if (method === "Network.loadingFailed" && typeof params.errorText === "string") row.failure = params.errorText.slice(0, 4096);
      }
    };
    contents.on("console-message", this.#onConsole);
  }
  async read(view: BrowserInspectionView, visible: boolean, owner = "local"): Promise<BrowserPageInspection> {
    if (!visible) { await this.releaseOwner(owner); return { view, rows: [] }; }
    if (this.#closed || this.contents.isDestroyed()) throw new Error("The embedded page was replaced or closed.");
    if (view === "console") return { view, rows: this.#console.slice(-200) };
    if (view !== "network") throw new Error("Embedded downloads use the existing DownloadItem read model.");
    if (this.#owner !== owner) { await this.stop(); await this.#starting?.catch(() => undefined); this.#owner = owner; }
    this.#starting ??= this.#startNetwork().finally(() => { this.#starting = undefined; });
    await this.#starting;
    if (this.#owner !== owner || this.#closed) return { view, rows: [], reason: "The inspection window changed; refresh this view before reading it." };
    return { view, rows: [...this.#network.values()], reason: "Request metadata received while this view is open; response bodies are not copied to Studio." };
  }
  async #startNetwork(): Promise<void> {
    if (this.#session) return;
    const revision = this.#revision, debuggerApi = this.contents.debugger;
    if (!debuggerApi.isAttached()) { debuggerApi.attach("1.3"); this.#ownedDebugger = true; }
    try {
      const info = await debuggerApi.sendCommand("Target.getTargetInfo") as { targetInfo: { targetId: string } };
      const attached = await debuggerApi.sendCommand("Target.attachToTarget", { targetId: info.targetInfo.targetId, flatten: true }) as { sessionId: string };
      if (this.#closed || revision !== this.#revision) { await debuggerApi.sendCommand("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => undefined); return; }
      this.#session = attached.sessionId;
      this.contents.debugger.on("message", this.#onNetwork);
      await debuggerApi.sendCommand("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }, this.#session);
    } catch (cause) { await this.stop(); throw cause; }
  }
  async releaseOwner(owner: string): Promise<void> { if (this.#owner === owner) await this.stop(); }
  async stop(): Promise<void> {
    this.#revision++; this.#owner = undefined;
    const session = this.#session; this.#session = undefined;
    this.contents.debugger.removeListener("message", this.#onNetwork);
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) {
      if (session) await this.contents.debugger.sendCommand("Target.detachFromTarget", { sessionId: session }).catch(() => undefined);
      if (this.#ownedDebugger && !this.sharedDebugger() && !this.contents.isDestroyed() && this.contents.debugger.isAttached()) { try { this.contents.debugger.detach(); } catch { /* A destroyed view already released its debugger. */ } }
    }
    this.#ownedDebugger = false;
  }
  dispose(): void {
    this.#closed = true;
    this.contents.removeListener("console-message", this.#onConsole);
    void this.stop();
    this.#console.length = 0; this.#network.clear();
  }
}
