import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  evaluationTerminal,
  type EvaluationRecord,
  type EvaluationPlan,
  type EvaluationSpec,
  type EvaluationListInput,
  type EvaluationListResult,
  type EvaluationStartInput,
  type EvaluationControlInput,
  type EvaluationNativeSnapshot,
  type EvaluationResultPage,
  type EvaluationWorkspaceOperation,
  type EvaluationContext,
  type StudioPendingInteraction,
  type EvaluationExportInput,
  type EvaluationExportResult,
} from "@omp-studio/studio-protocol";
import type { ArtifactLibrary } from "./artifact-library.js";

export interface EvaluationWorker {
  sessionId: string;
  runtimeVersion: string;
  invoke(operation: EvaluationWorkspaceOperation): Promise<unknown>;
  context(): Promise<EvaluationContext>;
  preserveInputs?(spec: EvaluationSpec): Promise<EvaluationSpec>;
  pending(): StudioPendingInteraction | undefined;
  respond(input: {
    interactionId: string;
    leaseGeneration: number;
    decision: "submit" | "cancel";
    value?: unknown;
  }): Promise<void>;
  subscribe(listener: () => void): () => void;
  release(): Promise<void>;
}
export interface EvaluationWorkerFactory {
  reveal?(path: string): Promise<void>;
  open(workspaceId: string, attachSessionId?: string): Promise<EvaluationWorker>;
}
interface Resident {
  worker: EvaluationWorker;
  unsubscribe: () => void;
  timer: ReturnType<typeof setInterval>;
  refreshing?: Promise<void>;
  again: boolean;
  revision: number;
}
const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const csv = (value: unknown) => '"' + String(value ?? "").replaceAll('"', '""') + '"';

