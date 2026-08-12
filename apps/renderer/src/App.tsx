/**
 * OMP Studio P0 renderer surface.
 *
 * Renders only safe bootstrap facts (FRONTEND_INTEGRATION.md §8.1): opaque
 * identities, epochs, versions, classification and capability counts. The
 * contract guarantees these never carry paths, endpoints, PIDs or secrets.
 *
 * Lifecycle: bootstrap once, subscribe to `{ scope: "all" }`, keep the
 * runtime/snapshot facts fresh from events, and unsubscribe + close on
 * unmount. All state here is renderer-local UI state; entity state lives in
 * the shared client.
 */

import { useEffect, useReducer } from "react";
import type { ReactNode } from "react";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import type {
  ClientBootstrap,
  ClientError,
  ClientEvent,
  RuntimeConnection,
  StudioClient,
  Unsubscribe,
} from "@omp-studio/client-contract";

/** Compact snapshot facts the P0 surface displays. */
interface SnapshotFacts {
  readonly stateVersion: number;
  readonly sessionId: string;
  readonly activeMode: string;
  readonly pendingMessages: number;
}

function snapshotFacts(snapshot: {
  readonly stateVersion: number;
  readonly sessionId: string;
  readonly activeMode: string;
  readonly pendingMessages: number;
}): SnapshotFacts {
  return {
    stateVersion: snapshot.stateVersion,
    sessionId: snapshot.sessionId,
    activeMode: snapshot.activeMode,
    pendingMessages: snapshot.pendingMessages,
  };
}

/** Capability manifest summary: profile plus per-grade counts. */
interface CapabilityFacts {
  readonly profile: string;
  readonly total: number;
  readonly stable: number;
  readonly experimental: number;
  readonly limited: number;
  readonly unavailable: number;
}

function capabilityFacts(manifest: {
  readonly profile: "full-parity-v1" | "limited";
  readonly capabilities: ReadonlyArray<{ readonly grade: string }>;
}): CapabilityFacts {
  const counts: Record<string, number> = {};
  for (const entry of manifest.capabilities) {
    counts[entry.grade] = (counts[entry.grade] ?? 0) + 1;
  }
  return {
    profile: manifest.profile,
    total: manifest.capabilities.length,
    stable: counts["stable"] ?? 0,
    experimental: counts["experimental"] ?? 0,
    limited: counts["limited"] ?? 0,
    unavailable: counts["unavailable"] ?? 0,
  };
}

interface ReadyState {
  readonly kind: "ready";
  readonly bootstrap: ClientBootstrap;
  readonly runtime: RuntimeConnection;
  readonly snapshot: SnapshotFacts;
  readonly eventCount: number;
  readonly lastEventKind: string;
}

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: ClientError }
  | ReadyState;

type Action =
  | { readonly type: "ready"; readonly bootstrap: ClientBootstrap }
  | { readonly type: "failed"; readonly error: ClientError }
  | { readonly type: "event"; readonly event: ClientEvent };

function reducer(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "failed":
      return { kind: "error", error: action.error };
    case "ready": {
      const bootstrap = action.bootstrap;
      return {
        kind: "ready",
        bootstrap,
        runtime: bootstrap.runtime,
        snapshot: snapshotFacts(bootstrap.snapshot),
        eventCount: 0,
        lastEventKind: "snapshot",
      };
    }
    case "event": {
      if (state.kind !== "ready") return state;
      const kind = action.event.kind;
      if (kind === "snapshot") {
        return {
          ...state,
          snapshot: snapshotFacts(action.event.snapshot),
          eventCount: state.eventCount + 1,
          lastEventKind: kind,
        };
      }
      if (kind === "runtime.changed") {
        return {
          ...state,
          runtime: action.event.connection,
          eventCount: state.eventCount + 1,
          lastEventKind: kind,
        };
      }
      return { ...state, eventCount: state.eventCount + 1, lastEventKind: kind };
    }
  }
}

function asClientError(cause: unknown): ClientError {
  if (typeof cause === "object" && cause !== null) {
    const maybe = cause as { readonly code?: unknown; readonly message?: unknown };
    if (typeof maybe.code === "string" && typeof maybe.message === "string") {
      return { code: maybe.code as ClientError["code"], message: maybe.message };
    }
  }
  const message = cause instanceof Error && cause.message !== "" ? cause.message : "Unknown bootstrap failure";
  return { code: "TRANSPORT_ERROR", message };
}

function toneFor(classification: RuntimeConnection["classification"]): string {
  switch (classification) {
    case "managed":
    case "compatible-system":
      return "ok";
    case "limited-system":
      return "warn";
    case "rejected":
      return "bad";
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <main className="shell">
      <header className="bar">
        <span className="brand">OMP Studio</span>
        <span className="badge">client contract v{CLIENT_CONTRACT_VERSION}</span>
      </header>
      {children}
    </main>
  );
}

function LoadingView() {
  return (
    <Shell>
      <section className="panel">
        <h1>Connecting</h1>
        <p className="muted">Requesting bootstrap from the studio client…</p>
      </section>
    </Shell>
  );
}

