// Cache only the local Windows production preview. Development preview keeps
// its normal build/HMR path, and Runtime verification remains independent.
import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CACHE_VERSION = 1;
const IGNORED_DEPENDENCY_DIRS = new Set([".cache", ".vite", ".tmp"]);
const SOURCE_PATHS = [
  "package.json", "package-lock.json", "tsconfig.base.json", ".npmrc",
  "apps/desktop", "apps/renderer", "packages",
  "omp-patch/upstream.json", "omp-patch/overlay", "omp-patch/patches",
  "omp-patch/vendor/oh-my-pi/packages/coding-agent/package.json",
  "omp-patch/vendor/oh-my-pi/packages/tui/src", "scripts",
];
const REQUIRED_OUTPUTS = [
  "apps/renderer/dist/index.html", "apps/desktop/dist/src/main.js",
  "apps/desktop/dist/preload.cjs", "apps/desktop/dist/remote-host/host.json",
  "apps/desktop/dist/web-host/host.mjs", "apps/renderer/dist/web.html",
  "apps/desktop/dist/ssh-askpass/omp-ssh-askpass.exe",
];

function displayPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function skipSourceDirectory(root, path) {
  const name = path.split(sep).at(-1);
  if (name === ".git" || name === "node_modules") return true;
  const local = displayPath(root, path);
  return /^apps\/(?:desktop|renderer)\/(?:dist|build|out|release|coverage|backup|tmp|outputs|__scratch__)$/u.test(local) ||
    /^packages\/[^/]+\/(?:dist|build|out|release|coverage|backup|tmp|outputs|__scratch__)$/u.test(local);
}

async function collect(root, path, options, files) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    files.push({ path, name: displayPath(root, path), link: await readlink(path) });
  } else if (info.isDirectory()) {
    if (options.skipDirectory?.(path)) return;
    const entries = await readdir(path, { withFileTypes: true });
    await Promise.all(entries.map(entry => collect(root, join(path, entry.name), options, files)));
  } else if (info.isFile() && !options.skipFile?.(path)) {
    files.push({ path, name: displayPath(root, path), info });
  }
}

async function fingerprint(root, paths, options = {}) {
  const files = [];
  await Promise.all(paths.map(path => collect(root, join(root, path), options, files)));
  files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const values = new Array(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      if (file.link !== undefined) values[index] = `link:${file.link}`;
      // Windows can change ctime when a native module is merely loaded. Its
      // size, modification time and creation time track ordinary installs and
      // replacements without invalidating the cache on every application run.
      else if (options.metadataOnly) values[index] = `${file.info.size}:${file.info.mtimeMs}:${file.info.birthtimeMs}`;
      else values[index] = createHash("sha256").update(await readFile(file.path)).digest("hex");
    }
  }));
  const hash = createHash("sha256");
  for (let index = 0; index < files.length; index++) hash.update(`${files[index].name}\0${values[index]}\n`);
  return hash.digest("hex");
}

async function dependencyGuard(root, paths) {
  const parts = [];
  for (const rel of ["package.json", "package-lock.json", "node_modules/.package-lock.json", ...paths]) {
    const info = await lstat(join(root, rel)).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    parts.push(info ? `${rel}:${info.size}:${info.mtimeMs}:${info.birthtimeMs}` : `${rel}:missing`);
  }
  return parts.join("\n");
}