/** Durable report owner. Neither navigation nor Renderer subscriptions own running work. */
export class EvaluationCoordinator {
  readonly #records = new Map<string, EvaluationRecord>();
  readonly #residents = new Map<string, Resident>();
  readonly #prepared = new Map<string, Promise<EvaluationWorker>>();
  readonly #starts = new Set<Promise<EvaluationRecord>>();
  readonly #listeners = new Set<() => void>();
  readonly #ready: Promise<void>;
  readonly #sessions = new Set<string>();
  readonly #writes = new Map<string, Promise<void>>();
  readonly #rowVersions = new Map<string, Map<string, string>>();
  #sessionWrite = Promise.resolve();
  #closed = false;
  constructor(
    readonly directory: string,
    readonly workers: EvaluationWorkerFactory,
    readonly artifacts: ArtifactLibrary,
  ) {
    this.#ready = this.#load();
  }
  async #load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      for (const id of JSON.parse(
        await readFile(join(this.directory, "sessions.json"), "utf8"),
      ) as string[])
        this.#sessions.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".record.json")) continue;
      const record = JSON.parse(
        await readFile(join(this.directory, name), "utf8"),
      ) as EvaluationRecord;
      if (!evaluationTerminal(record.state) && record.state !== "ready") {
        record.state = "interrupted";
        record.error =
          "Runtime stopped. Recorded results are retained; rerun requires an explicit start.";
      }
      delete record.interaction;
      this.#records.set(record.id, record);
    }
    await this.#importLegacy();
  }
  async #importLegacy(): Promise<void> {
    // Existing manually saved artifacts remain the authority for old reports.
    for (const kind of ["benchmark", "judgment"] as const) {
      let cursor: string | undefined;
      do {
        const page = await this.artifacts.list({ kind, limit: 200, ...(cursor ? { cursor } : {}) });
        for (const artifact of page.artifacts) {
          if (
            [...this.#records.values()].some((record) =>
              record.legacyArtifactIds?.includes(artifact.artifactId),
            )
          )
            continue;
          try {
            const { text } = await this.artifacts.readText(artifact.artifactId);
            const data = JSON.parse(text) as {
              run?: {
                spec: Omit<Extract<EvaluationSpec, { kind: "benchmark" }>, "kind">;
                state: EvaluationRecord["state"];
              };
              models?: unknown[];
              batch?: { intent: string; total: number; done: number; failed: number; cost: number };
              items?: unknown[];
              offset?: number;
            };
            if (kind === "benchmark" && !data.run?.spec) continue;
            if (kind === "judgment" && !data.batch) continue;
            const id = randomUUID();
            const record: EvaluationRecord = {
              id,
              workspaceId: artifact.workspaceId ?? "",
              title: data.batch?.intent ?? artifact.name,
              spec: data.run
                ? { kind: "benchmark", ...data.run.spec }
                : { kind: "judgment", items: [], questions: {} },
              state: data.run?.state ?? "completed",
              createdAt: artifact.createdAt,
              updatedAt: artifact.createdAt,
              completed: data.batch?.done ?? 0,
              total: data.batch?.total ?? 0,
              failed: data.batch?.failed ?? 0,
              cost: data.batch?.cost ?? null,
              metrics: [],
              detail: { legacy: true, originalName: artifact.name, nativeRunId: artifact.runId },
              revision: 0,
              replayable: !!data.run,
              legacyArtifactIds: [artifact.artifactId],
            };
            const existing =
              kind === "judgment" && artifact.runId
                ? [...this.#records.values()].find(
                    (r) => r.spec.kind === "judgment" && r.detail.nativeRunId === artifact.runId,
                  )
                : undefined;
            if (existing) {
              existing.legacyArtifactIds!.push(artifact.artifactId);
              const additional = (data.items ?? [])
                .map((item, index) =>
                  JSON.stringify({ key: String((data.offset ?? 0) + index), data: item }),
                )
                .join("\n");
              if (additional)
                await writeFile(this.#path(existing.id, "rows.jsonl"), additional + "\n", {
                  flag: "a",
                });
              const old = JSON.parse(
                await readFile(this.#path(existing.id, "native.json"), "utf8"),
              ) as { items?: unknown[] };
              await writeFile(
                this.#path(existing.id, "native.json"),
                JSON.stringify({
                  batch: data.batch,
                  items: [...(old.items ?? []), ...(data.items ?? [])],
                }),
              );
              await this.#save(existing);
              continue;
            }
            this.#records.set(id, record);
            await writeFile(this.#path(id, "native.json"), text);
            await writeFile(
              this.#path(id, "rows.jsonl"),
              (data.items ?? data.models ?? [])
                .map((item, index) => JSON.stringify({ key: String(index), data: item }))
                .join("\n") + "\n",
            );
            await this.#save(record);
          } catch {
            /* Non-report artifacts remain readable in the artifact library. */
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
  sessionIds(): Set<string> {
    return new Set(this.#sessions);
  }
  async #openWorker(workspaceId: string, attachSessionId?: string): Promise<EvaluationWorker> {
    await this.#ready;
    if (this.#closed) throw new Error("Host is shutting down");
    const worker = await this.workers.open(workspaceId, attachSessionId);
    try {
      if (this.#closed) throw new Error("Host is shutting down");
      if (!attachSessionId) {
        this.#sessions.add(worker.sessionId);
        this.#sessionWrite = this.#sessionWrite.catch(() => {}).then(() =>
          writeFile(join(this.directory, "sessions.json"), JSON.stringify([...this.#sessions])),
        );
        await this.#sessionWrite;
      }
      return worker;
    } catch (error) {
      await worker.release();
      throw error;
    }
  }
  #path(id: string, suffix: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid evaluation identity");
    return join(this.directory, `${id}.${suffix}`);
  }
  async #save(record: EvaluationRecord): Promise<void> {
    const text = JSON.stringify(record),
      dest = this.#path(record.id, "record.json");
    const next = (this.#writes.get(record.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const temporary = `${dest}.tmp`;
        await writeFile(temporary, text, "utf8");
        await rename(temporary, dest);
      });
    this.#writes.set(record.id, next);
    try {
      await next;
      delete record.saveError;
    } catch (error) {
      record.saveError = `Report could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    } finally {
      if (this.#writes.get(record.id) === next) this.#writes.delete(record.id);
    }
  }
  async list(input: EvaluationListInput = {}): Promise<EvaluationListResult> {
    await this.#ready;
    const records = [...this.#records.values()]
      .filter(
        (r) =>
          (!input.workspaceId || !r.workspaceId || r.workspaceId === input.workspaceId) &&
          (!input.kind || r.spec.kind === input.kind) &&
          (!input.search ||
            `${r.title} ${r.id}`.toLowerCase().includes(input.search.toLowerCase())),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      records: records.slice(
        input.offset ?? 0,
        (input.offset ?? 0) + Math.min(input.limit ?? 50, 200),
      ),
      total: records.length,
    };
  }
  async read(id: string): Promise<EvaluationRecord> {
    await this.#ready;
    const record = this.#records.get(id);
    if (!record) throw new Error("Evaluation not found");
    return record;
  }
  #planningWorker(workspaceId: string): Promise<EvaluationWorker> {
    if (this.#closed) return Promise.reject(new Error("Host is shutting down"));
    let pending = this.#prepared.get(workspaceId);
    if (!pending) {
      pending = this.#openWorker(workspaceId);
      this.#prepared.set(workspaceId, pending);
      void pending.catch(() => {
        if (this.#prepared.get(workspaceId) === pending) this.#prepared.delete(workspaceId);
      });
    }
    return pending;
  }
  async #discardPrepared(workspaceId: string, worker: EvaluationWorker): Promise<void> {
    const pending = this.#prepared.get(workspaceId);
    if (pending && await pending === worker && this.#prepared.get(workspaceId) === pending) {
      this.#prepared.delete(workspaceId);
      await worker.release();
    }
  }
  async context(workspaceId: string): Promise<EvaluationContext> {
    try {
      const worker = await this.#planningWorker(workspaceId),
        context = await worker.context().catch(async error => {
          await this.#discardPrepared(workspaceId, worker);
          throw error;
        });
      if (!context.available) {
        await this.#discardPrepared(workspaceId, worker);
      }
      return context;
    } catch (error) {
      return {
        available: false,
        models: [],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async prepare(input: { workspaceId: string; spec: EvaluationSpec }): Promise<EvaluationPlan> {
    const worker = await this.#planningWorker(input.workspaceId);
    const plan = (await worker.invoke({
      kind: "evaluation.runtime.plan",
      spec: input.spec,
    })) as EvaluationPlan;
    if (worker.preserveInputs) plan.spec = await worker.preserveInputs(plan.spec);
    return plan;
  }
  start(input: EvaluationStartInput): Promise<EvaluationRecord> {
    const pending = this.#start(input);
    this.#starts.add(pending);
    void pending.finally(() => this.#starts.delete(pending)).catch(() => {});
    return pending;
  }
  async #start(input: EvaluationStartInput): Promise<EvaluationRecord> {
    await this.#ready;
    if (this.#closed) throw new Error("Host is shutting down");
    const prepared = this.#prepared.get(input.workspaceId);
    this.#prepared.delete(input.workspaceId);
    const preparedWorker = await prepared;
    const attachSessionId = input.spec.kind === "judgment" ? input.spec.attachSessionId : undefined;
    if (attachSessionId) await preparedWorker?.release();
    const worker =
      attachSessionId
        ? await this.#openWorker(input.workspaceId, attachSessionId)
        : preparedWorker ?? await this.#openWorker(input.workspaceId);
    const id = randomUUID(),
      now = new Date().toISOString();
    let plan: EvaluationPlan;
    try {
      plan = await worker.invoke({ kind: "evaluation.runtime.plan", spec: input.spec }) as EvaluationPlan;
      if (this.#closed) throw new Error("Host is shutting down");
    } catch (error) {
      await worker.release();
      throw error;
    }
    const record: EvaluationRecord = {
      id,
      workspaceId: input.workspaceId,
      title: input.title.trim() || input.spec.kind,
      spec: structuredClone(plan.spec),
      plan,
      createdAt: now,
      updatedAt: now,
      runtimeVersion: worker.runtimeVersion,
      sessionId: worker.sessionId,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      state: "preparing",
      completed: 0,
      total: 0,
      failed: 0,
      cost: null,
      revision: 0,
      metrics: [],
      detail: {},
    };
    this.#records.set(id, record);
    try {
      await this.#save(record);
      if (this.#closed) throw new Error("Host is shutting down");
      Object.assign(
        record,
        await worker.invoke({
          kind: "evaluation.runtime.start",
          id,
          title: record.title,
          spec: record.spec,
        }),
      );
      this.#attach(record, worker);
      await this.#refresh(id);
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      try {
        await this.#save(record);
      } finally {
        if (this.#residents.has(id)) await this.#release(id);
        else await worker.release();
      }
    }
    this.#changed();
    return record;
  }
  #attach(record: EvaluationRecord, worker: EvaluationWorker): void {
    const refresh = () => {
      void this.#refresh(record.id);
    };
    const resident: Resident = {
      worker,
      unsubscribe: worker.subscribe(refresh),
      timer: setInterval(refresh, 1000),
      again: false,
      revision: -1,
    };
    resident.timer.unref?.();
    this.#residents.set(record.id, resident);
  }
  async #readChunks(
    worker: EvaluationWorker,
    id: string,
    kind: "evaluation.runtime.report" | "evaluation.runtime.patch",
    destination: string,
  ): Promise<void> {
    const temporary = `${destination}.tmp`,
      handle = await open(temporary, "w");
    try {
      let offset = 0;
      for (;;) {
        const page = (await worker.invoke({ kind, id, offset })) as {
          text: string;
          nextOffset: number;
          total: number;
        };
        await handle.writeFile(page.text);
        if (page.nextOffset >= page.total) break;
        if (page.nextOffset <= offset) throw new Error("Report transfer did not advance");
        offset = page.nextOffset;
      }
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  }
  async #saveRows(worker: EvaluationWorker, id: string): Promise<void> {
    const dest = this.#path(id, "rows.jsonl"),
      handle = await open(dest, "a");
    const versions = this.#rowVersions.get(id) ?? new Map<string, string>();
    this.#rowVersions.set(id, versions);
    try {
      let offset = 0;
      for (;;) {
        const page = (await worker.invoke({
          kind: "evaluation.runtime.rows",
          id,
          offset,
          limit: 100,
        })) as EvaluationResultPage;
        for (const row of page.rows) {
          const text = JSON.stringify(row);
          if (versions.get(row.key) === text) continue;
          await handle.writeFile(text + "\n");
          versions.set(row.key, text);
        }
        if (page.nextOffset >= page.total) break;
        if (page.nextOffset <= offset) throw new Error("Result transfer did not advance");
        offset = page.nextOffset;
      }
    } finally {
      await handle.close();
    }
  }
  #refresh(id: string): Promise<void> {
    const resident = this.#residents.get(id),
      record = this.#records.get(id);
    if (!resident || !record) return Promise.resolve();
    if (resident.refreshing) {
      resident.again = true;
      return resident.refreshing;
    }
    resident.refreshing = this.#refreshResident(id, resident, record).finally(() => {
      delete resident.refreshing;
    });
    return resident.refreshing;
  }
  async #refreshResident(id: string, resident: Resident, record: EvaluationRecord): Promise<void> {
    try {
      do {
        resident.again = false;
        const value = (await resident.worker.invoke({
          kind: "evaluation.runtime.read",
          id,
        })) as EvaluationNativeSnapshot;
        const pending = resident.worker.pending();
        let changed = JSON.stringify(record.interaction) !== JSON.stringify(pending);
        if (pending) record.interaction = pending;
        else delete record.interaction;
        if (resident.revision !== value.revision) {
          changed = true;
          Object.assign(record, value, { updatedAt: new Date().toISOString() });
          if (record.spec.kind === "ratchet" && value.detail.configuration)
            record.spec = value.detail.configuration as Extract<
              EvaluationSpec,
              { kind: "ratchet" }
            >;
          try {
            await this.#saveRows(resident.worker, id);
            await this.#readChunks(
              resident.worker,
              id,
              "evaluation.runtime.report",
              this.#path(id, "native.json"),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code)
              record.saveError = `Result storage unavailable: ${String(error)}`;
            throw error;
          }
          if (
            record.spec.kind === "judgment" &&
            record.spec.attachId &&
            record.spec.items.length === 0
          ) {
            const report = JSON.parse(await readFile(this.#path(id, "native.json"), "utf8")) as {
              configuration?: {
                items: Extract<EvaluationSpec, { kind: "judgment" }>["items"];
                questions: Record<
                  string,
                  { type: string; instructions: string; criteria?: unknown }
                >;
                options: { concurrency: number; retries: number; minOk: number };
              };
            };
            if (report.configuration) {
              const config = report.configuration;
              record.spec = {
                kind: "judgment",
                ...config.options,
                items: config.items,
                questions: Object.fromEntries(
                  Object.entries(config.questions).map(([key, q]) => [
                    key,
                    { ...q, type: q.type === "noul" ? "bool" : q.type },
                  ]),
                ) as Extract<EvaluationSpec, { kind: "judgment" }>["questions"],
              };
              record.replayable = config.items.every(
                (item) => !item.images || item.images.every((image) => typeof image === "string"),
              );
            }
          }
          if (evaluationTerminal(record.state)) record.finishedAt ??= new Date().toISOString();
          if (record.spec.kind === "ratchet" && record.detail.patchAvailable)
            await this.#readChunks(
              resident.worker,
              id,
              "evaluation.runtime.patch",
              this.#path(id, "best.patch"),
            );
          await this.#save(record);
          resident.revision = value.revision;
        }
        if (changed) this.#changed();
      } while (resident.again && !evaluationTerminal(record.state));
      if (evaluationTerminal(record.state) && record.spec.kind !== "ratchet")
        await this.#release(id);
    } catch (error) {
      // A failed write is retryable while the Worker remains resident. A lost Worker is never restarted into paid work.
      record.error = error instanceof Error ? error.message : String(error);
      if (!record.saveError) {
        record.state = "interrupted";
        await this.#save(record).catch(() => {});
        await this.#release(id);
      }
      this.#changed();
    }
  }
  async #release(id: string): Promise<void> {
    const resident = this.#residents.get(id);
    if (!resident) return;
    clearInterval(resident.timer);
    resident.unsubscribe();
    this.#residents.delete(id);
    this.#rowVersions.delete(id);
    await resident.worker.release();
  }
  async rows(input: {
    id: string;
    offset?: number;
    limit?: number;
  }): Promise<EvaluationResultPage> {
    await this.read(input.id);
    const offset = input.offset ?? 0, limit = Math.min(input.limit ?? 50, 200);
    const current = await this.#readRows(input.id);
    const rows = current.slice(offset, offset + limit);
    return { rows, offset, nextOffset: offset + rows.length, total: current.length };
  }
  async #readRows(id: string): Promise<EvaluationResultPage["rows"]> {
    const current = new Map<string, EvaluationResultPage["rows"][number]>();
    try {
      for await (const line of createInterface({
        input: createReadStream(this.#path(id, "rows.jsonl")),
        crlfDelay: Infinity,
      })) {
        if (line) {
          const row = JSON.parse(line) as EvaluationResultPage["rows"][number];
          current.set(row.key, row);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return [...current.values()];
  }
  async control(input: EvaluationControlInput): Promise<EvaluationRecord> {
    const record = await this.read(input.id);
    let resident = this.#residents.get(input.id);
    if (!resident) {
      if (record.spec.kind !== "ratchet")
        throw new Error("This run ended. Review its configuration to start a new run");
      const worker = await this.#openWorker(record.workspaceId);
      this.#attach(record, worker);
      resident = this.#residents.get(input.id)!;
    }
    Object.assign(
      record,
      await resident.worker.invoke({ ...input, kind: "evaluation.runtime.control" }),
    );
    if (input.spec) record.spec = input.spec;
    delete record.finishedAt;
    await this.#save(record);
    await this.#refresh(record.id);
    return record;
  }
  async retrySpec(id: string): Promise<EvaluationSpec> {
    const record = await this.read(id);
    if (record.spec.kind !== "judgment" || record.replayable === false)
      throw new Error("This report has no reusable judgment input");
    const failed = new Set<string>();
    for (const row of await this.#readRows(id)) {
      const item = row.data as { key?: string | number; error?: string };
      if (item.error) failed.add(String(item.key ?? row.key));
    }
    const items = record.spec.items.filter((item) => failed.has(String(item.key)));
    if (!items.length) throw new Error("No failed items remain");
    const { attachId: _attach, attachSessionId: _session, ...spec } = record.spec;
    return { ...spec, items, minOk: Math.min(spec.minOk ?? 1, items.length) };
  }
  async respond(input: {
    id: string;
    interactionId: string;
    leaseGeneration: number;
    decision: "submit" | "cancel";
    value?: unknown;
  }): Promise<void> {
    const resident = this.#residents.get(input.id);
    if (!resident) throw new Error("The evaluation is no longer connected");
    await resident.worker.respond(input);
    await this.#refresh(input.id);
  }
  async patch(input: {
    id: string;
    offset?: number;
  }): Promise<{ text: string; nextOffset: number; total: number }> {
    const record = await this.read(input.id);
    if (record.spec.kind !== "ratchet") throw new Error("Only Ratchet produces code patches");
    const text = await readFile(this.#path(input.id, "best.patch"), "utf8"),
      offset = input.offset ?? 0;
    const chunk = text.slice(offset, offset + 48000);
    return { text: chunk, nextOffset: offset + chunk.length, total: text.length };
  }
  async openWorkspace(id: string): Promise<void> {
    const record = await this.read(id);
    if (record.spec.kind !== "ratchet" || typeof record.detail.workspace !== "string")
      throw new Error("Isolated workspace unavailable");
    if (!this.workers.reveal)
      throw new Error("Open this workspace through the connected remote file tools");
    await this.workers.reveal(record.detail.workspace);
  }
  async export(input: EvaluationExportInput): Promise<EvaluationExportResult> {
    const record = await this.read(input.id);
    const name = `${record.title.replace(/[\\/:*?"<>|]/g, "-")}-${record.id.slice(0, 8)}.${input.format}`;
    let bytes: Uint8Array, mimeType: string;
    if (input.format === "json") {
      bytes = await readFile(this.#path(record.id, "native.json"));
      mimeType = "application/json";
    } else if (input.format === "patch") {
      bytes = await readFile(this.#path(record.id, "best.patch"));
      mimeType = "text/plain";
    } else {
      const rows = await this.#readRows(record.id);
      const text =
        input.format === "csv"
          ? "key,model,phase,result\r\n" +
            rows
              .map((r) => [r.key, r.model, r.phase, JSON.stringify(r.data)].map(csv).join(","))
              .join("\r\n")
          : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(record.title)}</title><style>body{font:15px/1.6 system-ui;margin:40px auto;max-width:1080px;padding:0 24px;color:#20222b}table{width:100%;border-collapse:collapse}th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#666}</style><h1>${escapeHtml(record.title)}</h1><p>${escapeHtml(record.state)} · ${record.completed}/${record.total} · ${record.cost === null ? "Price unavailable" : "$" + record.cost.toFixed(4)}</p><small>${escapeHtml(record.createdAt)} · OMP ${escapeHtml(record.runtimeVersion)}</small><h2>Configuration</h2><pre>${escapeHtml(JSON.stringify(record.spec, null, 2))}</pre><h2>Results</h2><table><tr><th>Item</th><th>Model</th><th>Result</th></tr>${rows.map((r) => `<tr><td>${escapeHtml(r.key)}</td><td>${escapeHtml(r.model)}</td><td><pre>${escapeHtml(JSON.stringify(r.data, null, 2))}</pre></td></tr>`).join("")}</table>`;
      bytes = new TextEncoder().encode(text);
      mimeType = input.format === "csv" ? "text/csv" : "text/html";
    }
    const artifact = await this.artifacts.registerBytes(
      { kind: "export", name, mimeType, workspaceId: record.workspaceId, runId: record.id },
      bytes,
    );
    return { artifactId: artifact.artifactId, name: artifact.name };
  }
  async exportChunk(input: {
    artifactId: string;
    offset?: number;
  }): Promise<{ data: string; nextOffset: number; total: number; mimeType: string; name: string }> {
    const artifact = await this.artifacts.resolve(input.artifactId);
    const offset = input.offset ?? 0,
      handle = await open(artifact.path, "r");
    try {
      const buffer = Buffer.alloc(48 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
      return {
        data: buffer.subarray(0, bytesRead).toString("base64"),
        nextOffset: offset + bytesRead,
        total: artifact.record.bytes,
        mimeType: artifact.record.mimeType,
        name: artifact.record.name,
      };
    } finally {
      await handle.close();
    }
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#starts);
    await this.#ready;
    for (const [id, resident] of this.#residents) {
      try {
        await resident.refreshing;
        const current = this.#records.get(id)!;
        if (evaluationTerminal(current.state) || current.state === "ready") {
          await this.#save(current);
          continue;
        }
        await resident.worker.invoke({ kind: "evaluation.runtime.control", id, action: "cancel" });
        const record = this.#records.get(id)!;
        await this.#refresh(id);
        if (!evaluationTerminal(record.state)) {
          record.state = "interrupted";
          record.error =
            "Application closed before the native task settled. Partial results are retained.";
          await this.#save(record);
        }
      } finally {
        await this.#release(id);
      }
    }
    for (const pending of this.#prepared.values()) {
      const worker = await pending.catch(() => undefined);
      await worker?.release();
    }
    this.#prepared.clear();
    await Promise.allSettled(this.#writes.values());
  }
}