function ErrorView({ error }: { readonly error: ClientError }) {
  return (
    <Shell>
      <section className="panel">
        <h1>Bootstrap failed</h1>
        <p className="muted">The studio client could not establish a session.</p>
        <dl className="facts">
          <div className="fact">
            <dt>Code</dt>
            <dd className="mono">{error.code}</dd>
          </div>
          <div className="fact">
            <dt>Message</dt>
            <dd>{error.message}</dd>
          </div>
        </dl>
      </section>
    </Shell>
  );
}

export function Unavailable() {
  return (
    <Shell>
      <section className="panel">
        <h1>Studio client unavailable</h1>
        <p className="muted">
          No studio client was injected into this browser context. Launch the app through the
          desktop shell or the local WebUI bridge, which supplies the client before the
          renderer runs. The renderer does not connect to anything on its own.
        </p>
      </section>
    </Shell>
  );
}

function ReadyView({ state }: { readonly state: ReadyState }) {
  const { bootstrap, runtime, snapshot, eventCount, lastEventKind } = state;
  const caps = capabilityFacts(bootstrap.capabilityManifest);
  const surface = bootstrap.surface;
  const contractOk = bootstrap.contractVersion === CLIENT_CONTRACT_VERSION;
  return (
    <Shell>
      <section className="panel">
        <div className="panel-head">
          <h1>Runtime connection</h1>
          <span className={`status status-${runtime.status}`}>{runtime.status}</span>
        </div>
        <dl className="facts">
          <div className="fact">
            <dt>Classification</dt>
            <dd>
              <span className={`chip chip-${toneFor(runtime.classification)}`}>{runtime.classification}</span>
              {runtime.classification === "rejected" && runtime.rejectionReason !== undefined ? (
                <span className="fact-note">{runtime.rejectionReason}</span>
              ) : null}
            </dd>
          </div>
          <div className="fact">
            <dt>Backend</dt>
            <dd className="mono">{runtime.backend ?? "—"}</dd>
          </div>
          <div className="fact">
            <dt>Runtime version</dt>
            <dd className="mono">{runtime.runtimeVersion ?? "—"}</dd>
          </div>
          <div className="fact">
            <dt>Upstream</dt>
            <dd className="mono">
              {runtime.upstreamVersion ?? "—"}
              {runtime.upstreamCommit !== undefined ? ` (${truncate(runtime.upstreamCommit, 8)})` : ""}
            </dd>
          </div>
          <div className="fact">
            <dt>Authority</dt>
            <dd className="mono">
              {bootstrap.authority.authorityId} · epoch {bootstrap.authority.authorityEpoch}
            </dd>
          </div>
          <div className="fact">
            <dt>Runtime epoch</dt>
            <dd className="mono">{runtime.runtimeEpoch ?? "—"}</dd>
          </div>
          <div className="fact">
            <dt>Session</dt>
            <dd className="mono">{truncate(snapshot.sessionId, 16)}</dd>
          </div>
          <div className="fact">
            <dt>State</dt>
            <dd className="mono">
              v{snapshot.stateVersion} · mode {snapshot.activeMode} · {snapshot.pendingMessages} pending
            </dd>
          </div>
          <div className="fact">
            <dt>Capabilities</dt>
            <dd>
              {caps.profile} · {caps.total} total — {caps.stable} stable, {caps.experimental}{" "}
              experimental, {caps.limited} limited, {caps.unavailable} unavailable
            </dd>
          </div>
          <div className="fact">
            <dt>Command manifest</dt>
            <dd className="mono">{truncate(bootstrap.commandManifestHash, 12)}</dd>
          </div>
          <div className="fact">
            <dt>Surface</dt>
            <dd>
              terminalAttach {onOff(surface.terminalAttach)} · fileReveal {onOff(surface.fileReveal)} ·
              previewInput {onOff(surface.previewInput)} · openExternal {onOff(surface.openExternal)}
            </dd>
          </div>
          <div className="fact">
            <dt>Contract</dt>
            <dd>
              <span className="mono">v{bootstrap.contractVersion}</span>
              {contractOk ? null : (
                <span className="chip chip-warn">expected v{CLIENT_CONTRACT_VERSION}</span>
              )}
            </dd>
          </div>
          <div className="fact">
            <dt>Events</dt>
            <dd className="mono">
              {eventCount} received · last {lastEventKind}
            </dd>
          </div>
        </dl>
      </section>
    </Shell>
  );
}

export function App({ client }: { readonly client: StudioClient }) {
  const [view, dispatch] = useReducer(reducer, { kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: Unsubscribe | undefined;
    client
      .bootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        dispatch({ type: "ready", bootstrap });
        unsubscribe = client.subscribe({ scope: "all" }, (event) => {
          if (!cancelled) dispatch({ type: "event", event });
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) dispatch({ type: "failed", error: asClientError(cause) });
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client]);

  useEffect(() => {
    return () => {
      void client.close();
    };
  }, [client]);

  switch (view.kind) {
    case "loading":
      return <LoadingView />;
    case "error":
      return <ErrorView error={view.error} />;
    case "ready":
      return <ReadyView state={view} />;
  }
}

