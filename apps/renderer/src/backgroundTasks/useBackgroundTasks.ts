import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { StudioJobAgentLink, StudioJobSnapshot, StudioServiceRow } from "@omp-studio/studio-protocol";
import { hostErrorMessage, waitReceipt } from "../hostError";
import {
  PREVIEW_BACKGROUND_JOB_AGENTS,
  PREVIEW_BACKGROUND_MAIN_AGENT_ID,
  PREVIEW_BACKGROUND_JOBS,
  PREVIEW_BACKGROUND_SERVICES,
} from "../preview/backgroundTasksPreview";
import { invokeServiceCommand } from "../services/serviceCommands";
import { buildBackgroundTasks, mainConversationJobs, mainConversationServices, type BackgroundTask } from "./backgroundTasksModel";

export type BackgroundTasksOptions = {
  client?: StudioClient | undefined;
  sessionId?: string | undefined;
  scopeKey: string;
  mainAgentId?: string | undefined;
  jobs: readonly StudioJobSnapshot[];
  jobAgents?: readonly StudioJobAgentLink[] | undefined;
  jobsReady: boolean;
  available: boolean;
  canListServices: boolean;
  canStopServices: boolean;
  canCancelJobs: boolean;
  active: boolean;
  expanded?: boolean | undefined;
  preview: boolean;
  document?: Document | undefined;
};

const ACTIVE_POLL_MS = 4_000;
const IDLE_COLLAPSED_POLL_MS = 16_000;

function sameServices(a: readonly StudioServiceRow[], b: readonly StudioServiceRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.name !== right.name
      || left.instanceId !== right.instanceId
      || left.state !== right.state
      || left.startedAt !== right.startedAt
      || left.exitedAt !== right.exitedAt
      || left.exitCode !== right.exitCode
      || left.restartCount !== right.restartCount
      || left.outputBytes !== right.outputBytes
      || left.mode !== right.mode
      || left.ownerId !== right.ownerId
      || left.ownerAgentId !== right.ownerAgentId
      || left.previewUrl !== right.previewUrl
    ) {
      return false;
    }
  }
  return true;
}

type ServicesState = "loading" | "ready" | "unavailable" | "error";
type TaskScope = {
  services: readonly StudioServiceRow[];
  previewJobs: readonly StudioJobSnapshot[];
  rows: BackgroundTask[];
  servicesState: ServicesState;
  servicesError: string;
  servicesEnabled: boolean;
  pending: ReadonlySet<string>;
  actionErrors: ReadonlyMap<string, string>;
  mounted: boolean;
  readEpoch: number;
  servicesRevision: number;
  flight: Promise<void> | undefined;
};

function createScope(preview: boolean): TaskScope {
  return {
    services: preview ? PREVIEW_BACKGROUND_SERVICES : [],
    previewJobs: preview ? PREVIEW_BACKGROUND_JOBS : [],
    rows: [],
    servicesState: preview ? "ready" : "loading",
    servicesError: "",
    servicesEnabled: true,
    pending: new Set(),
    actionErrors: new Map(),
    mounted: true,
    readEpoch: 0,
    servicesRevision: 0,
    flight: undefined,
  };
}

function invalidateReads(scope: TaskScope) {
  scope.readEpoch += 1;
  // A new visible epoch must not wait for an obsolete receipt's timeout.
  scope.flight = undefined;
}

/**
 * Own once in the workspace; pass this result to every window/card/summary.
 * Only the current scope is retained. Jobs are always derived from the snapshot.
 */