/** Hash source bytes, including untracked files, and installed dependency metadata. */
export async function productionPreviewInputs(root, { env = process.env, platform = process.platform, arch = process.arch, nodeVersion = process.version, npmCli = "", dependencyCache = undefined } = {}) {
  const source = await fingerprint(root, SOURCE_PATHS, {
    skipDirectory: path => skipSourceDirectory(root, path),
  });
  const packages = await readdir(join(root, "packages"), { withFileTypes: true });
  const dependencyPaths = ["node_modules", "apps/desktop/node_modules", "apps/renderer/node_modules",
    ...packages.filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/node_modules`)];
  const guard = dependencyCache ? await dependencyGuard(root, dependencyPaths) : "";
  let dependencies = dependencyCache?.get(guard);
  if (dependencies === undefined) {
    dependencies = await fingerprint(root, dependencyPaths, {
      metadataOnly: true,
      skipDirectory: path => IGNORED_DEPENDENCY_DIRS.has(path.split(sep).at(-1)),
    });
    if (dependencyCache) {
      dependencyCache.clear();
      dependencyCache.set(guard, dependencies);
    }
  }
  const buildEnv = Object.fromEntries(Object.entries(env)
    .filter(([key]) => key.startsWith("VITE_") || ["NODE_ENV", "NODE_OPTIONS", "BABEL_ENV", "SOURCE_DATE_EPOCH", "OMP_TARGET_ARCH", "OMP_TARGET_PLATFORM"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  const npmPackage = npmCli ? await readFile(join(dirname(dirname(npmCli)), "package.json")).catch(error => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }) : Buffer.alloc(0);
  const npmVersion = createHash("sha256").update(npmPackage).digest("hex");
  return createHash("sha256").update(JSON.stringify({ source, dependencies, platform, arch, nodeVersion, npmCli, npmVersion, buildEnv })).digest("hex");
}

async function outputPaths(root) {
  const packages = await readdir(join(root, "packages"), { withFileTypes: true });
  return ["apps/renderer/dist", "apps/desktop/dist", ...packages.filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/dist`)];
}

function skipRuntimeArtifacts(root, path) {
  return path === join(root, "packages", "runtime-installer", "dist", "artifacts");
}

/** Hash the built workspace bytes, excluding Runtime artifacts and compiler caches. */
export async function productionPreviewOutputs(root, paths = undefined) {
  for (const path of REQUIRED_OUTPUTS) await lstat(join(root, path));
  return await fingerprint(root, paths ?? await outputPaths(root), {
    skipDirectory: path => skipRuntimeArtifacts(root, path),
    skipFile: path => path.endsWith(".tsbuildinfo"),
  });
}

export function productionPreviewRuntimeKey(runtime) {
  const keys = Object.entries(runtime.keys).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, key]) => [id, createHash("sha256").update(key).digest("hex")]);
  return createHash("sha256").update(JSON.stringify({
    version: runtime.manifest.runtimeVersion,
    checksum: runtime.checksums.files[runtime.manifest.entrypoint],
    keyId: runtime.keyId,
    keys,
  })).digest("hex");
}

export async function productionPreviewStageKey(root, runtime) {
  const inputs = await fingerprint(root, [
    "node_modules/electron/dist", "node_modules/electron-winstaller/vendor/rcedit.exe",
    "apps/desktop/resources/icon.ico", "scripts/preview.mjs", "scripts/production-preview-runtime.mjs",
  ], { metadataOnly: true, skipDirectory: path => path === join(root, "node_modules", "electron", "dist", "runtime") });
  return createHash("sha256").update(`${inputs}\n${productionPreviewRuntimeKey(runtime)}`).digest("hex");
}

async function electronFingerprint(root, directory) {
  await lstat(join(root, directory, "OMP Studio.exe"));
  return await fingerprint(root, [directory], { metadataOnly: true });
}

function isPreviewElectronDirectory(directory) {
  return typeof directory === "string" && /^outputs[\\/]production-preview[\\/]electrons[\\/]electron-[A-Za-z0-9]+$/u.test(directory);
}

function isPreviewSnapshotDirectory(directory) {
  return typeof directory === "string" && /^outputs[\\/]production-preview[\\/]build-snapshots[\\/]build-[A-Za-z0-9]+$/u.test(directory);
}

