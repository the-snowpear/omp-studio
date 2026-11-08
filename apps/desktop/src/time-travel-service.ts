import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TimeTravelStore,
  type TimeTravelSnapshot,
} from "@omp-studio/studio-host";

export interface TimeTravelSettings {
  readonly enabled: boolean;
  readonly retentionDays: number | null;
  readonly exclusions: readonly string[];
}

const DEFAULT_SETTINGS: TimeTravelSettings = {
  enabled: false,
  retentionDays: null,
  exclusions: [],
};
const services = new Map<string, TimeTravelService>();

export function timeTravelService(profileDirectory: string): TimeTravelService {
  const key = resolve(profileDirectory);
  let service = services.get(key);
  if (!service) {
    service = new TimeTravelService(key);
    services.set(key, service);
  }
  return service;
}

export class TimeTravelService {
  readonly #store: TimeTravelStore;
  readonly #settingsFile: string;
  #queue: Promise<unknown> = Promise.resolve();
  #lastCleanupAt = 0;
  #restoring = false;
  readonly #listeners = new Set<(settings: TimeTravelSettings) => void>();

  constructor(profileDirectory: string) {
    this.#store = new TimeTravelStore(profileDirectory);
    this.#settingsFile = join(profileDirectory, "time-travel", "settings.json");
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action, action);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async settings(): Promise<TimeTravelSettings> {
    try {
      return {
        ...DEFAULT_SETTINGS,
        ...(JSON.parse(
          await readFile(this.#settingsFile, "utf8"),
        ) as Partial<TimeTravelSettings>),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return DEFAULT_SETTINGS;
      throw error;
    }
  }

  subscribe(listener: (settings: TimeTravelSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  updateSettings(
    patch: Partial<TimeTravelSettings>,
  ): Promise<TimeTravelSettings> {
    return this.#serial(async () => {
      const settings = { ...(await this.settings()), ...patch };
      if (
        typeof settings.enabled !== "boolean" ||
        !Array.isArray(settings.exclusions) ||
        settings.exclusions.some((pattern) => typeof pattern !== "string")
      )
        throw new Error("Invalid Time Travel settings");
      if (
        settings.retentionDays !== null &&
        (!Number.isInteger(settings.retentionDays) ||
          settings.retentionDays < 1)
      )
        throw new Error("Retention must be a positive number of days");
      await mkdir(dirname(this.#settingsFile), { recursive: true });
      const temp = `${this.#settingsFile}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(settings), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, this.#settingsFile);
      for (const listener of this.#listeners) listener(settings);
      return settings;
    });
  }

  capture(input: {
    workspace: string;
    sessionId: string;
    leafId: string | null;
    phase: "before" | "after";
  }): Promise<TimeTravelSnapshot | undefined> {
    return this.#serial(async () => {
      const settings = await this.settings();
      if (!settings.enabled) return undefined;
      const snapshot = await this.#store.capture({
        ...input,
        exclusions: settings.exclusions,
      });
      if (
        settings.retentionDays !== null &&
        Date.now() - this.#lastCleanupAt >= 86_400_000
      ) {
        await this.#store.cleanup(
          new Date(Date.now() - settings.retentionDays * 86_400_000),
        );
        this.#lastCleanupAt = Date.now();
      }
      return snapshot;
    });
  }

  async list(
    workspace: string,
    sessionId: string,
  ): Promise<TimeTravelSnapshot[]> {
    if (!(await this.settings()).enabled)
      throw new Error("Time Travel is disabled");
    return await this.#store.list(workspace, sessionId);
  }

  async preview(workspace: string, sessionId: string, snapshotId: string) {
    const settings = await this.settings();
    if (!settings.enabled) throw new Error("Time Travel is disabled");
    return await this.#store.preview(
      workspace,
      sessionId,
      snapshotId,
      settings.exclusions,
    );
  }

  restore(input: {
    workspace: string;
    sessionId: string;
    snapshotId: string;
    expectedRevision: string;
    leafId: string | null;
  }) {
    return this.#serial(async () => {
      const settings = await this.settings();
      if (!settings.enabled) throw new Error("Time Travel is disabled");
      return await this.#store.restore({
        ...input,
        exclusions: settings.exclusions,
      });
    });
  }

  /** Hold settings, capture and cleanup until the entire code/conversation operation settles. */
  withRestore<T>(
    action: (
      store: TimeTravelStore,
      settings: TimeTravelSettings,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#serial(async () => {
      const settings = await this.settings();
      if (!settings.enabled) throw new Error("Time Travel is disabled");
      this.#restoring = true;
      try {
        return await action(this.#store, settings);
      } finally {
        this.#restoring = false;
      }
    });
  }

  storage() {
    return this.#store.storage();
  }

  isRestoring(): boolean {
    return this.#restoring;
  }

  cleanup(scope: "expired" | "all"): Promise<{ removed: number }> {
    return this.#serial(async () => {
      const settings = await this.settings();
      if (scope === "expired" && settings.retentionDays === null)
        return { removed: 0 };
      return await this.#store.cleanup(
        scope === "all"
          ? null
          : new Date(Date.now() - settings.retentionDays! * 86_400_000),
      );
    });
  }
}
