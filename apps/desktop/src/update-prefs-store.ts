import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSemver } from "./chrome-app-update.js";

export interface UpdatePrefs {
  readonly mirrorPrefix: string;
  readonly autoCheck: boolean;
  readonly skippedAppVersion: string;
  readonly runtimeChannel: "stable" | "canary";
  readonly preferHotUpdate: boolean;
  readonly lastIndexSequence: number;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  mirrorPrefix: "",
  autoCheck: true,
  skippedAppVersion: "",
  runtimeChannel: "stable",
  preferHotUpdate: true,
  lastIndexSequence: 0,
};

const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/u;

export function validateMirrorPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > 512) {
    throw new TypeError("Mirror prefix exceeds 512 characters");
  }
  if (CONTROL_CHARS_REGEX.test(trimmed)) {
    throw new TypeError("Mirror prefix contains control characters");
  }
  try {
    const urlToTest = trimmed.includes("{url}")
      ? trimmed.replace("{url}", "https://github.com/test")
      : trimmed.endsWith("/")
        ? `${trimmed}https://github.com/test`
        : `${trimmed}/https://github.com/test`;
    const parsed = new URL(urlToTest);
    if (parsed.protocol !== "https:") {
      throw new TypeError("Mirror prefix must produce an https URL");
    }
  } catch (error) {
    throw new TypeError(`Mirror prefix is not a valid URL prefix: ${String(error)}`);
  }
  return trimmed;
}

export function validateSkippedVersion(version: string): string {
  const trimmed = version.trim();
  if (trimmed.length === 0) return "";
  if (!parseSemver(trimmed)) {
    throw new TypeError(`Invalid skipped version format: ${version}`);
  }
  return trimmed;
}

export function parseUpdatePrefs(value: unknown): UpdatePrefs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_UPDATE_PREFS;
  }
  const raw = value as Record<string, unknown>;

  let mirrorPrefix = DEFAULT_UPDATE_PREFS.mirrorPrefix;
  if (typeof raw.mirrorPrefix === "string") {
    try {
      mirrorPrefix = validateMirrorPrefix(raw.mirrorPrefix);
    } catch {
      mirrorPrefix = DEFAULT_UPDATE_PREFS.mirrorPrefix;
    }
  }

  const autoCheck =
    typeof raw.autoCheck === "boolean" ? raw.autoCheck : DEFAULT_UPDATE_PREFS.autoCheck;

  let skippedAppVersion = DEFAULT_UPDATE_PREFS.skippedAppVersion;
  if (typeof raw.skippedAppVersion === "string") {
    try {
      skippedAppVersion = validateSkippedVersion(raw.skippedAppVersion);
    } catch {
      skippedAppVersion = DEFAULT_UPDATE_PREFS.skippedAppVersion;
    }
  }

  const runtimeChannel =
    raw.runtimeChannel === "stable" || raw.runtimeChannel === "canary"
      ? raw.runtimeChannel
      : DEFAULT_UPDATE_PREFS.runtimeChannel;

  const preferHotUpdate =
    typeof raw.preferHotUpdate === "boolean"
      ? raw.preferHotUpdate
      : DEFAULT_UPDATE_PREFS.preferHotUpdate;

  const lastIndexSequence =
    typeof raw.lastIndexSequence === "number" &&
    Number.isSafeInteger(raw.lastIndexSequence) &&
    raw.lastIndexSequence >= 0
      ? raw.lastIndexSequence
      : DEFAULT_UPDATE_PREFS.lastIndexSequence;

  return {
    mirrorPrefix,
    autoCheck,
    skippedAppVersion,
    runtimeChannel,
    preferHotUpdate,
    lastIndexSequence,
  };
}

export function createUpdatePrefsStore(input: { readonly appDataDirectory: string }): {
  read(): Promise<UpdatePrefs>;
  write(patch: Partial<UpdatePrefs>): Promise<UpdatePrefs>;
} {
  const storePath = join(input.appDataDirectory, "update-prefs.json");
  let writes: Promise<unknown> = Promise.resolve();

  return {
    async read(): Promise<UpdatePrefs> {
      try {
        const text = await readFile(storePath, "utf8");
        return parseUpdatePrefs(JSON.parse(text));
      } catch {
        return DEFAULT_UPDATE_PREFS;
      }
    },

    async write(patch: Partial<UpdatePrefs>): Promise<UpdatePrefs> {
      const result = writes.then(async () => {
      const current = await this.read();

      const nextMirrorPrefix =
        patch.mirrorPrefix !== undefined ? validateMirrorPrefix(patch.mirrorPrefix) : current.mirrorPrefix;

      const nextSkippedVersion =
        patch.skippedAppVersion !== undefined
          ? validateSkippedVersion(patch.skippedAppVersion)
          : current.skippedAppVersion;

      const nextChannel =
        patch.runtimeChannel !== undefined
          ? patch.runtimeChannel === "canary"
            ? "canary"
            : "stable"
          : current.runtimeChannel;

      const nextAutoCheck =
        patch.autoCheck !== undefined ? Boolean(patch.autoCheck) : current.autoCheck;

      const nextPreferHot =
        patch.preferHotUpdate !== undefined ? Boolean(patch.preferHotUpdate) : current.preferHotUpdate;

      const nextSequence =
        patch.lastIndexSequence !== undefined &&
        Number.isSafeInteger(patch.lastIndexSequence) &&
        patch.lastIndexSequence >= 0
          ? Math.max(current.lastIndexSequence, patch.lastIndexSequence)
          : current.lastIndexSequence;

      const updated: UpdatePrefs = {
        mirrorPrefix: nextMirrorPrefix,
        autoCheck: nextAutoCheck,
        skippedAppVersion: nextSkippedVersion,
        runtimeChannel: nextChannel,
        preferHotUpdate: nextPreferHot,
        lastIndexSequence: nextSequence,
      };

      await mkdir(input.appDataDirectory, { recursive: true });
      const tmpPath = `${storePath}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      try {
        await rename(tmpPath, storePath);
      } finally {
        await unlink(tmpPath).catch(() => undefined);
      }

      return updated;
      });
      writes = result.catch(() => undefined);
      return result;
    },
  };
}
