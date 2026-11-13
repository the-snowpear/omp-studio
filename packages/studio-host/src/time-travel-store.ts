import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  chmod,
  copyFile,
  rmdir,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGzip, createGunzip } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ignore from "ignore";

const execFileAsync = promisify(execFile);

function missingDirectory(error: NodeJS.ErrnoException): never[] {
  if (error.code === "ENOENT") return [];
  throw error;
}

export type TimeTravelEntry =
  | {
      readonly path: string;
      readonly kind: "file";
      readonly hash: string;
      readonly mode: number;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly target: string;
    };

export interface TimeTravelSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly leafId: string | null;
  readonly phase: "before" | "after" | "restore-backup";
  readonly createdAt: string;
  readonly entries: readonly TimeTravelEntry[];
  readonly changes?: {
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
  };
}

/** Timeline rows do not retain the checkpoint's complete file manifest. */
export interface TimeTravelSnapshotMetadata extends Omit<TimeTravelSnapshot, "entries"> {
  readonly fileCount: number;
}

export interface TimeTravelChange {
  readonly path: string;
  readonly kind: "add" | "modify" | "delete";
}

export interface TimeTravelRestorePreview {
  readonly snapshotId: string;
  readonly revision: string;
  readonly changes: readonly TimeTravelChange[];
}

type IgnoreMatcher = ReturnType<typeof ignore>;
type IgnoreLayer = { readonly root: string; readonly matcher: IgnoreMatcher };

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safePath(root: string, name: string): string {
  const result = resolve(root, ...name.split("/"));
  const tail = relative(root, result);
  if (
    !name ||
    isAbsolute(name) ||
    name.split(/[\\/]/u).includes(".git") ||
    tail === "" ||
    tail === ".." ||
    tail.startsWith(`..${sep}`)
  ) {
    throw new Error("Snapshot path is outside the workspace");
  }
  return result;
}

async function assertNoLinkParents(root: string, name: string): Promise<void> {
  const parts = name.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (entry?.isSymbolicLink())
      throw new Error(`A parent directory is a symbolic link: ${name}`);
    if (entry && !entry.isDirectory())
      throw new Error(`A parent is not a directory: ${name}`);
  }
}

async function repositoryRoot(workspace: string): Promise<string | undefined> {
  let path = workspace;
  for (;;) {
    if (
      await lstat(join(path, ".git")).then(
        () => true,
        () => false,
      )
    )
      return path;
    const parent = dirname(path);
    if (parent === path) return undefined;
    path = parent;
  }
}

function ignored(
  layers: readonly IgnoreLayer[],
  path: string,
  directory: boolean,
): boolean {
  let excluded = false;
  for (const layer of layers) {
    const name = layer.root ? path.slice(layer.root.length + 1) : path;
    if (!name || (layer.root && !path.startsWith(`${layer.root}/`))) continue;
    const result = layer.matcher.test(directory ? `${name}/` : name);
    if (result.ignored) excluded = true;
    if (result.unignored) excluded = false;
  }
  return excluded;
}

async function enumerateFolder(
  workspace: string,
  exclusions: readonly string[],
): Promise<string[]> {
  const result: string[] = [];
  const initial: IgnoreLayer[] = [
    { root: "", matcher: ignore().add([".git/", ".git", "node_modules/"]) },
  ];
  const custom = ignore().add(exclusions);
  async function walk(
    dir: string,
    prefix: string,
    inherited: readonly IgnoreLayer[],
  ): Promise<void> {
    const localRules = await readFile(join(dir, ".gitignore"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const layers = localRules
      ? [...inherited, { root: prefix, matcher: ignore().add(localRules) }]
      : inherited;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === ".git") continue;
      const rule = custom.test(entry.isDirectory() ? `${name}/` : name);
      if (
        rule.ignored ||
        (!rule.unignored && ignored(layers, name, entry.isDirectory()))
      )
        continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), name, layers);
      else if (entry.isFile() || entry.isSymbolicLink()) result.push(name);
    }
  }
  await walk(workspace, "", initial);
  return result.sort();
}