export function useBackgroundTasks(options: BackgroundTasksOptions) {
  const {
    client, sessionId, scopeKey, mainAgentId, jobs, jobAgents, jobsReady, available,
    canListServices, canStopServices, canCancelJobs, active, expanded, preview,
  } = options;
  const document = options.document ?? globalThis.document;
  const [, redraw] = useReducer((revision: number) => revision + 1, 0);
  // This local controller gives callbacks a synchronous pending/read fence without
  // an app-wide cache. Snapshot object churn never replaces it or the poller.
  const owner = preview ? PREVIEW_BACKGROUND_MAIN_AGENT_ID : mainAgentId;
  const scope = useMemo(() => createScope(preview), [client, sessionId, scopeKey, preview, owner]);
  const rows = useMemo(() => buildBackgroundTasks(
    mainConversationJobs(preview ? scope.previewJobs : jobsReady ? jobs : [], owner),
    mainConversationServices(scope.services, owner, sessionId),
    preview ? PREVIEW_BACKGROUND_JOB_AGENTS : jobAgents,
  ), [preview, scope.previewJobs, scope.services, jobsReady, jobs, jobAgents, owner, sessionId]);
  scope.rows = rows;

  useEffect(() => {
    scope.mounted = true;
    return () => { scope.mounted = false; invalidateReads(scope); };
  }, [scope]);

  const refresh = useCallback((): Promise<void> => {
    if (preview || !scope.mounted || !active || !available || !client || !canListServices || document?.hidden) {
      return Promise.resolve();
    }
    if (scope.flight) return scope.flight;
    const epoch = scope.readEpoch;
    const servicesRevision = scope.servicesRevision;
    // Never flip an already settled view back to "loading" on background polls
    // (doing so flashes "Loading" <-> "No tasks" every poll tick).
    const flight = (async () => {
      try {
        const result = await invokeServiceCommand(client, "services.list", {});
        if (!scope.mounted || epoch !== scope.readEpoch || servicesRevision !== scope.servicesRevision || document?.hidden) return;
        const nextState: ServicesState = result.enabled ? "ready" : "unavailable";
        const changed =
          scope.servicesState !== nextState
          || scope.servicesEnabled !== result.enabled
          || scope.servicesError !== ""
          || !sameServices(scope.services, result.services);
        scope.services = result.services;
        scope.servicesEnabled = result.enabled;
        scope.servicesState = nextState;
        scope.servicesError = "";
        if (changed) redraw();
      } catch (cause) {
        if (!scope.mounted || epoch !== scope.readEpoch || servicesRevision !== scope.servicesRevision || document?.hidden) return;
        // Preserve last-known services and all snapshot jobs on a source failure.
        const nextError = hostErrorMessage(cause, "Services unavailable");
        const changed = scope.servicesState !== "error" || scope.servicesError !== nextError;
        scope.servicesState = "error";
        scope.servicesError = nextError;
        if (changed) redraw();
      }
    })();
    scope.flight = flight;
    void flight.then(() => { if (scope.flight === flight) scope.flight = undefined; });
    return flight;
  }, [scope, preview, active, available, client, canListServices, document]);

  useEffect(() => {
    if (preview) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const suspend = () => {
      clearTimer();
      invalidateReads(scope);
    };
    const nextInterval = () => {
      if (expanded !== false) return ACTIVE_POLL_MS;
      if (scope.servicesState !== "ready") return ACTIVE_POLL_MS;
      if (scope.rows.some((row) => row.active)) return ACTIVE_POLL_MS;
      return IDLE_COLLAPSED_POLL_MS;
    };
    const schedule = (epoch: number) => {
      clearTimer();
      if (cancelled || !scope.mounted || epoch !== scope.readEpoch || document?.hidden) return;
      timer = setTimeout(() => {
        if (cancelled || !scope.mounted || epoch !== scope.readEpoch || document?.hidden) return;
        void refresh().finally(() => schedule(epoch));
      }, nextInterval());
    };
    const resume = () => {
      suspend();
      if (!active || !available || !client || !canListServices || document?.hidden) return;
      const epoch = scope.readEpoch;
      // Coalesce StrictMode's initial effect replay before sending any command.
      queueMicrotask(() => {
        if (!cancelled && scope.mounted && epoch === scope.readEpoch && !document?.hidden) {
          void refresh().finally(() => schedule(epoch));
        }
      });
    };
    resume();
    document?.addEventListener("visibilitychange", resume);
    return () => {
      cancelled = true;
      document?.removeEventListener("visibilitychange", resume);
      suspend();
    };
  }, [scope, preview, active, expanded, available, client, canListServices, document, refresh]);

  // Terminal truth (not a cancellation receipt) releases pending. Evicted keys
  // are discarded only when their source is known, keeping this state bounded.
  useEffect(() => {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const unknown = (key: string) => key.startsWith("job:")
      ? !preview && !jobsReady
      : scope.servicesState !== "ready";
    const pending = new Set([...scope.pending].filter((key) => {
      const row = byKey.get(key);
      return row ? row.active : unknown(key);
    }));
    const errors = new Map([...scope.actionErrors].filter(([key]) => byKey.has(key) || unknown(key)));
    if (pending.size !== scope.pending.size || errors.size !== scope.actionErrors.size) {
      scope.pending = pending;
      scope.actionErrors = errors;
      redraw();
    }
  }, [scope, rows, preview, jobsReady]);

  const canStop = useCallback((task: BackgroundTask): boolean => {
    const current = scope.rows.find((row) => row.key === task.key);
    if (!scope.mounted || !current?.active || scope.pending.has(task.key)) return false;
    if (current.kind === "service" && current.state === "stopping") return false;
    if (preview) return true;
    if (!available || !client) return false;
    return current.kind === "job" ? jobsReady && canCancelJobs : canStopServices && scope.servicesEnabled;
  }, [scope, preview, available, client, jobsReady, canCancelJobs, canStopServices]);

  const stop = useCallback(async (task: BackgroundTask): Promise<void> => {
    if (!canStop(task)) return;
    const current = scope.rows.find((row) => row.key === task.key)!;
    const epoch = scope.readEpoch;
    scope.pending = new Set([...scope.pending, current.key]);
    const errors = new Map(scope.actionErrors);
    errors.delete(current.key);
    scope.actionErrors = errors;
    redraw();

    if (preview) {
      const now = Date.now();
      if (current.kind === "job") {
        scope.previewJobs = scope.previewJobs.map((job) => job === current.job
          ? { ...job, status: "cancelled", completedAt: new Date(now).toISOString() }
          : job);
      } else {
        scope.services = scope.services.map((service) => service === current.service
          ? { ...service, state: "exited", exitedAt: now, exitCode: 0 }
          : service);
      }
      scope.pending = new Set([...scope.pending].filter((key) => key !== current.key));
      redraw();
      return;
    }

    try {
      if (current.kind === "job") {
        const handle = await client!.command("job.cancel", {
          jobId: current.job.jobId,
          expectedGeneration: current.job.generation,
        });
        // Runtime owns the confirmation chain. Even a completed receipt can mean
        // cancellation_requested; only a later terminal snapshot settles the row.
        await waitReceipt(client!, handle.requestId);
      } else {
        const result = await invokeServiceCommand(client, "services.stop", {
          name: current.service.name,
          instanceId: current.service.instanceId,
        });
        if (!scope.mounted || epoch !== scope.readEpoch || document?.hidden) return;
        // Discard older list reads without invalidating sibling stop receipts or
        // the poller's visibility epoch. Every service in a batch must settle.
        scope.servicesRevision += 1;
        scope.flight = undefined;
        scope.services = scope.services.map((service) =>
          service.name === current.service.name && service.instanceId === current.service.instanceId
            ? result.service : service);
        redraw();
      }
    } catch (cause) {
      if (!scope.mounted) return;
      scope.pending = new Set([...scope.pending].filter((key) => key !== current.key));
      scope.actionErrors = new Map(scope.actionErrors).set(current.key, hostErrorMessage(cause, "Cannot stop task"));
      redraw();
    }
  }, [scope, canStop, preview, client, document]);

  return {
    rows,
    servicesState: (preview ? "ready" : !available || !client || !canListServices ? "unavailable" : scope.servicesState) as ServicesState,
    servicesError: scope.servicesError,
    jobsReady: preview || (jobsReady && owner !== undefined),
    pending: scope.pending,
    actionErrors: scope.actionErrors,
    refresh,
    stop,
    canStop,
  };
}