/** Reuse the staged Electron copy when its Runtime, keys and files still match. */
export async function reusableProductionPreviewElectron(root, record, runtime) {
  if (!isPreviewElectronDirectory(record?.electronDirectory) || record.stageKey !== await productionPreviewStageKey(root, runtime)) return undefined;
  try {
    return await electronFingerprint(root, record.electronDirectory) === record.electronOutputs
      ? join(root, record.electronDirectory, "OMP Studio.exe") : undefined;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function cacheFile(root) {
  return join(root, "outputs", "production-preview", "build-cache.json");
}

export async function inspectProductionPreviewCache(root, options = {}) {
  const inputs = await productionPreviewInputs(root, options);
  let record;
  try {
    record = JSON.parse(await readFile(cacheFile(root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { inputs, hit: false };
    throw error;
  }
  if (!record || typeof record !== "object" || record.version !== CACHE_VERSION || record.inputs !== inputs ||
      !isPreviewElectronDirectory(record.electronDirectory) || !isPreviewSnapshotDirectory(record.snapshot)) return { inputs, hit: false, record };
  try {
    const outputs = await productionPreviewOutputs(root);
    const snapshot = await productionPreviewOutputs(join(root, record.snapshot));
    const electron = await electronFingerprint(root, record.electronDirectory);
    return { inputs, hit: outputs === record.outputs && snapshot === record.outputs && electron === record.electronOutputs, record };
  } catch (error) {
    if (error.code === "ENOENT") return { inputs, hit: false, record };
    throw error;
  }
}

/** Publish a cache record only after the build finished against unchanged inputs. */
export async function saveProductionPreviewCache(root, initialInputs, runtime, electronDirectory, options = {}) {
  if (!isPreviewElectronDirectory(electronDirectory)) throw new Error("Production preview Electron directory is outside its cache.");
  const saveOptions = options.dependencyCache ? options : { ...options, dependencyCache: new Map() };
  const inputs = await productionPreviewInputs(root, saveOptions);
  if (inputs !== initialInputs) throw new Error("Production preview sources or dependencies changed during the build. Start it again to rebuild the current version.");
  const paths = await outputPaths(root);
  const outputs = await productionPreviewOutputs(root, paths);
  const electronOutputs = await electronFingerprint(root, electronDirectory);
  const stageKey = await productionPreviewStageKey(root, runtime);
  // A failed later build may partially overwrite dist/. Keep this complete
  // successful build separately; never touch Runtime artifacts inside dist/.
  const snapshots = join(root, "outputs", "production-preview", "build-snapshots");
  await mkdir(snapshots, { recursive: true });
  const snapshot = await mkdtemp(join(snapshots, "build-"));
  const path = cacheFile(root);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let previous;
  try {
    for (const item of paths) {
      try {
        await cp(join(root, item), join(snapshot, item), {
          recursive: true,
          filter: source => !skipRuntimeArtifacts(root, source),
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (await productionPreviewOutputs(snapshot, paths) !== outputs ||
        await productionPreviewOutputs(root, paths) !== outputs ||
        await productionPreviewInputs(root, saveOptions) !== initialInputs ||
        await electronFingerprint(root, electronDirectory) !== electronOutputs ||
        await productionPreviewStageKey(root, runtime) !== stageKey) {
      throw new Error("Production preview files changed while saving the build. Start it again to rebuild the current version.");
    }
    const record = { version: CACHE_VERSION, inputs, outputs, electronDirectory, electronOutputs, stageKey,
      runtimeKey: productionPreviewRuntimeKey(runtime), snapshot: displayPath(root, snapshot) };
    await mkdir(dirname(path), { recursive: true });
    try { previous = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    await rm(snapshot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // Keep the just-published snapshot/Electron copy and discard superseded ones
  // only after the new cache record is durable. A failed build never removes them.
  const workspace = await realpath(root).catch(() => undefined);
  const pruneOld = async (containerPath, relativeTarget, pattern) => {
    if (!workspace || typeof relativeTarget !== "string") return;
    const target = resolve(root, relativeTarget);
    const base = await realpath(containerPath).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!base) return;
    const baseInside = relative(workspace, base);
    const resolvedTarget = await realpath(target).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    const inside = resolvedTarget === undefined ? "" : relative(base, resolvedTarget);
    if (baseInside && !baseInside.startsWith(`..${sep}`) && baseInside !== ".." && !isAbsolute(baseInside) &&
        inside && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside) && pattern.test(inside)) {
      const info = await lstat(target).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (info?.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true, force: true }).catch(() => {});
    }
  };
  if (previous?.snapshot !== displayPath(root, snapshot)) {
    await pruneOld(snapshots, previous?.snapshot, /^build-[A-Za-z0-9]+$/u);
  }
  if (previous?.electronDirectory && previous.electronDirectory !== electronDirectory && isPreviewElectronDirectory(previous.electronDirectory)) {
    await pruneOld(join(root, "outputs", "production-preview", "electrons"), previous.electronDirectory, /^electron-[A-Za-z0-9]+$/u);
  }
}