async function enumerateWorkspace(
  workspace: string,
  exclusions: readonly string[],
): Promise<string[]> {
  if ((await repositoryRoot(workspace)) === undefined)
    return enumerateFolder(workspace, exclusions);
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      workspace,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const custom = ignore().add(exclusions);
  const names = stdout.toString("utf8").split("\0").filter(Boolean);
  const paths = new Set<string>();
  for (const name of names) {
    if (name.split("/").includes(".git") || custom.ignores(name)) continue;
    const file = safePath(workspace, name);
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (stat?.isFile() || stat?.isSymbolicLink()) paths.add(name);
    else if (
      stat?.isDirectory() &&
      (await lstat(join(file, ".git")).then(
        () => true,
        () => false,
      ))
    ) {
      for (const child of await enumerateWorkspace(file, [])) {
        const nested = `${name}/${child}`;
        if (!custom.ignores(nested)) paths.add(nested);
      }
    }
  }
  return [...paths].sort();
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Host-owned, compressed content-addressed snapshots for one execution environment. */
export class TimeTravelStore {
  readonly #root: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(profileDirectory: string) {
    this.#root = join(profileDirectory, "time-travel", "v1");
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action, action);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #workspace(workspace: string): Promise<string> {
    return await realpath(workspace);
  }

  async #names(workspace: string, exclusions: readonly string[]): Promise<string[]> {
    const privateDirectory = dirname(this.#root);
    await mkdir(privateDirectory, { recursive: true });
    // Both paths must resolve aliases, including cross-drive Windows junctions and macOS /var.
    const privateState = relative(workspace, await realpath(privateDirectory)).split(sep).join("/");
    if (!privateState) return [];
    const rules = privateState !== ".." && !privateState.startsWith("../") && !isAbsolute(privateState)
      ? [...exclusions, `/${privateState}/`]
      : exclusions;
    return await enumerateWorkspace(workspace, rules);
  }

  #manifestDirectory(workspace: string, sessionId: string): string {
    return join(this.#root, "sessions", digest(workspace), digest(sessionId));
  }

  #metadataId(name: string): string {
    return name.slice(name.indexOf("_") + 1, -".json".length);
  }

  async #writeMetadata(directory: string, snapshot: TimeTravelSnapshot, manifestName: string): Promise<string> {
    const metadataDirectory = join(directory, ".metadata");
    await mkdir(metadataDirectory, { recursive: true });
    const name = `${new Date(snapshot.createdAt).toISOString().replaceAll(":", "-")}_${manifestName}`;
    const { entries, ...header } = snapshot;
    const metadata: TimeTravelSnapshotMetadata = { ...header, fileCount: entries.length };
    const temporary = join(metadataDirectory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      await rename(temporary, join(metadataDirectory, name));
    } finally {
      await rm(temporary, { force: true });
    }
    return name;
  }

  async #readManifest(directory: string, name: string): Promise<TimeTravelSnapshot> {
    return JSON.parse(await readFile(join(directory, name), "utf8")) as TimeTravelSnapshot;
  }

  async #readSnapshot(directory: string, snapshotId: string): Promise<TimeTravelSnapshot> {
    const files = await readdir(directory, { withFileTypes: true }).catch(missingDirectory);
    // The id comes from a command. Match a directory entry before using its
    // name as a path, preserving the former list-and-find containment boundary.
    const file = files.find(entry => entry.isFile() && entry.name === `${snapshotId}.json`);
    if (!file) throw new Error("Snapshot is not available");
    return this.#readManifest(directory, file.name);
  }

  async #metadataFiles(directory: string): Promise<string[]> {
    const manifests = (await readdir(directory, { withFileTypes: true }).catch(missingDirectory))
      .filter(file => file.isFile() && file.name.endsWith(".json"))
      .map(file => file.name);
    const manifestNames = new Set(manifests);
    const metadataDirectory = join(directory, ".metadata");
    const metadata = (await readdir(metadataDirectory).catch(missingDirectory))
      .filter(name => name.endsWith(".json") && manifestNames.has(`${this.#metadataId(name)}.json`));
    const indexed = new Set(metadata.map(name => `${this.#metadataId(name)}.json`));
    const missing = manifests.filter(name => !indexed.has(name));
    let next = 0;
    // Old v1 manifests remain readable. Backfill only missing summaries, with
    // bounded parsing rather than retaining every legacy entries array.
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      for (let index = next++; index < missing.length; index = next++) {
        const snapshot = await this.#readManifest(directory, missing[index]!);
        metadata.push(await this.#writeMetadata(directory, snapshot, missing[index]!));
      }
    }));
    return metadata.sort();
  }

  async #latestSnapshot(directory: string): Promise<TimeTravelSnapshot | undefined> {
    const latest = (await this.#metadataFiles(directory)).at(-1);
    return latest === undefined ? undefined : this.#readManifest(directory, `${this.#metadataId(latest)}.json`);
  }

  #blob(hash: string): string {
    return join(this.#root, "blobs", hash.slice(0, 2), `${hash}.gz`);
  }

  async #entry(
    workspace: string,
    name: string,
  ): Promise<TimeTravelEntry | undefined> {
    await assertNoLinkParents(workspace, name);
    const file = safePath(workspace, name);
    const before = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!before) return undefined;
    if (before.isSymbolicLink())
      return { path: name, kind: "symlink", target: await readlink(file) };
    if (!before.isFile())
      throw new Error(`Cannot capture a non-file path: ${name}`);
    // Hashing is cheap compared with recompressing unchanged files every turn.
    const existingHash = await hashFile(file);
    const hashed = await lstat(file);
    if (
      before.size !== hashed.size ||
      before.mtimeMs !== hashed.mtimeMs ||
      before.ctimeMs !== hashed.ctimeMs ||
      before.ino !== hashed.ino
    )
      throw new Error(`File changed during snapshot: ${name}`);
    if (
      await lstat(this.#blob(existingHash)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )
    ) {
      return {
        path: name,
        kind: "file",
        hash: existingHash,
        mode: before.mode & 0o777,
      };
    }
    const temporaryDir = join(this.#root, "tmp");
    await mkdir(temporaryDir, { recursive: true });
    const temporary = join(temporaryDir, randomUUID());
    const hash = createHash("sha256");
    try {
      await pipeline(
        createReadStream(file),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createGzip(),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      const after = await lstat(file);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== after.ino
      ) {
        throw new Error(`File changed during snapshot: ${name}`);
      }
      const value = hash.digest("hex");
      if (value !== existingHash)
        throw new Error(`File changed during snapshot: ${name}`);
      const blob = this.#blob(value);
      await mkdir(dirname(blob), { recursive: true });
      if (
        await lstat(blob).then(
          () => false,
          () => true,
        )
      )
        await rename(temporary, blob);
      return {
        path: name,
        kind: "file",
        hash: value,
        mode: before.mode & 0o777,
      };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #capture(input: {
    workspace: string;
    sessionId: string;
    leafId: string | null;
    phase: TimeTravelSnapshot["phase"];
    exclusions?: readonly string[];
    additionalPaths?: readonly string[];
  }): Promise<TimeTravelSnapshot> {
    const workspace = await this.#workspace(input.workspace);
    const names = new Set(
      await this.#names(workspace, input.exclusions ?? []),
    );
    for (const name of input.additionalPaths ?? []) {
      const stat = await lstat(safePath(workspace, name)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR")
            return undefined;
          throw error;
        },
      );
      if (stat?.isFile() || stat?.isSymbolicLink()) names.add(name);
    }
    const entries: TimeTravelEntry[] = [];
    for (const name of [...names].sort()) {
      const entry = await this.#entry(workspace, name);
      if (entry) entries.push(entry);
    }
    const directory = this.#manifestDirectory(workspace, input.sessionId);
    const previous = await this.#latestSnapshot(directory);
    const oldEntries = new Map(
      previous?.entries.map((entry) => [entry.path, entry]),
    );
    const changes = { added: 0, modified: 0, deleted: 0 };
    for (const entry of entries) {
      const old = oldEntries.get(entry.path);
      if (!old) changes.added++;
      else if (JSON.stringify(old) !== JSON.stringify(entry))
        changes.modified++;
      oldEntries.delete(entry.path);
    }
    changes.deleted = oldEntries.size;
    const snapshot: TimeTravelSnapshot = {
      id: randomUUID(),
      sessionId: input.sessionId,
      workspace: digest(workspace),
      leafId: input.leafId,
      phase: input.phase,
      createdAt: new Date().toISOString(),
      entries,
      changes,
    };
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${snapshot.id}.tmp`);
    await writeFile(temporary, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, join(directory, `${snapshot.id}.json`));
    await this.#writeMetadata(directory, snapshot, `${snapshot.id}.json`);
    return snapshot;
  }

  capture(input: {
    workspace: string;
    sessionId: string;
    leafId: string | null;
    phase: TimeTravelSnapshot["phase"];
    exclusions?: readonly string[];
  }): Promise<TimeTravelSnapshot> {
    return this.#serial(() => this.#capture(input));
  }

  async list(
    workspacePath: string,
    sessionId: string,
  ): Promise<TimeTravelSnapshotMetadata[]> {
    const workspace = await this.#workspace(workspacePath);
    const directory = this.#manifestDirectory(workspace, sessionId);
    const files = await this.#metadataFiles(directory);
    const snapshots = await Promise.all(
      files
        .map(
          async (name) =>
            JSON.parse(
              await readFile(join(directory, ".metadata", name), "utf8"),
            ) as TimeTravelSnapshotMetadata,
        ),
    );
    return snapshots;
  }

  async #preview(
    workspacePath: string,
    sessionId: string,
    snapshotId: string,
    exclusions: readonly string[],
  ): Promise<TimeTravelRestorePreview> {
    const workspace = await this.#workspace(workspacePath);
    const snapshot = await this.#readSnapshot(this.#manifestDirectory(workspace, sessionId), snapshotId);
    const target = new Map(
      snapshot.entries.map((entry) => [entry.path, entry]),
    );
    const currentNames = new Set(
      await this.#names(workspace, exclusions),
    );
    const paths = new Set([...currentNames, ...target.keys()]);
    const changes: TimeTravelChange[] = [];
    const state: unknown[] = [];
    const blockers = new Set<string>();
    for (const name of [...paths].sort()) {
      const blocked = name
        .split("/")
        .slice(0, -1)
        .some((_, i, parts) => blockers.has(parts.slice(0, i + 1).join("/")));
      if (!blocked) await assertNoLinkParents(workspace, name);
      const file = safePath(workspace, name);
      const stat = blocked
        ? undefined
        : await lstat(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR")
              return undefined;
            throw error;
          });
      const current = stat?.isFile()
        ? { kind: "file", hash: await hashFile(file), mode: stat.mode & 0o777 }
        : stat?.isSymbolicLink()
          ? { kind: "symlink", target: await readlink(file) }
          : stat?.isDirectory()
            ? { kind: "directory" }
            : undefined;
      if (stat && !current)
        throw new Error(`Cannot replace a special file: ${name}`);
      if (current && current.kind !== "directory") blockers.add(name);
      const wanted = target.get(name);
      if (current?.kind === "directory" && wanted) {
        // A file may replace a directory only when all its contents are in the reviewed change list.
        const checkContents = async (
          directory: string,
          prefix: string,
        ): Promise<void> => {
          for (const child of await readdir(directory, {
            withFileTypes: true,
          })) {
            const childName = `${prefix}/${child.name}`;
            if (child.isDirectory())
              await checkContents(join(directory, child.name), childName);
            else if (!currentNames.has(childName))
              throw new Error(
                `Directory contains excluded files; move them before restoring: ${childName}`,
              );
          }
        };
        await checkContents(file, name);
      }
      state.push([name, current]);
      if (!current && wanted) changes.push({ path: name, kind: "add" });
      else if (current && !wanted && current.kind !== "directory")
        changes.push({ path: name, kind: "delete" });
      else if (current && wanted) {
        const { path: _path, ...targetState } = wanted;
        if (JSON.stringify(current) !== JSON.stringify(targetState))
          changes.push({ path: name, kind: "modify" });
      }
    }
    return { snapshotId, revision: digest(JSON.stringify(state)), changes };
  }

  preview(
    workspace: string,
    sessionId: string,
    snapshotId: string,
    exclusions: readonly string[] = [],
  ): Promise<TimeTravelRestorePreview> {
    return this.#serial(() =>
      this.#preview(workspace, sessionId, snapshotId, exclusions),
    );
  }

  async #stage(
    snapshot: TimeTravelSnapshot,
    changes: readonly TimeTravelChange[],
    directory: string,
  ): Promise<Map<string, string>> {
    const wanted = new Set(changes.map((change) => change.path));
    const files = new Map<string, string>();
    await mkdir(directory, { recursive: true });
    for (const entry of snapshot.entries) {
      if (
        entry.kind !== "file" ||
        !wanted.has(entry.path) ||
        files.has(entry.hash)
      )
        continue;
      const path = join(directory, entry.hash);
      await pipeline(
        createReadStream(this.#blob(entry.hash)),
        createGunzip(),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      if ((await hashFile(path)) !== entry.hash)
        throw new Error(`Snapshot content is damaged: ${entry.path}`);
      files.set(entry.hash, path);
    }
    return files;
  }

  async #apply(
    workspace: string,
    snapshot: TimeTravelSnapshot,
    changes: readonly TimeTravelChange[],
    staged: Map<string, string>,
  ): Promise<void> {
    const target = new Map(
      snapshot.entries.map((entry) => [entry.path, entry]),
    );
    // Remove leaves first, so a file/directory replacement never requires recursive deletion.
    for (const change of [...changes].sort(
      (a, b) => b.path.split("/").length - a.path.split("/").length,
    )) {
      const path = safePath(workspace, change.path);
      try {
        await assertNoLinkParents(workspace, change.path);
      } catch {
        // A desired nested file can currently be hidden behind a managed file or link that this restore removes.
        const managedParent = changes.some(
          (parent) =>
            change.path.startsWith(`${parent.path}/`) &&
            !target.has(parent.path),
        );
        if (managedParent) continue;
        throw new Error(
          `Cannot restore through a symbolic link or file: ${change.path}`,
        );
      }
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
          return undefined;
        throw error;
      });
      if (stat && !stat.isDirectory()) await rm(path);
    }
    const removeEmpty = async (path: string): Promise<void> => {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (!child.isDirectory())
          throw new Error(
            "Directory changed during restore; files were not removed",
          );
        await removeEmpty(join(path, child.name));
      }
      await rmdir(path);
    };
    for (const change of changes) {
      const entry = target.get(change.path);
      if (!entry) continue;
      await assertNoLinkParents(workspace, change.path);
      const path = safePath(workspace, change.path);
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat?.isDirectory()) await removeEmpty(path);
      await mkdir(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.omp-time-travel-${randomUUID()}`);
      try {
        if (entry.kind === "file") {
          await copyFile(staged.get(entry.hash)!, temporary);
          await chmod(temporary, entry.mode);
        } else await symlink(entry.target, temporary);
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }

  restore(input: {
    workspace: string;
    sessionId: string;
    snapshotId: string;
    expectedRevision: string;
    leafId: string | null;
    exclusions?: readonly string[];
  }): Promise<{
    backup: TimeTravelSnapshot;
    restored: boolean;
    error?: string;
  }> {
    return this.#serial(async () => {
      const workspace = await this.#workspace(input.workspace);
      const exclusions = input.exclusions ?? [];
      const preview = await this.#preview(
        workspace,
        input.sessionId,
        input.snapshotId,
        exclusions,
      );
      if (preview.revision !== input.expectedRevision)
        throw new Error("Workspace changed; review the restore again");
      const backup = await this.#capture({
        workspace,
        sessionId: input.sessionId,
        leafId: input.leafId,
        phase: "restore-backup",
        exclusions,
        additionalPaths: preview.changes
          .filter((change) => change.kind !== "add")
          .map((change) => change.path),
      });
      const snapshot = await this.#readSnapshot(this.#manifestDirectory(workspace, input.sessionId), input.snapshotId);
      const temporary = safePath(this.#root, `tmp/${randomUUID()}`);
      try {
        const desired = await this.#stage(
          snapshot,
          preview.changes,
          join(temporary, "desired"),
        );
        const previous = await this.#stage(
          backup,
          preview.changes,
          join(temporary, "previous"),
        );
        if (
          (
            await this.#preview(
              workspace,
              input.sessionId,
              input.snapshotId,
              exclusions,
            )
          ).revision !== preview.revision
        )
          throw new Error("Workspace changed; review the restore again");
        try {
          await this.#apply(workspace, snapshot, preview.changes, desired);
          return { backup, restored: true };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          try {
            await this.#apply(workspace, backup, preview.changes, previous);
            return {
              backup,
              restored: false,
              error: `Restore failed; original files were restored. ${reason}`,
            };
          } catch {
            return {
              backup,
              restored: false,
              error: `Restore stopped partway through. Use the before-restore backup to recover affected files. ${reason}`,
            };
          }
        }
      } finally {
        // This generated directory is always underneath the private store, never a workspace path.
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
  storage(): Promise<{ snapshots: number; bytes: number }> {
    return this.#serial(async () => {
      let snapshots = 0;
      let bytes = 0;
      for await (const directory of this.#sessionDirectories()) {
        for (const file of await readdir(directory, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith(".json")) continue;
          snapshots++;
          bytes += (await lstat(join(directory, file.name))).size;
        }
        const metadataDirectory = join(directory, ".metadata");
        for (const file of await readdir(metadataDirectory, { withFileTypes: true }).catch(missingDirectory)) {
          if (file.isFile() && file.name.endsWith(".json")) bytes += (await lstat(join(metadataDirectory, file.name))).size;
        }
      }
      const blobs = join(this.#root, "blobs");
      for (const prefix of await readdir(blobs, { withFileTypes: true }).catch(
        missingDirectory,
      )) {
        if (!prefix.isDirectory()) continue;
        for (const file of await readdir(join(blobs, prefix.name), {
          withFileTypes: true,
        })) {
          if (file.isFile() && file.name.endsWith(".gz"))
            bytes += (await lstat(join(blobs, prefix.name, file.name))).size;
        }
      }
      return { snapshots, bytes };
    });
  }

  cleanup(olderThan: Date | null): Promise<{ removed: number }> {
    return this.#serial(async () => {
      const retained = new Set<string>();
      let removed = 0;
      for await (const directory of this.#sessionDirectories()) {
        const metadataDirectory = join(directory, ".metadata");
        if (olderThan === null) {
          for (const file of await readdir(directory, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith(".json")) continue;
            await rm(join(directory, file.name));
            removed++;
          }
          for (const file of await readdir(metadataDirectory, { withFileTypes: true }).catch(missingDirectory)) {
            if (file.isFile() && file.name.endsWith(".json")) await rm(join(metadataDirectory, file.name));
          }
          continue;
        }
        const retainedIds = new Set<string>();
        const cutoff = olderThan.toISOString().replaceAll(":", "-");
        for (const name of await this.#metadataFiles(directory)) {
          const id = this.#metadataId(name);
          // The canonical UTC prefix is enough to expire a checkpoint. Only
          // retained checkpoints need their full entries for blob collection.
          if (name.slice(0, name.indexOf("_")) < cutoff) {
            await rm(join(directory, `${id}.json`));
            removed++;
          } else {
            retainedIds.add(id);
            const snapshot = await this.#readManifest(directory, `${id}.json`);
            for (const entry of snapshot.entries)
              if (entry.kind === "file") retained.add(entry.hash);
          }
        }
        // Summaries are derived data. Remove both expired rows and any summary
        // whose manifest was removed before a previous cleanup could finish.
        for (const name of await readdir(metadataDirectory).catch(missingDirectory)) {
          if (name.endsWith(".json") && !retainedIds.has(this.#metadataId(name))) await rm(join(metadataDirectory, name));
        }
      }
      const blobs = join(this.#root, "blobs");
      for (const prefix of await readdir(blobs, { withFileTypes: true }).catch(
        missingDirectory,
      )) {
        if (!prefix.isDirectory()) continue;
        for (const file of await readdir(join(blobs, prefix.name), {
          withFileTypes: true,
        })) {
          if (
            file.isFile() &&
            file.name.endsWith(".gz") &&
            !retained.has(file.name.slice(0, -3))
          )
            await rm(join(blobs, prefix.name, file.name));
        }
      }
      return { removed };
    });
  }

  async *#sessionDirectories(): AsyncGenerator<string> {
    const root = join(this.#root, "sessions");
    for (const workspace of await readdir(root, { withFileTypes: true }).catch(
      missingDirectory,
    )) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = join(root, workspace.name);
      for (const session of await readdir(workspaceDir, {
        withFileTypes: true,
      })) {
        if (!session.isDirectory()) continue;
        yield join(workspaceDir, session.name);
      }
    }
  }
}
